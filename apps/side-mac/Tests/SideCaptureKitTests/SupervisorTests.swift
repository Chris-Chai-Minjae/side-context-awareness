import Foundation
import Darwin
import SideCaptureKit
import XCTest
@testable import Side

final class SupervisorTests: XCTestCase {
    func testFirstFiveCrashesRestartAndSixthStopsWithinMinute() {
        // Given six synthetic abnormal exits inside one minute.
        var policy = RestartPolicy()
        let firstExit = Date(timeIntervalSince1970: 1_000)

        // When each exit is recorded.
        let decisions = (0..<6).map { offset in
            policy.recordAbnormalExit(at: firstExit.addingTimeInterval(TimeInterval(offset)))
        }

        // Then five retries use exponential delays and the sixth stops capture.
        XCTAssertEqual(decisions, [
            .restart(after: 1), .restart(after: 2), .restart(after: 4),
            .restart(after: 8), .restart(after: 16), .captureNotRunning,
        ])
    }

    func testBackoffCapsAtSixtySecondsWhenCrashesAreOutsideOneMinuteWindow() {
        // Given exits separated by more than a minute.
        var policy = RestartPolicy()
        let firstExit = Date(timeIntervalSince1970: 1_000)

        // When eight exits are recorded.
        let decisions = (0..<8).map { offset in
            policy.recordAbnormalExit(at: firstExit.addingTimeInterval(TimeInterval(offset * 61)))
        }

        // Then backoff caps at sixty seconds without tripping the rate limit.
        XCTAssertEqual(decisions, [
            .restart(after: 1), .restart(after: 2), .restart(after: 4),
            .restart(after: 8), .restart(after: 16), .restart(after: 32),
            .restart(after: 60), .restart(after: 60),
        ])
    }

    @MainActor
    func testProviderCommandsUseKeyStoreAndReturnCorrelatedResults() throws {
        // Given an in-memory Keychain substitute and synthetic provider key.
        let store = FakeKeyStore()
        let supervisor = DaemonSupervisor(
            daemonURL: URL(fileURLWithPath: "/unused/side"),
            appVersion: "test",
            keyStore: store
        )
        let set = #"{"type":"command","id":"set-1","name":"keychain.set","args":{"ref":"provider-1","secret":"synthetic-only"}}"#.data(using: .utf8)!
        let get = #"{"type":"command","id":"get-1","name":"keychain.get","args":{"ref":"provider-1"}}"#.data(using: .utf8)!

        // When the app handles set and get commands.
        let setLine = try XCTUnwrap(supervisor.replyForCommand(set))
        let getLine = try XCTUnwrap(supervisor.replyForCommand(get))
        let setReply = try object(from: setLine)
        let getReply = try object(from: getLine)

        // Then each response matches its command and set never echoes the secret.
        XCTAssertEqual(setReply["id"] as? String, "set-1")
        XCTAssertEqual(setReply["data"] as? [String: String], ["ref": "provider-1"])
        XCTAssertFalse(String(decoding: setLine, as: UTF8.self).contains("synthetic-only"))
        XCTAssertEqual(getReply["id"] as? String, "get-1")
        XCTAssertEqual(getReply["data"] as? String, "synthetic-only")
    }

