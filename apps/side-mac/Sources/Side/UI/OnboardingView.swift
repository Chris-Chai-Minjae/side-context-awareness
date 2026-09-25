import AppKit
import SwiftUI

enum OnboardingProviderPreset: CaseIterable, Hashable {
    case xiaomiMiMo26Pro
    case miniMaxM3
    case openAI
    case codexLogin
    case claudeCode
    case custom

    var title: String {
        switch self {
        case .xiaomiMiMo26Pro: return "Xiaomi MiMo 2.6 Pro (Singapore Token Plan)"
        case .miniMaxM3: return "MiniMax M3"
        case .openAI: return "OpenAI"
        case .codexLogin: return "OpenAI (Codex login)"
        case .claudeCode: return "Claude Code"
        case .custom: return "Custom URL"
        }
    }

    func displayTitle(language: SideLanguage) -> String {
        switch self {
        case .xiaomiMiMo26Pro:
            return language.localized(
                "Xiaomi MiMo 2.6 Pro (Singapore Token Plan)",
                "Xiaomi MiMo 2.6 Pro (싱가포르 토큰 요금제)"
            )
        case .miniMaxM3, .openAI: return title
        case .codexLogin: return language.localized("OpenAI (Codex login)", "OpenAI (Codex 로그인)")
        case .claudeCode: return language.localized("Claude Code login", "Claude Code 로그인")
        case .custom: return language.localized("Custom URL", "직접 URL 입력")
        }
    }
}

struct OnboardingProviderDraft {
    private(set) var preset: OnboardingProviderPreset = .custom
    var name = ""
    var baseURL = ""
    var modelID = ""
    var apiKey = ""

    var supportsToolChoice: Bool { preset != .xiaomiMiMo26Pro && preset != .claudeCode && preset != .codexLogin }
    var kind: OnboardingProviderKind {
        switch preset {
        case .claudeCode: return .claudeCodeCLI
        case .codexLogin: return .codexCLI
        default: return .openAICompatible
        }
    }

    mutating func select(_ next: OnboardingProviderPreset) {
        preset = next
        apiKey = ""
        switch next {
        case .xiaomiMiMo26Pro:
            name = next.title
            baseURL = "https://token-plan-sgp.xiaomimimo.com/v1"
            modelID = "mimo-v2.6-pro"
        case .miniMaxM3:
            name = next.title
            baseURL = "https://api.minimax.io/v1"
            modelID = "MiniMax-M3"
        case .openAI:
            name = next.title
            baseURL = "https://api.openai.com/v1"
            modelID = ""
        case .codexLogin:
            name = next.title
            baseURL = ""
            modelID = "gpt-6-luna"
        case .claudeCode:
            name = next.title
            baseURL = ""
            modelID = ""
        case .custom:
            name = ""
            baseURL = ""
            modelID = ""
        }
    }
}

struct OnboardingView: View {
    @ObservedObject var flow: OnboardingFlow
    @State private var providerDraft = OnboardingProviderDraft()

    private var language: SideLanguage { flow.language }

    static func introTitle(language: SideLanguage) -> String {
        language.localized("Let Side remember your day", "Side가 하루를 기억하도록")
    }

    static func headerTitle(step: OnboardingStep, language: SideLanguage) -> String {
        step == .intro ? introTitle(language: language) : language.localized("Set up Side", "Side 설정")
    }

