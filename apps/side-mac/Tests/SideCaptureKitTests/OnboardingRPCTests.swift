import Darwin
import Foundation
import XCTest
@testable import Side

private enum FixtureError: Error {
    case socket
    case request
}

final class OneShotRPCServer {
    let path: String
    private let listener: Int32
    private let finished = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var request: [String: Any]?
    private let result: [String: Any]

    init(result: [String: Any]) throws {
        self.result = result
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("side-rpc-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        path = directory.appendingPathComponent("rpc.sock").path
        listener = socket(AF_UNIX, SOCK_STREAM, 0)
        guard listener >= 0 else { throw FixtureError.socket }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8CString).map(UInt8.init(bitPattern:))
        let pathFits = withUnsafeMutableBytes(of: &address.sun_path) { buffer -> Bool in
            guard bytes.count <= buffer.count else { return false }
            buffer.copyBytes(from: bytes)
            return true
        }
        guard pathFits else { throw FixtureError.socket }
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bound == 0, listen(listener, 1) == 0 else { throw FixtureError.socket }
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            defer { finished.signal() }
            let client = accept(listener, nil, nil)
            guard client >= 0 else { return }
            defer { Darwin.close(client) }
            var noSigPipe: Int32 = 1
            _ = setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
            guard let payload = Self.readRequest(client),
                  let value = try? JSONSerialization.jsonObject(with: payload) as? [String: Any],
                  let id = value["id"] as? String else { return }
            lock.lock()
            request = value
            lock.unlock()
            guard let body = try? JSONSerialization.data(withJSONObject: [
                "jsonrpc": "2.0", "id": id, "result": result,
            ]) else { return }
            let header = Data("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n".utf8)
            Self.writeAll(header + body, to: client)
        }
    }

    func receivedRequest() throws -> [String: Any] {
        guard finished.wait(timeout: .now() + 3) == .success else { throw FixtureError.request }
        lock.lock()
        defer { lock.unlock() }
        guard let request else { throw FixtureError.request }
        return request
    }

    func close() {
        shutdown(listener, SHUT_RDWR)
        Darwin.close(listener)
        try? FileManager.default.removeItem(atPath: path)
        try? FileManager.default.removeItem(atPath: URL(fileURLWithPath: path).deletingLastPathComponent().path)
    }

    private static func readRequest(_ client: Int32) -> Data? {
        var received = Data()
        var buffer = [UInt8](repeating: 0, count: 4_096)
        let marker = Data("\r\n\r\n".utf8)
        while true {
            let count = recv(client, &buffer, buffer.count, 0)
            guard count > 0 else { return nil }
            received.append(contentsOf: buffer.prefix(count))
            guard let boundary = received.range(of: marker) else { continue }
            let header = String(decoding: received[..<boundary.lowerBound], as: UTF8.self)
            guard let lengthLine = header.split(separator: "\r\n").first(where: {
                $0.lowercased().hasPrefix("content-length:")
            }), let length = Int(lengthLine.split(separator: ":", maxSplits: 1).last?.trimmingCharacters(in: .whitespaces) ?? "") else {
                return nil
            }
            let start = boundary.upperBound
            if received.count >= start + length { return received.subdata(in: start..<(start + length)) }
        }
    }

    private static func writeAll(_ data: Data, to client: Int32) {
        data.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return }
            var sent = 0
            while sent < data.count {
                let count = Darwin.write(client, base.advanced(by: sent), data.count - sent)
                guard count > 0 else { return }
                sent += count
            }
        }
    }
}

@MainActor
final class OnboardingRPCTests: XCTestCase {
    private struct VirtualClock {
        private(set) var seconds = 0

        mutating func advance(to seconds: Int) { self.seconds = seconds }
    }

