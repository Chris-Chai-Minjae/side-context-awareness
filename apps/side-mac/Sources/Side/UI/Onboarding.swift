import Combine
import Foundation

enum OnboardingStep: String {
    case intro
    case accessibility
    case inputMonitoring
    case screenRecording
    case provider
    case finish
    case complete

    var permissionKind: PermissionKind? {
        switch self {
        case .accessibility: return .accessibility
        case .inputMonitoring: return .inputMonitoring
        case .screenRecording: return .screenRecording
        case .intro, .provider, .finish, .complete: return nil
        }
    }

    var settingsURL: URL? {
        let pane: String
        switch self {
        case .accessibility: pane = "Privacy_Accessibility"
        case .inputMonitoring: pane = "Privacy_ListenEvent"
        case .screenRecording: pane = "Privacy_ScreenCapture"
        case .intro, .provider, .finish, .complete: return nil
        }
        return URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)")
    }
}

@MainActor
final class OnboardingFlow: ObservableObject {
    static let permissionPollInterval: TimeInterval = 1
    static let permissionPollNanoseconds: UInt64 = 1_000_000_000
    static let resumeStepKey = "side.onboarding.step"

    @Published private(set) var step: OnboardingStep = .intro
    @Published private(set) var isLoaded = false
    @Published private(set) var isWorking = false
    @Published private(set) var isFinished = false
    @Published private(set) var language: SideLanguage = .ko
    @Published private(set) var errorMessage: String?

    private let service: OnboardingService
    private let permissions: PermissionCoordinator
    private let defaults: UserDefaults
    private let onLanguageChange: (SideLanguage) -> Void
    private let onComplete: () -> Void
    private var settings: OnboardingSettings?
    private var status: OnboardingPermissions?

    init(
        service: OnboardingService, permissions: PermissionCoordinator,
        defaults: UserDefaults = .standard,
        onLanguageChange: @escaping (SideLanguage) -> Void = { _ in },
        onComplete: @escaping () -> Void = {}
    ) {
        self.service = service
        self.permissions = permissions
        self.defaults = defaults
        self.onLanguageChange = onLanguageChange
        self.onComplete = onComplete
    }

    func load() async throws {
        do {
            let currentSettings = try await service.getSettings()
            settings = currentSettings
            language = currentSettings.language
            onLanguageChange(language)
            if currentSettings.enabled {
                complete(dismissSheet: false)
                return
            }
            status = try await service.getPermissions()
            permissions.configureScreenOCR(enabled: currentSettings.screenOCR)
            _ = permissions.takeResumePermissionSheet()
            permissions.presentPermissionSheet()
            step = defaults.string(forKey: Self.resumeStepKey).flatMap(OnboardingStep.init(rawValue:)) ?? .intro
            normalizeStep()
            isLoaded = true
            errorMessage = nil
        } catch {
            errorMessage = language.localized(
                "Side is still starting. Try again.", "Side가 시작 중입니다. 다시 시도하세요."
            )
            throw error
        }
    }