    @MainActor
    func testWebSessionCommandCachesMemoryOnlyAndClearsOnStop() throws {
        let supervisor = DaemonSupervisor(daemonURL: URL(fileURLWithPath: "/unused/side"), keyStore: FakeKeyStore())
        var delivered: SettingsWebSession?
        supervisor.onWebSessionChange = { delivered = $0 }
        let token = String(repeating: "a", count: 64)
        let command = Data(#"{"type":"command","id":"web-1","name":"web.session","args":{"port":49152,"token":"\#(token)"}}"#.utf8)

        let reply = try object(from: XCTUnwrap(supervisor.replyForCommand(command)))
        XCTAssertEqual(reply["id"] as? String, "web-1")
        XCTAssertEqual(reply["ok"] as? Bool, true)
        XCTAssertTrue(reply["data"] is NSNull)
        XCTAssertEqual(supervisor.webSession?.token, token)
        XCTAssertEqual(delivered?.port, 49152)
        supervisor.stop()
        XCTAssertNil(supervisor.webSession)
        XCTAssertNil(delivered)
    }

    @MainActor
    func testSpawnedDaemonWebSessionIsAcknowledgedAndRevokedOnCrash() async throws {
        let token = String(repeating: "b", count: 64)
        let (directory, daemon) = try makeDaemonScript { directory in
            let reply = directory.appendingPathComponent("reply").path
            return "IFS= read -r hello\nprintf '%s\\n' '{\"type\":\"command\",\"id\":\"web-1\",\"name\":\"web.session\",\"args\":{\"port\":49152,\"token\":\"\(token)\"}}'\nIFS= read -r frame\nprintf '%s\\n' \"$frame\" > '\(reply).tmp'\nmv '\(reply).tmp' '\(reply)'\nexit 9\n"
        }
        defer { try? FileManager.default.removeItem(at: directory) }
        let supervisor = DaemonSupervisor(daemonURL: daemon, appVersion: "test", keyStore: FakeKeyStore())
        let delivered = expectation(description: "web session delivered")
        let revoked = expectation(description: "web session revoked")
        supervisor.onWebSessionChange = { session in
            if session != nil { delivered.fulfill() } else { revoked.fulfill() }
        }

        supervisor.start()
        defer { supervisor.stop() }
        await fulfillment(of: [delivered, revoked], timeout: 2)
        let reply = try object(from: await waitForFile(directory.appendingPathComponent("reply")))
        XCTAssertEqual(reply["id"] as? String, "web-1")
        XCTAssertEqual(reply["ok"] as? Bool, true)
        XCTAssertTrue(reply["data"] is NSNull)
        XCTAssertNil(supervisor.webSession)
    }

    @MainActor
    func testInvalidWebSessionDoesNotReplaceCachedSession() throws {
        let supervisor = DaemonSupervisor(daemonURL: URL(fileURLWithPath: "/unused/side"), keyStore: FakeKeyStore())
        let valid = Data("{\"type\":\"command\",\"id\":\"web-1\",\"name\":\"web.session\",\"args\":{\"port\":49152,\"token\":\"\(String(repeating: "a", count: 64))\"}}".utf8)
        let invalid = Data(#"{"type":"command","id":"web-2","name":"web.session","args":{"port":0,"token":"synthetic"}}"#.utf8)
        _ = supervisor.replyForCommand(valid)

        let reply = try object(from: XCTUnwrap(supervisor.replyForCommand(invalid)))
        XCTAssertEqual(reply["ok"] as? Bool, false)
        XCTAssertEqual(reply["error"] as? String, "invalid-arguments")
        XCTAssertEqual(supervisor.webSession?.port, 49152)
    }

    @MainActor
    func testRotateCommandUsesSyntheticStoreOnlyAfterStrictNoArgsValidation() throws {
        // Given a synthetic key store and an unlaunched supervisor.
        let store = FakeKeyStore()
        let supervisor = DaemonSupervisor(daemonURL: URL(fileURLWithPath: "/unused/side"), keyStore: store)

        // When a valid rotate command and two commands with arguments arrive.
        let valid = try object(from: XCTUnwrap(supervisor.replyForCommand(Data(#"{"type":"command","id":"r1","name":"keychain.rotate"}"#.utf8))))
        let invalid = try object(from: XCTUnwrap(supervisor.replyForCommand(Data(#"{"type":"command","id":"r2","name":"keychain.rotate","args":{}}"#.utf8))))
        let invalidKey = try object(from: XCTUnwrap(supervisor.replyForCommand(Data(#"{"type":"command","id":"r3","name":"keychain.rotate","key":"secret"}"#.utf8))))

        // Then only the valid command rotates and returns exactly one replacement key.
        XCTAssertEqual(valid["id"] as? String, "r1")
        XCTAssertEqual(valid["ok"] as? Bool, true)
        XCTAssertEqual((valid["data"] as? [String: String])?["key"], Data(repeating: 0x43, count: 32).base64EncodedString())
        XCTAssertEqual(invalid["error"] as? String, "invalid-arguments")
        XCTAssertEqual(invalidKey["error"] as? String, "invalid-arguments")
        XCTAssertEqual(store.rotations, 1)
    }

    @MainActor
    func testRotateCommandReturnsFailureWithoutKeyWhenSyntheticStoreFails() throws {
        // Given a synthetic Keychain write failure.
        let store = FakeKeyStore()
        store.failRotation = true
        let supervisor = DaemonSupervisor(daemonURL: URL(fileURLWithPath: "/unused/side"), keyStore: store)

        // When the daemon requests a new master key.
        let line = try XCTUnwrap(supervisor.replyForCommand(Data(#"{"type":"command","id":"r","name":"keychain.rotate"}"#.utf8)))
        let reply = try object(from: line)

        // Then the correlated failure contains no key material.
        XCTAssertEqual(reply["id"] as? String, "r")
        XCTAssertEqual(reply["ok"] as? Bool, false)
        XCTAssertEqual(reply["error"] as? String, "keychain-unavailable")
        XCTAssertNil(reply["data"])
        XCTAssertFalse(String(decoding: line, as: UTF8.self).contains(Data(repeating: 0x43, count: 32).base64EncodedString()))
    }

    @MainActor
    func testDaemonLaunchKeepsKeyOutOfArgumentsAndEnvironment() {
        // Given a supervisor whose key exists only in memory.
        let supervisor = DaemonSupervisor(
            daemonURL: URL(fileURLWithPath: "/unused/side"),
            appVersion: "test",
            keyStore: FakeKeyStore()
        )

        // When its daemon process is configured.
        let process = supervisor.makeProcess()

        // Then argv contains only the daemon subcommand and env has an allowlist.
        XCTAssertEqual(process.arguments, ["daemon"])
        let keys = Set(process.environment?.keys.map { $0 } ?? [])
        XCTAssertTrue(keys.isSubset(of: ["HOME", "PATH", "LANG", "SIDE_DATA_DIR", "USER", "LOGNAME"]))
        XCTAssertTrue(keys.isSuperset(of: ["HOME", "PATH", "LANG", "USER", "LOGNAME"]))
        XCTAssertEqual(process.environment?["PATH"], "/usr/bin:/bin:/usr/sbin:/sbin")
        let inherited = ProcessInfo.processInfo.environment
        for name in ["USER", "LOGNAME"] {
            let expected = inherited[name].flatMap { $0.isEmpty ? nil : $0 } ?? NSUserName()
            XCTAssertEqual(process.environment?[name], expected)
        }
        XCTAssertNil(process.environment?["ANTHROPIC_API_KEY"])
        XCTAssertNil(process.environment?["ANTHROPIC_AUTH_TOKEN"])
        XCTAssertFalse((process.arguments ?? []).joined().contains("synthetic-only"))
    }

    @MainActor
    func testSpawnedDaemonReceivesAccountIdentity() async throws {
        // Given a synthetic daemon that records only its account identity.
        let (directory, daemon) = try makeDaemonScript { directory in
            let identity = directory.appendingPathComponent("identity").path
            return "printf '%s\\n%s\\n' \"$USER\" \"$LOGNAME\" > '\(identity)'\nIFS= read -r hello\nIFS= read -r ignored\n"
        }
        defer { try? FileManager.default.removeItem(at: directory) }
        let supervisor = DaemonSupervisor(daemonURL: daemon, appVersion: "test", keyStore: FakeKeyStore())
        let expected = supervisor.makeProcess().environment

        // When the supervisor launches its child.
        supervisor.start()
        defer { supervisor.stop() }
        let output = String(decoding: try await waitForFile(directory.appendingPathComponent("identity")), as: UTF8.self)

        // Then both account variables reach the child unchanged.
        XCTAssertEqual(output, "\(expected?["USER"] ?? "")\n\(expected?["LOGNAME"] ?? "")\n")
    }

    func testMasterKeyRetainsExistingServiceName() {
        // Given the legacy service identifier used by native/key.swift.
        // When the new Keychain wrapper's service is inspected.
        // Then the existing item remains discoverable after migration.
        XCTAssertEqual(SideKeychain.masterService, "local-context-awareness-ledger")
    }

    @MainActor
    func testKeychainFailureShowsCaptureStoppedAndDoesNotSpawnDaemon() {
        // Given a Keychain read failure before daemon launch.
        let store = FakeKeyStore()
        store.failMasterKey = true
        let supervisor = DaemonSupervisor(
            daemonURL: URL(fileURLWithPath: "/unused/side"), keyStore: store
        )

        // When the app starts its supervisor.
        supervisor.start()

        // Then the stopped state is visible and no child receives a key.
        XCTAssertEqual(supervisor.state, .keychainLocked)
        XCTAssertEqual(supervisor.state.menuBarMessage, "Capture is not running")
        XCTAssertNil(supervisor.daemonPID)
    }

    @MainActor
    func testDaemonProtocolErrorIsNotEchoed() {
        // Given a protocol-error sent by the daemon after repeated timeouts.
        let supervisor = DaemonSupervisor(
            daemonURL: URL(fileURLWithPath: "/unused/side"),
            appVersion: "test",
            keyStore: FakeKeyStore()
        )
        let message = Data(#"{"type":"protocol-error","message":"timeout"}"#.utf8)

        // When the supervisor classifies the incoming frame.
        let reply = supervisor.replyForCommand(message)

        // Then it does not bounce an error frame back to the daemon.
        XCTAssertNil(reply)
    }

    @MainActor
    func testDaemonProtocolErrorRestartsTheChild() async throws {
        let (directory, daemon) = try makeDaemonScript { _ in
            "IFS= read -r hello\nprintf '%s\\n' '{\"type\":\"protocol-error\",\"message\":\"timeout\"}'\nIFS= read -r ignored\n"
        }
        defer { try? FileManager.default.removeItem(at: directory) }
        let supervisor = DaemonSupervisor(daemonURL: daemon, appVersion: "test", keyStore: FakeKeyStore())
        let restarted = expectation(description: "protocol error restarts child")
        supervisor.onStateChange = { state in
            if case .waitingToRestart = state { restarted.fulfill() }
        }

        supervisor.start()
        defer { supervisor.stop() }
        await fulfillment(of: [restarted], timeout: 2)
    }

    @MainActor
    func testIncomingLineAtBodyLimitTerminatesChild() async throws {
        let (directory, daemon) = try makeDaemonScript { _ in
            "IFS= read -r hello\ndd if=/dev/zero bs=4194304 count=1 2>/dev/null | tr '\\000' 'a'\nprintf '\\n'\nIFS= read -r ignored\n"
        }
        defer { try? FileManager.default.removeItem(at: directory) }
        let supervisor = DaemonSupervisor(daemonURL: daemon, appVersion: "test", keyStore: FakeKeyStore())
        let restarted = expectation(description: "oversized daemon line terminates child")
        supervisor.onStateChange = { state in
            if case .waitingToRestart = state { restarted.fulfill() }
        }

        supervisor.start()
        defer { supervisor.stop() }
        await fulfillment(of: [restarted], timeout: 5)
    }

    @MainActor
    func testDefaultDaemonPathUsesApprovedBundleResourceName() {
        // Given the current Side application bundle.
        let supervisor = DaemonSupervisor(keyStore: FakeKeyStore())

        // When its child process is configured.
        let executable = supervisor.makeProcess().executableURL

        // Then it targets the approved Contents/Resources/side location.
        XCTAssertEqual(executable, Bundle.main.resourceURL?.appendingPathComponent("side"))
    }

    @MainActor
    func testSpawnedDaemonDoesNotExposeSyntheticKeyInPsEnvironment() throws {
        // Given a temporary daemon that reads hello without writing it anywhere.
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("side-supervisor-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let daemon = directory.appendingPathComponent("side")
        try Data("#!/bin/sh\nwhile read line; do :; done\n".utf8).write(to: daemon)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: daemon.path)
        let supervisor = DaemonSupervisor(daemonURL: daemon, appVersion: "test", keyStore: FakeKeyStore())

        // When the supervisor starts the daemon and ps prints its environment.
        supervisor.start()
        defer { supervisor.stop() }
        let pid = try XCTUnwrap(supervisor.daemonPID)
        let ps = Process()
        let output = Pipe()
        ps.executableURL = URL(fileURLWithPath: "/bin/ps")
        ps.arguments = ["-E", "-p", String(pid)]
        ps.standardOutput = output
        try ps.run()
        ps.waitUntilExit()
        let listing = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)

        // Then the synthetic 32-byte master key appears in neither argv nor env.
        XCTAssertEqual(ps.terminationStatus, 0)
        XCTAssertFalse(listing.contains(Data(repeating: 0x42, count: 32).base64EncodedString()))
    }

    @MainActor
    func testSendRejectsInvalidOrOversizedJsonLines() {
        let supervisor = DaemonSupervisor(
            daemonURL: URL(fileURLWithPath: "/unused/side"), keyStore: FakeKeyStore()
        )
        let concatenated = Data("{\"type\":\"health\"}\n{\"type\":\"event\"}\n".utf8)
        let oversized = Data(repeating: 0x61, count: CaptureProtocol.maxRawBytes)

        XCTAssertThrowsError(try supervisor.sendFrame(concatenated)) { error in
            XCTAssertEqual(error as? SupervisorTransportError, .invalidFrame)
        }
        XCTAssertThrowsError(try supervisor.sendFrame(oversized)) { error in
            XCTAssertEqual(error as? SupervisorTransportError, .invalidFrame)
        }
        XCTAssertThrowsError(try supervisor.sendHealth(HelperHealth())) { error in
            XCTAssertEqual(error as? SupervisorTransportError, .notRunning)
        }
    }

    @MainActor
    func testEventAndHealthFramesReachDaemonWithoutRepeatingHello() async throws {
        let (directory, daemon) = try makeDaemonScript { directory in
            let output = directory.appendingPathComponent("frames").path
            return "IFS= read -r hello\nIFS= read -r event\nIFS= read -r health\nprintf '%s\\n%s\\n' \"$event\" \"$health\" > '\(output).tmp'\nmv '\(output).tmp' '\(output)'\n"
        }
        defer { try? FileManager.default.removeItem(at: directory) }
        let supervisor = DaemonSupervisor(daemonURL: daemon, appVersion: "test", keyStore: FakeKeyStore())
        supervisor.start()
        defer { supervisor.stop() }
        var health = HelperHealth()
        health.state = .running

        try supervisor.sendEvent(["kind": "window.changed"])
        try supervisor.sendHealth(health)

        let bytes = try await waitForFile(directory.appendingPathComponent("frames"))
        let frames = String(decoding: bytes, as: UTF8.self).split(separator: "\n")
        XCTAssertEqual(frames.count, 2)
        XCTAssertEqual(try object(from: Data((frames[0] + "\n").utf8))["type"] as? String, "event")
        XCTAssertEqual(try object(from: Data((frames[1] + "\n").utf8))["type"] as? String, "health")
    }

    @MainActor
    func testAsyncCommandResultKeepsItsRequestId() async throws {
        let (directory, daemon) = try makeDaemonScript { directory in
            let output = directory.appendingPathComponent("reply").path
            return "IFS= read -r hello\nprintf '%s\\n' '{\"type\":\"command\",\"id\":\"async-1\",\"name\":\"permissions\"}'\nIFS= read -r reply\nprintf '%s\\n' \"$reply\" > '\(output).tmp'\nmv '\(output).tmp' '\(output)'\n"
        }
        defer { try? FileManager.default.removeItem(at: directory) }
        let supervisor = DaemonSupervisor(daemonURL: daemon, appVersion: "test", keyStore: FakeKeyStore())
        supervisor.onOtherCommand = { _ in
            try? await Task.sleep(nanoseconds: 20_000_000)
            return try? CaptureProtocol.encodeResultSuccess(id: "async-1", data: ["ok": true])
        }
        supervisor.start()
        defer { supervisor.stop() }

        let reply = try object(from: await waitForFile(directory.appendingPathComponent("reply")))
        XCTAssertEqual(reply["type"] as? String, "result")
        XCTAssertEqual(reply["id"] as? String, "async-1")
        XCTAssertEqual(reply["ok"] as? Bool, true)
    }

    @MainActor
    func testAsyncCommandRejectsMismatchedResultId() async throws {
        let (directory, daemon) = try makeDaemonScript { directory in
            let output = directory.appendingPathComponent("reply").path
            return "IFS= read -r hello\nprintf '%s\\n' '{\"type\":\"command\",\"id\":\"asked-1\",\"name\":\"permissions\"}'\nIFS= read -r reply\nprintf '%s\\n' \"$reply\" > '\(output).tmp'\nmv '\(output).tmp' '\(output)'\n"
        }
        defer { try? FileManager.default.removeItem(at: directory) }
        let supervisor = DaemonSupervisor(daemonURL: daemon, appVersion: "test", keyStore: FakeKeyStore())
        supervisor.onOtherCommand = { _ in
            try? CaptureProtocol.encodeResultSuccess(id: "wrong-1", data: ["ok": true])
        }
        supervisor.start()
        defer { supervisor.stop() }

        let reply = try object(from: await waitForFile(directory.appendingPathComponent("reply")))
        XCTAssertEqual(reply["id"] as? String, "asked-1")
        XCTAssertEqual(reply["ok"] as? Bool, false)
        XCTAssertEqual(reply["error"] as? String, "invalid-result")
    }

    @MainActor
    func testTransportWriteErrorPropagatesWithoutLeakingFrame() throws {
        let (directory, daemon) = try makeDaemonScript { _ in
            "IFS= read -r hello\nIFS= read -r ignored\n"
        }
        defer { try? FileManager.default.removeItem(at: directory) }
        let supervisor = DaemonSupervisor(daemonURL: daemon, appVersion: "test", keyStore: FakeKeyStore())
        supervisor.start()
        defer { supervisor.stop() }
        supervisor.writeData = { _, _ in throw NSError(domain: "SyntheticWrite", code: 1) }

        XCTAssertThrowsError(try supervisor.sendEvent(["kind": "window.changed"])) { error in
            XCTAssertEqual((error as NSError).domain, "SyntheticWrite")
        }
    }

    @MainActor
    func testStaleAsyncReplyCannotEnterRestartedDaemon() async throws {
        let (directory, daemon) = try makeDaemonScript { directory in
            let marker = directory.appendingPathComponent("first-start").path
            let output = directory.appendingPathComponent("new-frame").path
            return "IFS= read -r hello\nif [ ! -e '\(marker)' ]; then\n  : > '\(marker)'\n  printf '%s\\n' '{\"type\":\"command\",\"id\":\"old-1\",\"name\":\"permissions\"}'\n  IFS= read -r ignored\nelse\n  IFS= read -r frame\n  printf '%s\\n' \"$frame\" > '\(output).tmp'\n  mv '\(output).tmp' '\(output)'\nfi\n"
        }
        defer { try? FileManager.default.removeItem(at: directory) }
        let supervisor = DaemonSupervisor(daemonURL: daemon, appVersion: "test", keyStore: FakeKeyStore())
        let began = expectation(description: "old command reached async router")
        var finishOld: CheckedContinuation<Data?, Never>?
        supervisor.onOtherCommand = { _ in
            began.fulfill()
            return await withCheckedContinuation { finishOld = $0 }
        }
        supervisor.start()
        await fulfillment(of: [began], timeout: 2)

        supervisor.stop()
        supervisor.start()
        defer { supervisor.stop() }
        finishOld?.resume(returning: try CaptureProtocol.encodeResultSuccess(id: "old-1", data: ["ok": true]))
        try await Task.sleep(nanoseconds: 100_000_000)
        try supervisor.sendHealth(HelperHealth())

        let frame = try object(from: await waitForFile(directory.appendingPathComponent("new-frame")))
        XCTAssertEqual(frame["type"] as? String, "health")
    }

    @MainActor
    func testQuitSendsTermAndStopsSupervision() async throws {
        // Given a daemon that records SIGTERM and exits cleanly.
        let (directory, daemon) = try makeDaemonScript { directory in
            let terminated = directory.appendingPathComponent("terminated").path
            let ready = directory.appendingPathComponent("ready").path
            return "IFS= read -r hello\ntrap 'touch \"\(terminated)\"; exit 0' TERM\ntouch '\(ready)'\nwhile :; do sleep 1; done\n"
        }
        defer { try? FileManager.default.removeItem(at: directory) }
        let supervisor = DaemonSupervisor(daemonURL: daemon, appVersion: "test", keyStore: FakeKeyStore())
        supervisor.start()
        _ = try await waitForFile(directory.appendingPathComponent("ready"))

        // When Quit requests a graceful daemon shutdown.
        await supervisor.stopForQuit()

        // Then SIGTERM was received and the supervisor cannot restart it.
        XCTAssertTrue(FileManager.default.fileExists(atPath: directory.appendingPathComponent("terminated").path))
        XCTAssertEqual(supervisor.state, .stopped)
        XCTAssertNil(supervisor.daemonPID)
    }

    @MainActor
    func testQuitForcesDaemonAfterFiveSecondsWhenTermIgnored() async throws {
        // Given a daemon that has installed a handler ignoring SIGTERM.
        let (directory, daemon) = try makeDaemonScript { directory in
            let ready = directory.appendingPathComponent("ready").path
            return "IFS= read -r hello\ntrap '' TERM\ntouch '\(ready)'\nwhile :; do sleep 1; done\n"
        }
        defer { try? FileManager.default.removeItem(at: directory) }
        let supervisor = DaemonSupervisor(daemonURL: daemon, appVersion: "test", keyStore: FakeKeyStore())
        supervisor.start()
        _ = try await waitForFile(directory.appendingPathComponent("ready"))
        let pid = try XCTUnwrap(supervisor.daemonPID)
        let began = Date()

        // When Quit waits for graceful shutdown and reaches its deadline.
        await supervisor.stopForQuit()

        // Then the child is gone after the five-second grace period.
        XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(began), 5)
        XCTAssertEqual(kill(pid, 0), -1)
        XCTAssertEqual(supervisor.state, .stopped)
    }

    private func object(from line: Data) throws -> [String: Any] {
        XCTAssertEqual(line.last, 0x0A)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: line.dropLast()) as? [String: Any])
    }

    private func makeDaemonScript(_ body: (URL) -> String) throws -> (URL, URL) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("side-supervisor-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let daemon = directory.appendingPathComponent("side")
        try Data(("#!/bin/sh\n" + body(directory)).utf8).write(to: daemon)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: daemon.path)
        return (directory, daemon)
    }

    private func waitForFile(_ url: URL) async throws -> Data {
        for _ in 0..<500 {
            if let data = try? Data(contentsOf: url) { return data }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        throw NSError(domain: "SupervisorTests", code: 1, userInfo: [NSLocalizedDescriptionKey: "daemon output missing"])
    }
}

private final class FakeKeyStore: SideKeyStore {
    private var providerKeys: [String: String] = [:]
    var failMasterKey = false
    var failRotation = false
    var rotations = 0

    func masterKey() throws -> Data {
        if failMasterKey { throw NSError(domain: "SyntheticKeychain", code: 1) }
        return Data(repeating: 0x42, count: 32)
    }
    func rotateMasterKey() throws -> Data {
        rotations += 1
        if failRotation { throw NSError(domain: "SyntheticKeychain", code: 2) }
        return Data(repeating: 0x43, count: 32)
    }
    func setProviderKey(ref: String, secret: String) throws { providerKeys[ref] = secret }
    func providerKey(ref: String) throws -> String? { providerKeys[ref] }
}