    private func virtualSender(
        responseAfter seconds: Int, expectedTimeout: Int, expectedMethod: String,
        expectedModelID: String? = nil, result: [String: Any]
    ) -> UDSOnboardingService.Sender {
        { body, _, timeout in
            guard timeout == expectedTimeout,
                  let request = try JSONSerialization.jsonObject(with: body) as? [String: Any],
                  let id = request["id"] as? String,
                  request["method"] as? String == expectedMethod else { throw FixtureError.request }
            if let expectedModelID {
                guard (request["params"] as? [String: Any])?["modelId"] as? String == expectedModelID
                else { throw FixtureError.request }
            }
            var clock = VirtualClock()
            clock.advance(to: min(seconds, timeout))
            guard seconds < timeout else { throw OnboardingRPCError.unavailable }
            guard clock.seconds == seconds else { throw FixtureError.request }
            return try JSONSerialization.data(withJSONObject: [
                "jsonrpc": "2.0", "id": id, "result": result,
            ])
        }
    }

    func testProviderTestAcceptsSuccessfulResponseAfterElevenSeconds() async throws {
        // Given a synthetic provider result after eleven virtual seconds.
        let sender = virtualSender(
            responseAfter: 11, expectedTimeout: 80, expectedMethod: "providers.test",
            expectedModelID: "model-1", result: ["ok": true]
        )

        // When the native client waits for the provider-test RPC response.
        let result = try await UDSOnboardingService(socketPath: "/virtual.sock", sender: sender)
            .testProvider(providerID: "synthetic", modelID: "model-1")

        // Then a valid slow response reaches onboarding for summary-model selection.
        XCTAssertTrue(result.ok)
    }

    func testProviderTestAcceptsQueuedResponseAfterSeventyOneSeconds() async throws {
        // A synthetic daemon holds the RPC for seventy-one virtual seconds.
        let sender = virtualSender(
            responseAfter: 71, expectedTimeout: 80, expectedMethod: "providers.test",
            result: ["ok": true]
        )

        let result = try await UDSOnboardingService(socketPath: "/virtual.sock", sender: sender)
            .testProvider(providerID: "synthetic", modelID: "model-1")

        XCTAssertTrue(result.ok)
    }

    func testOrdinarySettingsRPCStillTimesOutAfterTenSeconds() async throws {
        // Given a settings response eleven virtual seconds after the request.
        let sender = virtualSender(responseAfter: 11, expectedTimeout: 10, expectedMethod: "settings.get", result: [
            "enabled": false, "screen_ocr": true, "providers": [],
        ])

        // When the native client requests settings.
        do {
            _ = try await UDSOnboardingService(socketPath: "/virtual.sock", sender: sender).getSettings()
            XCTFail("Ordinary settings RPC must time out before the delayed response")
        } catch OnboardingRPCError.unavailable {
            // Then the existing short timeout remains effective.
        }
    }

    func testSettingsGetUsesUDSAndDecodesDaemonResource() async throws {
        // Given a synthetic local RPC endpoint with disabled settings.
        let server = try OneShotRPCServer(result: [
            "enabled": false, "screen_ocr": true, "ui_language": "en",
            "providers": [[
                "id": "synthetic", "base_url": "http://localhost:11434/v1", "models": ["model-1"],
                "supports_tool_choice": false, "allow_evidence": false,
            ]],
        ])
        defer { server.close() }

        // When the Swift client reads settings over the socket.
        let settings = try await UDSOnboardingService(socketPath: server.path).getSettings()

        // Then the daemon resource and method are correctly decoded without a TCP token.
        XCTAssertFalse(settings.enabled)
        XCTAssertEqual(settings.language, .en)
        XCTAssertEqual(settings.providers.first?.id, "synthetic")
        XCTAssertEqual(try server.receivedRequest()["method"] as? String, "settings.get")
    }

