import Foundation
import Darwin
import SideCaptureKit

enum RestartDecision: Equatable {
    case restart(after: TimeInterval)
    case captureNotRunning
}

struct RestartPolicy {
    private var recentExits: [Date] = []
    private var attempt = 0
    private var stopped = false

    mutating func recordAbnormalExit(at date: Date) -> RestartDecision {
        guard !stopped else { return .captureNotRunning }
        recentExits.removeAll { $0 <= date.addingTimeInterval(-60) }
        recentExits.append(date)
        if recentExits.count > 5 {
            stopped = true
            return .captureNotRunning
        }
        attempt += 1
        return .restart(after: min(TimeInterval(1 << min(attempt - 1, 6)), 60))
    }
}

enum SupervisorState: Equatable {
    case stopped
    case starting
    case running
    case waitingToRestart(TimeInterval)
    case keychainLocked
    case captureNotRunning

    var menuBarMessage: String? {
        if self == .captureNotRunning || self == .keychainLocked {
            return "Capture is not running"
        }
        return nil
    }
}

enum SupervisorTransportError: Error, Equatable {
    case invalidFrame
    case notRunning
}

@MainActor
final class DaemonSupervisor {
    private let daemonURL: URL
    private let appVersion: String
    private let keyStore: SideKeyStore
    private var process: Process?
    private var input: Pipe?
    private var output: Pipe?
    private var frame = Data()
    private var policy = RestartPolicy()
    private var restartTask: Task<Void, Never>?

    private(set) var state: SupervisorState = .stopped {
        didSet { onStateChange?(state) }
    }
    private(set) var webSession: SettingsWebSession?
    var daemonPID: Int32? { process?.processIdentifier }
    var onStateChange: ((SupervisorState) -> Void)?
    var onWebSessionChange: ((SettingsWebSession?) -> Void)?
    var onOtherCommand: (@MainActor (Data) async -> Data?)?
    var writeData: (FileHandle, Data) throws -> Void = { handle, data in
        try handle.write(contentsOf: data)
    }

    init(
        daemonURL: URL = Bundle.main.resourceURL!.appendingPathComponent("side"),
        appVersion: String = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.0",
        keyStore: SideKeyStore = SideKeychain()
    ) {
        self.daemonURL = daemonURL
        self.appVersion = appVersion
        self.keyStore = keyStore
    }

    func start() {
        guard process == nil else { return }
        restartTask?.cancel()
        restartTask = nil
        policy = RestartPolicy()
        launch()
    }

    func stop() {
        restartTask?.cancel()
        restartTask = nil
        let child = process
        child?.terminationHandler = nil
        output?.fileHandleForReading.readabilityHandler = nil
        process = nil
        input = nil
        output = nil
        frame.removeAll()
        clearWebSession()
        if child?.isRunning == true { child?.terminate() }
        state = .stopped
    }