    static func introSubtitle(language: SideLanguage) -> String {
        language.localized(
            "Everything stays on this Mac unless you choose a summary provider.",
            "요약 제공자를 선택하지 않으면 모든 정보는 이 Mac에만 저장됩니다."
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            HStack {
                Text(Self.headerTitle(step: flow.step, language: language))
                    .font(.largeTitle.bold())
                Spacer()
                Picker(language.localized("Language", "언어"), selection: Binding(
                    get: { flow.language },
                    set: { next in Task { await flow.setLanguage(next) } }
                )) {
                    Text("한국어").tag(SideLanguage.ko)
                    Text("English").tag(SideLanguage.en)
                }
                .pickerStyle(.menu)
                .frame(width: 150)
                .disabled(!flow.isLoaded || flow.isWorking)
            }
            if flow.isLoaded {
                stepContent
            } else {
                ProgressView(language.localized("Connecting to Side…", "Side에 연결 중…"))
                if flow.errorMessage != nil {
                    Button(language.localized("Retry", "다시 시도")) { Task { try? await flow.load() } }
                }
            }
            if let error = flow.errorMessage {
                Text(error).foregroundStyle(.red)
                    .accessibilityIdentifier("onboarding-error")
            }
            Spacer(minLength: 0)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .task {
            while !Task.isCancelled && !flow.isFinished {
                try? await Task.sleep(nanoseconds: OnboardingFlow.permissionPollNanoseconds)
                guard !Task.isCancelled else { break }
                if flow.step.permissionKind != nil { await flow.pollPermissions() }
            }
        }
    }

    @ViewBuilder
    private var stepContent: some View {
        switch flow.step {
        case .intro:
            Text(Self.introSubtitle(language: language))
                .font(.title3)
            Button(language.localized("Continue", "계속")) { flow.continueFromIntro() }
                .buttonStyle(.borderedProminent)
        case .accessibility, .inputMonitoring, .screenRecording:
            permissionContent
        case .provider:
            providerContent
        case .finish:
            Text(language.localized(
                "Side is ready to capture activity on this Mac.",
                "Side가 이 Mac의 활동을 캡처할 준비가 되었습니다."
            ))
                .font(.title3)
            Button(language.localized("Enable Context Awareness", "Context Awareness 켜기")) {
                Task { await flow.enable() }
            }
                .buttonStyle(.borderedProminent)
                .disabled(flow.isWorking)
        case .complete:
            EmptyView()
        }
    }

    private var permissionContent: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(permissionTitle).font(.title2.bold())
            Text(permissionExplanation)
            HStack {
                Button(language.localized("Open System Settings", "시스템 설정 열기")) {
                    if let url = flow.step.settingsURL { NSWorkspace.shared.open(url) }
                    Task { await flow.requestCurrentPermission() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(flow.isWorking)
                if flow.step == .screenRecording {
                    Button(language.localized("Skip Screen Recording", "화면 기록 건너뛰기")) {
                        Task { await flow.skipScreenRecording() }
                    }
                    .disabled(flow.isWorking)
                }
            }
            Text(language.localized(
                "Side checks this permission every second and continues when access is granted.",
                "Side가 매초 권한을 확인하며, 허용되면 계속 진행합니다."
            ))
                .foregroundStyle(.secondary)
        }
    }

    private var providerContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text(language.localized("Add a summary provider", "요약 제공자 추가"))
                    .font(.title2.bold())
                Text(language.localized(
                    "You can skip this step. Capture will start, and summaries will wait for a provider.",
                    "이 단계를 건너뛸 수 있습니다. 캡처는 시작되고 요약은 제공자 설정을 기다립니다."
                ))
                    .foregroundStyle(.secondary)
                Text(language.localized(
                    "After saving a provider, enable Send evidence to this provider in Settings to start summaries.",
                    "요약을 시작하려면 제공자 저장 후 설정에서 '이 제공자에게 증거 보내기'를 켜세요."
                ))
                    .foregroundStyle(.secondary)
                Picker(language.localized("Provider", "제공자"), selection: Binding(
                    get: { providerDraft.preset },
                    set: { providerDraft.select($0) }
                )) {
                    ForEach(OnboardingProviderPreset.allCases, id: \.self) { preset in
                        Text(preset.displayTitle(language: language)).tag(preset)
                    }
                }
                TextField(language.localized("Name", "이름"), text: $providerDraft.name)
                if providerDraft.kind == .claudeCodeCLI {
                    Text(language.localized(
                        "Uses your existing Claude Code login. Enter a claude-* model ID. Summaries leave this Mac only after you allow evidence in Settings.",
                        "기존 Claude Code 로그인을 사용합니다. claude-* 모델 ID를 입력하세요. 요약은 설정에서 증거 전송을 허용한 뒤에만 이 Mac 밖으로 전송됩니다."
                    ))
                        .foregroundStyle(.secondary)
                } else if providerDraft.kind == .codexCLI {
                    Text(language.localized(
                        "Uses your existing Codex CLI ChatGPT login. No API key is needed. A login stored only in Keychain is not supported. Summaries reach OpenAI only after evidence consent in Settings. MiMo remains the recommended primary provider.",
                        "기존 Codex CLI ChatGPT 로그인을 사용합니다. API 키는 필요하지 않습니다. Keychain에만 저장된 로그인은 지원하지 않습니다. 설정에서 증거 전송을 허용한 뒤에만 요약을 OpenAI로 보냅니다. 기본 제공자로는 MiMo를 권장합니다."
                    ))
                        .foregroundStyle(.secondary)
                } else {
                    TextField(language.localized("Base URL", "기본 URL"), text: $providerDraft.baseURL)
                        .textContentType(.URL)
                    SecureField(language.localized("API key (if required)", "API 키 (필요한 경우)"), text: $providerDraft.apiKey)
                }
                if providerDraft.kind != .openAICompatible {
                    Text(language.localized(
                        "Using an existing CLI login is at your own risk. Check each provider's terms and usage limits.",
                        "기존 CLI 로그인 사용은 사용자 책임입니다. 각 제공자의 약관과 사용량 한도를 확인하세요."
                    ))
                        .foregroundStyle(.secondary)
                }
                TextField(
                    providerDraft.kind == .claudeCodeCLI
                        ? language.localized("Model ID (claude-…)", "모델 ID (claude-…)")
                        : language.localized("Model", "모델"),
                    text: $providerDraft.modelID
                )
                HStack {
                    Button(language.localized("Save and test", "저장 및 테스트")) {
                        Task {
                            await flow.submitProvider(
                                name: providerDraft.name, baseURL: providerDraft.baseURL,
                                apiKey: providerDraft.apiKey, modelID: providerDraft.modelID,
                                supportsToolChoice: providerDraft.supportsToolChoice,
                                kind: providerDraft.kind
                            )
                            providerDraft.apiKey = ""
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(flow.isWorking)
                    Button(language.localized("Skip provider", "제공자 건너뛰기")) {
                        Task { await flow.skipProvider() }
                    }
                    .disabled(flow.isWorking)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .textFieldStyle(.roundedBorder)
    }

    private var permissionTitle: String {
        switch flow.step {
        case .accessibility: return language.localized("Allow Accessibility", "손쉬운 사용 허용")
        case .inputMonitoring: return language.localized("Allow Input Monitoring", "입력 모니터링 허용")
        case .screenRecording: return language.localized("Allow Screen Recording", "화면 기록 허용")
        case .intro, .provider, .finish, .complete: return ""
        }
    }

    private var permissionExplanation: String {
        switch flow.step {
        case .accessibility:
            return language.localized(
                "Side uses Accessibility to observe the active window. Grant access in Privacy & Security.",
                "Side는 손쉬운 사용 권한으로 활성 창을 확인합니다. 개인정보 보호 및 보안에서 허용하세요."
            )
        case .inputMonitoring:
            return language.localized(
                "Side uses Input Monitoring to detect interaction metadata. Grant access in Privacy & Security.",
                "Side는 입력 모니터링 권한으로 상호작용 정보를 감지합니다. 개인정보 보호 및 보안에서 허용하세요."
            )
        case .screenRecording:
            return language.localized(
                "Screen Recording enables OCR when Accessibility cannot read a window. This step is optional.",
                "손쉬운 사용으로 창을 읽을 수 없을 때 화면 기록 권한으로 OCR을 사용할 수 있습니다. 선택 사항입니다."
            )
        case .intro, .provider, .finish, .complete:
            return ""
        }
    }
}