    func testLanguagePatchUsesApprovedCamelCaseKey() async throws {
        let server = try OneShotRPCServer(result: [
            "enabled": false, "screen_ocr": true, "ui_language": "en", "providers": [],
        ])
        defer { server.close() }

        let settings = try await UDSOnboardingService(socketPath: server.path).setLanguage(.en)

        XCTAssertEqual(settings.language, .en)
        let request = try server.receivedRequest()
        XCTAssertEqual(request["method"] as? String, "settings.patch")
        XCTAssertEqual((request["params"] as? [String: Any])?["uiLanguage"] as? String, "en")
    }

    func testClaudeCodeProviderPatchOmitsBaseURLAndKeyWhilePreservingHTTPProvider() async throws {
        let server = try OneShotRPCServer(result: [
            "enabled": false, "screen_ocr": true, "ui_language": "ko", "providers": [],
        ])
        defer { server.close() }
        let providers = [
            OnboardingProvider(
                id: "HTTP", baseURL: "https://example.invalid/v1", models: ["model-1"],
                supportsToolChoice: true, allowEvidence: false
            ),
            OnboardingProvider(
                id: "Claude Code", baseURL: nil, models: ["claude-sonnet-4-6"],
                supportsToolChoice: false, allowEvidence: false, kind: .claudeCodeCLI
            ),
        ]

        _ = try await UDSOnboardingService(socketPath: server.path).saveProviders(providers)

        let request = try server.receivedRequest()
        XCTAssertEqual(request["method"] as? String, "settings.patch")
        let patch = try XCTUnwrap(request["params"] as? [String: Any])
        let saved = try XCTUnwrap(patch["providers"] as? [[String: Any]])
        XCTAssertEqual(saved.count, 2)
        XCTAssertEqual(saved[0]["baseUrl"] as? String, "https://example.invalid/v1")
        XCTAssertEqual(saved[1]["kind"] as? String, "claude-code-cli")
        XCTAssertEqual(saved[1]["models"] as? [String], ["claude-sonnet-4-6"])
        XCTAssertEqual(saved[1]["allowEvidence"] as? Bool, false)
        XCTAssertNil(saved[1]["baseUrl"])
        XCTAssertNil(saved[1]["apiKey"])
    }

    func testSettingsGetDecodesClaudeCodeProviderWithoutBaseURL() async throws {
        let server = try OneShotRPCServer(result: [
            "enabled": false, "screen_ocr": true, "ui_language": "ko",
            "providers": [[
                "id": "Claude Code", "kind": "claude-code-cli", "base_url": NSNull(),
                "models": ["claude-sonnet-4-6"], "supports_tool_choice": false,
                "allow_evidence": false,
            ]],
        ])
        defer { server.close() }

        let settings = try await UDSOnboardingService(socketPath: server.path).getSettings()

        XCTAssertEqual(settings.providers.first?.kind, .claudeCodeCLI)
        XCTAssertNil(settings.providers.first?.baseURL)
        XCTAssertEqual(settings.providers.first?.models, ["claude-sonnet-4-6"])
    }

    func testCodexProviderPatchOmitsBaseURLAndKey() async throws {
        let server = try OneShotRPCServer(result: [
            "enabled": false, "screen_ocr": true, "ui_language": "ko", "providers": [],
        ])
        defer { server.close() }
        let providers = [OnboardingProvider(
            id: "OpenAI (Codex login)", baseURL: nil, models: ["gpt-6-luna"],
            supportsToolChoice: false, allowEvidence: false, kind: .codexCLI
        )]

        _ = try await UDSOnboardingService(socketPath: server.path).saveProviders(providers)

        let request = try server.receivedRequest()
        let patch = try XCTUnwrap(request["params"] as? [String: Any])
        let saved = try XCTUnwrap(patch["providers"] as? [[String: Any]])
        XCTAssertEqual(saved.first?["kind"] as? String, "codex-cli")
        XCTAssertEqual(saved.first?["models"] as? [String], ["gpt-6-luna"])
        XCTAssertNil(saved.first?["baseUrl"])
        XCTAssertNil(saved.first?["apiKey"])
    }

