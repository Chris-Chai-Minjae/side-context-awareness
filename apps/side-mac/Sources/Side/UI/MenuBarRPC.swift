import Foundation

enum MenuBarRPCError: Error {
    case unavailable
    case invalidResponse
    case rejected
}

private struct PauseReply: Decodable {
    let paused_until: Int64?
}

@MainActor
final class UDSMenuBarService: MenuBarServicing {
    nonisolated private static let timeoutSeconds = 10
    private let socketPath: String

    init(socketPath: String = UDSMenuBarService.defaultSocketPath()) {
        self.socketPath = socketPath
    }

    func fetchStatus() async throws -> MenuCaptureStatus {
        let result = try await call("status")
        return try JSONDecoder().decode(MenuCaptureStatus.self, from: result)
    }

    func pause(_ option: MenuPauseOption) async throws {
        let result = try await call("pause", params: option.rpcParams)
        guard try JSONDecoder().decode(PauseReply.self, from: result).paused_until != nil else {
            throw MenuBarRPCError.invalidResponse
        }
    }

    func resume() async throws {
        _ = try await call("resume")
    }

    private func call(_ method: String, params: [String: Int64]? = nil) async throws -> Data {
        let id = UUID().uuidString
        var request: [String: Any] = ["jsonrpc": "2.0", "id": id, "method": method]
        if let params { request["params"] = params }
        let body = try JSONSerialization.data(withJSONObject: request)
        let path = socketPath
        let data = try await Task.detached(priority: .userInitiated) {
            try Self.send(body, socketPath: path)
        }.value
        guard let packet = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              packet["jsonrpc"] as? String == "2.0", packet["id"] as? String == id else {
            throw MenuBarRPCError.invalidResponse
        }
        if packet["error"] != nil { throw MenuBarRPCError.rejected }
        guard let result = packet["result"] else { throw MenuBarRPCError.invalidResponse }
        return try JSONSerialization.data(withJSONObject: result, options: [.fragmentsAllowed])
    }

    nonisolated private static func defaultSocketPath() -> String {
        let directory = ProcessInfo.processInfo.environment["SIDE_DATA_DIR"].map(URL.init(fileURLWithPath:))
            ?? FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Library/Application Support/Side", isDirectory: true)
        return directory.appendingPathComponent("run/daemon.sock").path
    }

    nonisolated private static func send(_ body: Data, socketPath: String) throws -> Data {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/curl")
        process.arguments = [
            "--silent", "--fail-with-body", "--max-time", String(timeoutSeconds),
            "--unix-socket", socketPath, "--request", "POST",
            "--header", "Content-Type: application/json", "--data-binary", "@-",
            "http://localhost/rpc",
        ]
        process.environment = ["LANG": "C"]
        let input = Pipe()
        let output = Pipe()
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            try input.fileHandleForWriting.write(contentsOf: body)
            try input.fileHandleForWriting.close()
            let response = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { throw MenuBarRPCError.unavailable }
            return response
        } catch {
            if process.isRunning { process.terminate() }
            throw MenuBarRPCError.unavailable
        }
    }
}
