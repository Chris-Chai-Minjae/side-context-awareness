import Foundation

struct OnboardingPermissions: Equatable, Decodable {
    let accessibility: Bool
    let inputMonitoring: Bool
    let screenRecording: Bool

    private enum CodingKeys: String, CodingKey {
        case accessibility
        case inputMonitoring = "input_monitoring"
        case screenRecording = "screen_recording"
    }
}

enum OnboardingProviderKind: String, Decodable {
    case openAICompatible = "openai-compatible"
    case claudeCodeCLI = "claude-code-cli"
    case codexCLI = "codex-cli"
}

struct OnboardingProvider: Equatable {
    let id: String
    let baseURL: String?
    let models: [String]
    let supportsToolChoice: Bool
    let allowEvidence: Bool
    let kind: OnboardingProviderKind

    init(
        id: String, baseURL: String?, models: [String], supportsToolChoice: Bool,
        allowEvidence: Bool, kind: OnboardingProviderKind = .openAICompatible
    ) {
        self.id = id
        self.baseURL = baseURL
        self.models = models
        self.supportsToolChoice = supportsToolChoice
        self.allowEvidence = allowEvidence
        self.kind = kind
    }
}

struct OnboardingSettings: Equatable {
    let enabled: Bool
    let screenOCR: Bool
    let providers: [OnboardingProvider]
    let language: SideLanguage

    init(enabled: Bool, screenOCR: Bool, providers: [OnboardingProvider], language: SideLanguage = .ko) {
        self.enabled = enabled
        self.screenOCR = screenOCR
        self.providers = providers
        self.language = language
    }
}

struct OnboardingProviderTest: Decodable {
    let ok: Bool
    let error: String?
}

@MainActor
protocol OnboardingService: AnyObject {
    func getSettings() async throws -> OnboardingSettings
    func setLanguage(_ language: SideLanguage) async throws -> OnboardingSettings
    func getPermissions() async throws -> OnboardingPermissions
    func request(_ kind: PermissionKind) async throws -> OnboardingPermissions
    func setScreenOCR(_ enabled: Bool) async throws -> OnboardingSettings
    func saveProviders(_ providers: [OnboardingProvider]) async throws -> OnboardingSettings
    func setKey(providerID: String, apiKey: String) async throws
    func testProvider(providerID: String, modelID: String) async throws -> OnboardingProviderTest
    func selectSummaryModel(providerID: String, modelID: String) async throws -> OnboardingSettings
    func clearSummaryModel() async throws -> OnboardingSettings
    func setEnabled(_ enabled: Bool) async throws -> OnboardingSettings
}

private struct ProviderResource: Decodable {
    let id: String
    let kind: OnboardingProviderKind?
    let base_url: String?
    let models: [String]
    let supports_tool_choice: Bool
    let allow_evidence: Bool

    var provider: OnboardingProvider {
        OnboardingProvider(
            id: id, baseURL: base_url, models: models,
            supportsToolChoice: supports_tool_choice, allowEvidence: allow_evidence,
            kind: kind ?? .openAICompatible
        )
    }
}

private struct SettingsResource: Decodable {
    let enabled: Bool
    let screen_ocr: Bool
    let ui_language: SideLanguage?
    let providers: [ProviderResource]

    var settings: OnboardingSettings {
        OnboardingSettings(
            enabled: enabled, screenOCR: screen_ocr,
            providers: providers.map(\.provider), language: ui_language ?? .ko
        )
    }
}

private struct KeyReference: Decodable {
    let apiKeyRef: String
}

private struct RPCErrorBody: Decodable {
    let message: String
}

private struct RPCReply<Value: Decodable>: Decodable {
    let jsonrpc: String
    let id: String?
    let result: Value?
    let error: RPCErrorBody?
}

enum OnboardingRPCError: Error {
    case unavailable
    case invalidResponse
    case rejected(String)
}

@MainActor
final class UDSOnboardingService: OnboardingService {
    typealias Sender = @Sendable (Data, String, Int) throws -> Data
    nonisolated private static let requestTimeoutSeconds = 10
    // 10s shared-slot wait + 60s provider request + 10s RPC overhead = 80s.
    nonisolated private static let providerTestTimeoutSeconds = 10 + 60 + requestTimeoutSeconds
    private let socketPath: String
    private let sender: Sender

    init(socketPath: String = UDSOnboardingService.defaultSocketPath(), sender: Sender? = nil) {
        self.socketPath = socketPath
        self.sender = sender ?? { body, path, timeout in try Self.send(body, path, timeout) }
    }