    func stopForQuit() async {
        let child = process
        stop()
        guard let child else { return }
        let deadline = Date().addingTimeInterval(5)
        while child.isRunning && Date() < deadline {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        if child.isRunning { _ = kill(child.processIdentifier, SIGKILL) }
        await Task.detached { child.waitUntilExit() }.value
    }

    func makeProcess() -> Process {
        let child = Process()
        child.executableURL = daemonURL
        child.arguments = ["daemon"]
        let inherited = ProcessInfo.processInfo.environment
        var environment = [
            "HOME": inherited["HOME"] ?? NSHomeDirectory(),
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "LANG": inherited["LANG"] ?? "en_US.UTF-8",
        ]
        for name in ["USER", "LOGNAME"] {
            environment[name] = inherited[name].flatMap { $0.isEmpty ? nil : $0 } ?? NSUserName()
        }
        if let dataDirectory = inherited["SIDE_DATA_DIR"] {
            environment["SIDE_DATA_DIR"] = dataDirectory
        }
        child.environment = environment
        child.standardError = FileHandle.nullDevice
        return child
    }

    func sendEvent<Payload: Encodable>(_ event: Payload) throws {
        try sendFrame(CaptureProtocol.encodeEvent(event))
    }

    func sendHealth(_ health: HelperHealth) throws {
        try sendFrame(CaptureProtocol.encodeHealth(health))
    }

    func sendFrame(_ line: Data) throws {
        guard Self.isAppFrame(line) else { throw SupervisorTransportError.invalidFrame }
        guard let child = process else { throw SupervisorTransportError.notRunning }
        try write(line, to: child)
    }

    func replyForCommand(_ line: Data) -> Data? {
        guard let message = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else {
            return try? CaptureProtocol.encodeProtocolError("invalid command")
        }
        if message["type"] as? String == "protocol-error" { return nil }
        guard message["type"] as? String == "command",
              let id = message["id"] as? String,
              let name = message["name"] as? String else {
            return try? CaptureProtocol.encodeProtocolError("invalid command")
        }
        if name == "web.session" {
            guard let args = message["args"] as? [String: Any],
                  Set(args.keys) == ["port", "token"],
                  let port = args["port"] as? Int,
                  let token = args["token"] as? String,
                  token.count == 64,
                  token.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
                  let session = SettingsWebSession(port: port, token: token) else {
                return try? CaptureProtocol.encodeResultFailure(id: id, error: "invalid-arguments")
            }
            webSession = session
            onWebSessionChange?(session)
            return try? CaptureProtocol.encodeResultSuccess(id: id, data: Optional<String>.none)
        }
        if name == "keychain.rotate" {
            guard Set(message.keys) == ["type", "id", "name"] else {
                return try? CaptureProtocol.encodeResultFailure(id: id, error: "invalid-arguments")
            }
            do {
                let replacement = try keyStore.rotateMasterKey()
                guard replacement.count == 32 else { throw SideKeychainError.invalidMasterKey }
                return try CaptureProtocol.encodeResultSuccess(
                    id: id, data: ["key": replacement.base64EncodedString()]
                )
            } catch {
                return try? CaptureProtocol.encodeResultFailure(id: id, error: "keychain-unavailable")
            }
        }
        guard name == "keychain.set" || name == "keychain.get" else { return nil }
        guard let args = message["args"] as? [String: Any],
              let ref = args["ref"] as? String, !ref.isEmpty else {
            return try? CaptureProtocol.encodeResultFailure(id: id, error: "invalid-arguments")
        }
        do {
            if name == "keychain.set" {
                guard let secret = args["secret"] as? String, !secret.isEmpty else {
                    return try CaptureProtocol.encodeResultFailure(id: id, error: "invalid-arguments")
                }
                try keyStore.setProviderKey(ref: ref, secret: secret)
                return try CaptureProtocol.encodeResultSuccess(id: id, data: ["ref": ref])
            }
            let secret = try keyStore.providerKey(ref: ref)
            return try CaptureProtocol.encodeResultSuccess(id: id, data: secret)
        } catch {
            return try? CaptureProtocol.encodeResultFailure(id: id, error: "keychain-unavailable")
        }
    }

    private func launch() {
        clearWebSession()
        state = .starting
        let hello: Data
        do {
            hello = try CaptureProtocol.encodeHello(key: keyStore.masterKey(), appVersion: appVersion)
        } catch {
            state = .keychainLocked
            return
        }

        let child = makeProcess()
        let stdin = Pipe()
        let stdout = Pipe()
        child.standardInput = stdin
        child.standardOutput = stdout
        child.terminationHandler = { [weak self] terminated in
            Task { @MainActor in self?.didExit(terminated) }
        }
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let bytes = handle.availableData
            Task { @MainActor in self?.receive(bytes, from: child) }
        }
        do {
            try child.run()
            process = child
            input = stdin
            output = stdout
            try stdin.fileHandleForWriting.write(contentsOf: hello)
            state = .running
        } catch {
            stdout.fileHandleForReading.readabilityHandler = nil
            if child.isRunning { child.terminate() }
            process = nil
            input = nil
            output = nil
            scheduleRestart()
        }
    }