    func setLanguage(_ next: SideLanguage) async {
        guard isLoaded, !isWorking, next != language else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            let updated = try await service.setLanguage(next)
            guard updated.language == next else { throw OnboardingRPCError.invalidResponse }
            settings = updated
            language = next
            onLanguageChange(next)
            errorMessage = nil
        } catch {
            errorMessage = language.localized(
                "Could not save the language. Try again.", "언어를 저장할 수 없습니다. 다시 시도하세요."
            )
        }
    }

    func continueFromIntro() {
        guard step == .intro else { return }
        go(to: .accessibility)
        normalizeStep()
    }

    func pollPermissions() async {
        guard !isFinished else { return }
        do {
            status = try await service.getPermissions()
            normalizeStep()
            errorMessage = nil
        } catch {
            errorMessage = language.localized(
                "Could not check permissions. Side will retry.",
                "권한을 확인할 수 없습니다. Side가 다시 시도합니다."
            )
        }
    }

    func requestCurrentPermission() async {
        guard let kind = step.permissionKind, !isWorking else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            _ = try await service.request(kind)
            status = try await service.getPermissions()
            normalizeStep()
            errorMessage = nil
        } catch {
            errorMessage = language.localized(
                "Could not request access. Use System Settings and try again.",
                "권한을 요청할 수 없습니다. 시스템 설정에서 허용한 뒤 다시 시도하세요."
            )
        }
    }

    func skipScreenRecording() async {
        guard step == .screenRecording, !isWorking else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            let updated = try await service.setScreenOCR(false)
            guard !updated.screenOCR else { throw OnboardingRPCError.invalidResponse }
            settings = updated
            permissions.configureScreenOCR(enabled: false)
            go(to: .provider)
            errorMessage = nil
        } catch {
            errorMessage = language.localized(
                "Could not save the Screen Recording choice. Try again.",
                "화면 기록 선택을 저장할 수 없습니다. 다시 시도하세요."
            )
        }
    }

    func skipProvider() async {
        guard step == .provider, !isWorking else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            settings = try await service.clearSummaryModel()
            go(to: .finish)
            errorMessage = nil
        } catch {
            errorMessage = language.localized(
                "Could not save the provider choice. Try again.",
                "제공자 선택을 저장할 수 없습니다. 다시 시도하세요."
            )
        }
    }

    func submitProvider(
        name: String, baseURL: String, apiKey: String, modelID: String,
        supportsToolChoice: Bool = true, kind: OnboardingProviderKind = .openAICompatible
    ) async {
        guard step == .provider, !isWorking, let settings else { return }
        let providerID = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let endpoint = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        let model = modelID.trimmingCharacters(in: .whitespacesAndNewlines)
        switch kind {
        case .openAICompatible:
            guard !providerID.isEmpty, !model.isEmpty,
                  let url = URL(string: endpoint),
                  ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
                  url.host != nil, url.user == nil, url.password == nil,
                  url.query == nil, url.fragment == nil else {
                errorMessage = language.localized(
                    "Enter a name, HTTP or HTTPS Base URL without credentials or query, and model.",
                    "이름, 자격 증명과 쿼리가 없는 HTTP 또는 HTTPS 기본 URL, 모델을 입력하세요."
                )
                return
            }
        case .claudeCodeCLI:
            guard endpoint.isEmpty, apiKey.isEmpty else {
                errorMessage = language.localized(
                    "Claude Code login does not use a Base URL or API key.",
                    "Claude Code 로그인에는 기본 URL이나 API 키를 사용하지 않습니다."
                )
                return
            }
            guard !providerID.isEmpty,
                  model.range(of: #"^claude-[A-Za-z0-9-]+$"#, options: .regularExpression) != nil else {
                errorMessage = language.localized(
                    "Enter an explicit Claude Code model ID beginning with claude-.",
                    "claude-로 시작하는 명시적인 Claude Code 모델 ID를 입력하세요."
                )
                return
            }
        case .codexCLI:
            guard endpoint.isEmpty, apiKey.isEmpty else {
                errorMessage = language.localized(
                    "Codex login does not use a Base URL or API key.",
                    "Codex 로그인에는 기본 URL이나 API 키를 사용하지 않습니다."
                )
                return
            }
            guard !providerID.isEmpty,
                  model.range(of: #"^[A-Za-z0-9][A-Za-z0-9._-]*$"#, options: .regularExpression) != nil else {
                errorMessage = language.localized(
                    "Enter an explicit Codex model ID, such as gpt-6-luna.",
                    "gpt-6-luna와 같은 Codex Model ID를 직접 입력하세요."
                )
                return
            }
        }
        isWorking = true
        defer { isWorking = false }
        let provider = OnboardingProvider(
            id: providerID, baseURL: kind == .openAICompatible ? endpoint : nil, models: [model],
            supportsToolChoice: kind == .openAICompatible ? supportsToolChoice : false,
            allowEvidence: false, kind: kind
        )
        let providers = settings.providers.filter { $0.id != providerID } + [provider]
        do {
            self.settings = try await service.saveProviders(providers)
            if kind == .openAICompatible, !apiKey.isEmpty {
                try await service.setKey(providerID: providerID, apiKey: apiKey)
            }
            let result = try await service.testProvider(providerID: providerID, modelID: model)
            guard result.ok else {
                errorMessage = providerFailureMessage(result.error)
                return
            }
            self.settings = try await service.selectSummaryModel(providerID: providerID, modelID: model)
            go(to: .finish)
            errorMessage = nil
        } catch {
            errorMessage = language.localized(
                "Could not save or test the provider. Check the details and try again.",
                "제공자를 저장하거나 테스트할 수 없습니다. 세부 정보를 확인한 뒤 다시 시도하세요."
            )
        }
    }

    func enable() async {
        guard step == .finish, !isWorking else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            status = try await service.getPermissions()
            normalizeStep()
            guard step == .finish else {
                errorMessage = language.localized(
                    "Grant the required permissions before enabling capture.",
                    "캡처를 켜기 전에 필수 권한을 허용하세요."
                )
                return
            }
            let updated = try await service.setEnabled(true)
            guard updated.enabled else { throw OnboardingRPCError.invalidResponse }
            settings = updated
            complete()
        } catch {
            errorMessage = language.localized(
                "Could not enable Context Awareness. Try again.",
                "Context Awareness를 켤 수 없습니다. 다시 시도하세요."
            )
        }
    }

    private func normalizeStep() {
        guard step != .intro, step != .complete, let status, let settings else { return }
        if !status.accessibility { go(to: .accessibility); return }
        if !status.inputMonitoring { go(to: .inputMonitoring); return }
        if settings.screenOCR && !status.screenRecording { go(to: .screenRecording); return }
        if step.permissionKind != nil { go(to: .provider) }
    }

    private func providerFailureMessage(_ detail: String?) -> String {
        switch detail {
        case "Provider or model is not configured":
            return language.localized(
                "Provider or model is not configured.", "제공자 또는 모델이 설정되지 않았습니다."
            )
        case "record_summary response failed validation":
            return language.localized(
                "The provider returned an invalid summary response.",
                "제공자가 유효하지 않은 요약 응답을 반환했습니다."
            )
        default:
            let message = language.localized(
                "Provider test failed. Check the details and try again.",
                "제공자 연결 테스트에 실패했습니다. 세부 정보를 확인한 뒤 다시 시도하세요."
            )
            if let detail, detail.hasPrefix("HTTP "),
               let status = Int(detail.dropFirst(5)), (400...599).contains(status) {
                return "\(message) (HTTP \(status))"
            }
            return message
        }
    }

    private func go(to next: OnboardingStep) {
        step = next
        defaults.set(next.rawValue, forKey: Self.resumeStepKey)
    }

    private func complete(dismissSheet: Bool = true) {
        step = .complete
        isFinished = true
        defaults.removeObject(forKey: Self.resumeStepKey)
        if dismissSheet { permissions.dismissPermissionSheet() }
        errorMessage = nil
        onComplete()
    }
}