    func getSettings() async throws -> OnboardingSettings {
        let result: SettingsResource = try await call("settings.get")
        return result.settings
    }

    func setLanguage(_ language: SideLanguage) async throws -> OnboardingSettings {
        let result: SettingsResource = try await call(
            "settings.patch", params: ["uiLanguage": language.rawValue]
        )
        return result.settings
    }

    func getPermissions() async throws -> OnboardingPermissions {
        try await call("permissions")
    }

    func request(_ kind: PermissionKind) async throws -> OnboardingPermissions {
        try await call("requestPermissions", params: ["kinds": [kind.rawValue]])
    }

    func setScreenOCR(_ enabled: Bool) async throws -> OnboardingSettings {
        let result: SettingsResource = try await call("settings.patch", params: ["screenOcr": enabled])
        return result.settings
    }

    func saveProviders(_ providers: [OnboardingProvider]) async throws -> OnboardingSettings {
        let values: [[String: Any]] = try providers.map { provider in
            if provider.kind == .claudeCodeCLI || provider.kind == .codexCLI {
                return [
                    "id": provider.id,
                    "kind": provider.kind.rawValue,
                    "models": provider.models,
                    "allowEvidence": provider.allowEvidence,
                ]
            }
            guard let baseURL = provider.baseURL else { throw OnboardingRPCError.invalidResponse }
            return [
                "id": provider.id,
                "baseUrl": baseURL,
                "models": provider.models,
                "supportsToolChoice": provider.supportsToolChoice,
                "allowEvidence": provider.allowEvidence,
            ]
        }
        let result: SettingsResource = try await call("settings.patch", params: ["providers": values])
        return result.settings
    }

    func setKey(providerID: String, apiKey: String) async throws {
        let result: KeyReference = try await call(
            "providers.setKey", params: ["providerId": providerID, "apiKey": apiKey]
        )
        guard !result.apiKeyRef.isEmpty else { throw OnboardingRPCError.invalidResponse }
    }

    func testProvider(providerID: String, modelID: String) async throws -> OnboardingProviderTest {
        try await call(
            "providers.test", params: ["providerId": providerID, "modelId": modelID],
            timeoutSeconds: Self.providerTestTimeoutSeconds
        )
    }

    func selectSummaryModel(providerID: String, modelID: String) async throws -> OnboardingSettings {
        let result: SettingsResource = try await call(
            "settings.patch", params: ["summaryModel": ["provider": providerID, "modelId": modelID]]
        )
        return result.settings
    }

    func clearSummaryModel() async throws -> OnboardingSettings {
        let result: SettingsResource = try await call(
            "settings.patch", params: ["summaryModel": NSNull(), "defaultModel": NSNull()]
        )
        return result.settings
    }

    func setEnabled(_ enabled: Bool) async throws -> OnboardingSettings {
        let result: SettingsResource = try await call("settings.patch", params: ["enabled": enabled])
        return result.settings
    }

    private func call<Value: Decodable>(
        _ method: String, params: [String: Any]? = nil, timeoutSeconds: Int? = nil
    ) async throws -> Value {
        let id = UUID().uuidString
        var request: [String: Any] = ["jsonrpc": "2.0", "id": id, "method": method]
        if let params { request["params"] = params }
        let body = try JSONSerialization.data(withJSONObject: request)
        let path = socketPath
        let sender = sender
        let data = try await Task.detached(priority: .userInitiated) {
            try sender(body, path, timeoutSeconds ?? Self.requestTimeoutSeconds)
        }.value
        let reply = try JSONDecoder().decode(RPCReply<Value>.self, from: data)
        guard reply.jsonrpc == "2.0", reply.id == id else { throw OnboardingRPCError.invalidResponse }
        if let error = reply.error { throw OnboardingRPCError.rejected(error.message) }
        guard let result = reply.result else { throw OnboardingRPCError.invalidResponse }
        return result
    }

    nonisolated private static func defaultSocketPath() -> String {
        let directory = ProcessInfo.processInfo.environment["SIDE_DATA_DIR"].map(URL.init(fileURLWithPath:))
            ?? FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Library/Application Support/Side", isDirectory: true)
        return directory.appendingPathComponent("run/daemon.sock").path
    }

    nonisolated private static func send(_ body: Data, _ socketPath: String, _ timeoutSeconds: Int) throws -> Data {
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
            guard process.terminationStatus == 0 else { throw OnboardingRPCError.unavailable }
            return response
        } catch {
            if process.isRunning { process.terminate() }
            throw OnboardingRPCError.unavailable
        }
    }
}