    private func receive(_ bytes: Data, from child: Process) {
        guard process === child, !bytes.isEmpty else { return }
        for byte in bytes {
            if byte == 0x0A {
                let command = frame
                frame.removeAll(keepingCapacity: true)
                Task { [weak self] in await self?.handleCommand(command, from: child) }
            } else {
                guard frame.count < CaptureProtocol.maxRawBytes - 1 else {
                    child.terminate()
                    return
                }
                frame.append(byte)
            }
        }
    }

    private func handleCommand(_ line: Data, from child: Process) async {
        guard process === child else { return }
        if let message = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
           message["type"] as? String == "protocol-error" {
            child.terminate()
            return
        }
        if let reply = replyForCommand(line) {
            try? write(reply, to: child)
            return
        }
        guard let command = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
              command["type"] as? String == "command",
              let id = command["id"] as? String else { return }
        let routedReply = await onOtherCommand?(line)
        guard process === child else { return }
        let reply: Data?
        if let routedReply, Self.isCorrelatedResult(routedReply, id: id) {
            reply = routedReply
        } else {
            reply = try? CaptureProtocol.encodeResultFailure(
                id: id, error: routedReply == nil ? "unavailable" : "invalid-result"
            )
        }
        if let reply { try? write(reply, to: child) }
    }

    private func write(_ line: Data, to child: Process) throws {
        guard process === child, child.isRunning, let input else {
            throw SupervisorTransportError.notRunning
        }
        do {
            try writeData(input.fileHandleForWriting, line)
        } catch {
            if process === child, child.isRunning { child.terminate() }
            throw error
        }
    }

    private static func isAppFrame(_ line: Data) -> Bool {
        guard isSingleLine(line),
              let message = try? JSONSerialization.jsonObject(with: line.dropLast()) as? [String: Any],
              let type = message["type"] as? String else { return false }
        switch type {
        case "event":
            return Set(message.keys) == ["type", "event"] && message["event"] is [String: Any]
        case "health":
            return Set(message.keys) == ["type", "health"] && message["health"] is [String: Any]
        default:
            return false
        }
    }

    private static func isCorrelatedResult(_ line: Data, id: String) -> Bool {
        guard isSingleLine(line),
              let message = try? JSONSerialization.jsonObject(with: line.dropLast()) as? [String: Any],
              message["type"] as? String == "result", message["id"] as? String == id,
              let ok = message["ok"] as? Bool else { return false }
        if ok { return Set(message.keys) == ["type", "id", "ok", "data"] }
        return Set(message.keys) == ["type", "id", "ok", "error"] && message["error"] is String
    }

    private static func isSingleLine(_ line: Data) -> Bool {
        guard line.count <= CaptureProtocol.maxRawBytes, line.last == 0x0A else { return false }
        let body = line.dropLast()
        return !body.contains(0x0A) && !body.contains(0x0D) && String(data: body, encoding: .utf8) != nil
    }

    private func didExit(_ child: Process) {
        guard process === child else { return }
        output?.fileHandleForReading.readabilityHandler = nil
        process = nil
        input = nil
        output = nil
        frame.removeAll()
        clearWebSession()
        if child.terminationReason == .exit && child.terminationStatus == 0 {
            state = .stopped
            return
        }
        scheduleRestart()
    }

    private func scheduleRestart() {
        switch policy.recordAbnormalExit(at: Date()) {
        case .captureNotRunning:
            state = .captureNotRunning
        case .restart(let delay):
            state = .waitingToRestart(delay)
            restartTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                guard !Task.isCancelled else { return }
                self?.restartTask = nil
                self?.launch()
            }
        }
    }

    private func clearWebSession() {
        guard webSession != nil else { return }
        webSession = nil
        onWebSessionChange?(nil)
    }
}