    func testSettingsGetDecodesCodexProviderWithoutBaseURL() async throws {
        let server = try OneShotRPCServer(result: [
            "enabled": false, "screen_ocr": true, "ui_language": "ko",
            "providers": [[
                "id": "OpenAI (Codex login)", "kind": "codex-cli", "base_url": NSNull(),
                "models": ["gpt-6-luna"], "supports_tool_choice": false,
                "allow_evidence": false,
            ]],
        ])
        defer { server.close() }

        let settings = try await UDSOnboardingService(socketPath: server.path).getSettings()

        XCTAssertEqual(settings.providers.first?.kind, .codexCLI)
        XCTAssertNil(settings.providers.first?.baseURL)
        XCTAssertEqual(settings.providers.first?.models, ["gpt-6-luna"])
    }

    func testScreenRecordingSkipSendsCamelCasePatchOverUDS() async throws {
        // Given a synthetic local RPC endpoint that accepts a settings patch.
        let server = try OneShotRPCServer(result: ["enabled": false, "screen_ocr": false, "providers": []])
        defer { server.close() }

        // When the Swift client disables OCR.
        let settings = try await UDSOnboardingService(socketPath: server.path).setScreenOCR(false)

        // Then the daemon receives the schema's camelCase patch key.
        XCTAssertFalse(settings.screenOCR)
        XCTAssertEqual(settings.language, .ko)
        let request = try server.receivedRequest()
        XCTAssertEqual(request["method"] as? String, "settings.patch")
        XCTAssertEqual((request["params"] as? [String: Any])?["screenOcr"] as? Bool, false)
    }

    func testProviderSkipClearsBothModelSelectionsOverUDS() async throws {
        // Given a synthetic local RPC endpoint with an existing model selection.
        let server = try OneShotRPCServer(result: ["enabled": false, "screen_ocr": true, "providers": []])
        defer { server.close() }

        // When provider setup is skipped.
        _ = try await UDSOnboardingService(socketPath: server.path).clearSummaryModel()

        // Then both model selection fields are explicitly cleared in one patch.
        let request = try server.receivedRequest()
        XCTAssertEqual(request["method"] as? String, "settings.patch")
        let patch = try XCTUnwrap(request["params"] as? [String: Any])
        XCTAssertTrue(patch["summaryModel"] is NSNull)
        XCTAssertTrue(patch["defaultModel"] is NSNull)
    }

    func testEnableSendsApprovedSettingsPatchOverUDS() async throws {
        // Given a synthetic daemon accepting the final onboarding choice.
        let server = try OneShotRPCServer(result: ["enabled": true, "screen_ocr": false, "providers": []])
        defer { server.close() }

        // When onboarding enables capture.
        let settings = try await UDSOnboardingService(socketPath: server.path).setEnabled(true)

        // Then the approved settings.patch method carries enabled=true.
        XCTAssertTrue(settings.enabled)
        let request = try server.receivedRequest()
        XCTAssertEqual(request["method"] as? String, "settings.patch")
        XCTAssertEqual((request["params"] as? [String: Any])?["enabled"] as? Bool, true)
    }

    func testPermissionRequestUsesApprovedHelperMethodOverUDS() async throws {
        // Given a synthetic helper response for Accessibility.
        let server = try OneShotRPCServer(result: [
            "accessibility": true, "input_monitoring": false, "screen_recording": false,
        ])
        defer { server.close() }

        // When onboarding asks for Accessibility.
        let permissions = try await UDSOnboardingService(socketPath: server.path).request(.accessibility)

        // Then the helper method and payload match the approved contract.
        XCTAssertTrue(permissions.accessibility)
        let request = try server.receivedRequest()
        XCTAssertEqual(request["method"] as? String, "requestPermissions")
        XCTAssertEqual((request["params"] as? [String: Any])?["kinds"] as? [String], ["accessibility"])
    }
}
