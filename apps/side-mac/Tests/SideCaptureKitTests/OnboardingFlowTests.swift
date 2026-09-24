import Foundation
import SideCaptureKit
import XCTest
@testable import Side

private struct OnboardingPermissionProbe: PermissionProbing {
    func accessibility(prompt: Bool) -> Bool { false }
    func inputMonitoring(request: Bool) -> Bool { false }
    func screenRecording(request: Bool) -> Bool { false }
    func automation(bundleID: String, request: Bool) -> Bool { false }
}

@MainActor
private final class FakeOnboardingService: OnboardingService {
    var settings = OnboardingSettings(enabled: false, screenOCR: true, providers: [])
    var permissions = OnboardingPermissions(
        accessibility: false, inputMonitoring: false, screenRecording: false
    )
    var testResult = OnboardingProviderTest(ok: true, error: nil)
    var failEnable = false
    var calls: [String] = []
    var suspendRequest = false
    var requestContinuation: CheckedContinuation<OnboardingPermissions, Never>?
    var requestStarted: XCTestExpectation?

    func getSettings() async throws -> OnboardingSettings { settings }
    func setLanguage(_ language: SideLanguage) async throws -> OnboardingSettings {
        calls.append("language:\(language.rawValue)")
        settings = OnboardingSettings(
            enabled: settings.enabled, screenOCR: settings.screenOCR,
            providers: settings.providers, language: language
        )
        return settings
    }
    func getPermissions() async throws -> OnboardingPermissions { permissions }
    func request(_ kind: PermissionKind) async throws -> OnboardingPermissions {
        calls.append("request:\(kind.rawValue)")
        if suspendRequest {
            return await withCheckedContinuation {
                requestContinuation = $0
                requestStarted?.fulfill()
            }
        }
        return permissions
    }
    func setScreenOCR(_ enabled: Bool) async throws -> OnboardingSettings {
        calls.append("screenOCR:\(enabled)")
        settings = OnboardingSettings(
            enabled: settings.enabled, screenOCR: enabled,
            providers: settings.providers, language: settings.language
        )
        return settings
    }
    func saveProviders(_ providers: [OnboardingProvider]) async throws -> OnboardingSettings {
        calls.append("providers")
        settings = OnboardingSettings(
            enabled: settings.enabled, screenOCR: settings.screenOCR,
            providers: providers, language: settings.language
        )
        return settings
    }
    func setKey(providerID: String, apiKey: String) async throws {
        calls.append("setKey:\(providerID)")
    }
    func testProvider(providerID: String, modelID: String) async throws -> OnboardingProviderTest {
        calls.append("test:\(providerID):\(modelID)")
        return testResult
    }
    func selectSummaryModel(providerID: String, modelID: String) async throws -> OnboardingSettings {
        calls.append("select:\(providerID):\(modelID)")
        return settings
    }
    func clearSummaryModel() async throws -> OnboardingSettings {
        calls.append("clearModel")
        return settings
    }
    func setEnabled(_ enabled: Bool) async throws -> OnboardingSettings {
        calls.append("enabled:\(enabled)")
        if failEnable { throw NSError(domain: "synthetic", code: 1) }
        settings = OnboardingSettings(
            enabled: enabled, screenOCR: settings.screenOCR,
            providers: settings.providers, language: settings.language
        )
        return settings
    }
}

@MainActor
private final class FakeOnboardingMenuService: MenuBarServicing {
    var status = MenuCaptureStatus(enabled: false, state: .stopped, pausedUntil: nil, banner: .notRunning)
    var fetchCount = 0
    var fetched: XCTestExpectation?

    func fetchStatus() async throws -> MenuCaptureStatus {
        fetchCount += 1
        fetched?.fulfill()
        return status
    }

    func pause(_ option: MenuPauseOption) async throws {}
    func resume() async throws {}
}

@MainActor
final class OnboardingFlowTests: XCTestCase {
    private func makeDefaults() -> UserDefaults {
        UserDefaults(suiteName: "SideOnboardingTests.\(UUID().uuidString)")!
    }

    private func makeFlow(
        service: FakeOnboardingService, defaults: UserDefaults, onComplete: @escaping () -> Void = {}
    ) -> (OnboardingFlow, PermissionCoordinator) {
        let coordinator = PermissionCoordinator(probe: OnboardingPermissionProbe(), defaults: defaults)
        let flow = OnboardingFlow(
            service: service, permissions: coordinator, defaults: defaults, onComplete: onComplete
        )
        return (flow, coordinator)
    }

    func testEnableRefreshesCachedMenuImmediatelyAfterSuccess() async throws {
        // Given an onboarding finish step and a menu status cached inside its 30-second window.
        let defaults = makeDefaults()
        let service = FakeOnboardingService()
        service.permissions = OnboardingPermissions(accessibility: true, inputMonitoring: true, screenRecording: true)
        let menuService = FakeOnboardingMenuService()
        let menuState = MenuBarState(service: menuService)
        await menuState.refresh()
        XCTAssertEqual(menuService.fetchCount, 1)
        let controller = OnboardingWindowController()
        let permissions = PermissionCoordinator(probe: OnboardingPermissionProbe(), defaults: defaults)
        let flow = controller.makeFlow(service: service, permissions: permissions, menuState: menuState)
        try await flow.load()
        flow.continueFromIntro()
        await flow.skipProvider()
        menuService.status = MenuCaptureStatus(enabled: true, state: .running, pausedUntil: nil, banner: .none)
        let fetched = expectation(description: "menu refreshed after enable")
        menuService.fetched = fetched

        // When Enable succeeds.
        await flow.enable()
        await fulfillment(of: [fetched], timeout: 2)

        // Then the shared menu state sees running without waiting for cache expiry or menu open.
        XCTAssertEqual(menuService.fetchCount, 2)
        XCTAssertEqual(menuState.display.text, "캡처 중")
        XCTAssertTrue(flow.isFinished)
    }

    func testEnableFailureDoesNotRefreshMenu() async throws {
        // Given an onboarding finish step whose enable patch fails.
        let defaults = makeDefaults()
        let service = FakeOnboardingService()
        service.permissions = OnboardingPermissions(accessibility: true, inputMonitoring: true, screenRecording: true)
        service.failEnable = true
        let menuService = FakeOnboardingMenuService()
        let menuState = MenuBarState(service: menuService)
        let controller = OnboardingWindowController()
        let permissions = PermissionCoordinator(probe: OnboardingPermissionProbe(), defaults: defaults)
        let flow = controller.makeFlow(service: service, permissions: permissions, menuState: menuState)
        try await flow.load()
        flow.continueFromIntro()
        await flow.skipProvider()

        // When Enable fails.
        await flow.enable()

        // Then the sheet remains at Finish and no menu status fetch is scheduled.
        XCTAssertEqual(flow.step, .finish)
        XCTAssertFalse(flow.isFinished)
        XCTAssertNotNil(flow.errorMessage)
        XCTAssertEqual(menuService.fetchCount, 0)
    }

    func testAlreadyEnabledStartupDoesNotRefreshMenuFromOnboarding() async throws {
        // Given settings that were already enabled before the onboarding flow loaded.
        let service = FakeOnboardingService()
        service.settings = OnboardingSettings(
            enabled: true, screenOCR: true, providers: [], language: .en
        )
        let menuService = FakeOnboardingMenuService()
        let menuState = MenuBarState(service: menuService)
        let controller = OnboardingWindowController()
        let defaults = makeDefaults()
        let permissions = PermissionCoordinator(probe: OnboardingPermissionProbe(), defaults: defaults)
        let flow = controller.makeFlow(service: service, permissions: permissions, menuState: menuState)

        // When startup loads an already enabled setting.
        try await flow.load()

        // Then onboarding completes without triggering an extra menu fetch.
        XCTAssertTrue(flow.isFinished)
        XCTAssertEqual(menuState.language, .en)
        XCTAssertEqual(menuService.fetchCount, 0)
    }

    func testOnboardingLanguageSelectionUpdatesMenuBeforeItOpens() async throws {
        let service = FakeOnboardingService()
        let menuState = MenuBarState(service: FakeOnboardingMenuService())
        let controller = OnboardingWindowController()
        let permissions = PermissionCoordinator(probe: OnboardingPermissionProbe(), defaults: makeDefaults())
        let flow = controller.makeFlow(service: service, permissions: permissions, menuState: menuState)
        try await flow.load()

        await flow.setLanguage(.en)

        XCTAssertEqual(menuState.language, .en)
        XCTAssertEqual(menuState.display.text, "Capture is not running")
    }

    func testIntroContinuesToAccessibilityAndReportsVisibleSheet() async throws {
        // Given no permission is granted and onboarding is new.
        let service = FakeOnboardingService()
        let (flow, coordinator) = makeFlow(service: service, defaults: makeDefaults())
        try await flow.load()

        // When the introduction is acknowledged.
        flow.continueFromIntro()

        // Then the first required permission is active and health reports the sheet.
        XCTAssertEqual(flow.step, .accessibility)
        XCTAssertTrue(coordinator.permissionSheetVisible)
    }

    func testPermissionPollingAdvancesThroughRequiredAndOptionalSteps() async throws {
        // Given the permission journey has started.
        let service = FakeOnboardingService()
        let (flow, _) = makeFlow(service: service, defaults: makeDefaults())
        try await flow.load()
        flow.continueFromIntro()

        // When the required permissions and then Screen Recording become granted.
        service.permissions = OnboardingPermissions(accessibility: true, inputMonitoring: false, screenRecording: false)
        await flow.pollPermissions()
        XCTAssertEqual(flow.step, .inputMonitoring)
        service.permissions = OnboardingPermissions(accessibility: true, inputMonitoring: true, screenRecording: false)
        await flow.pollPermissions()
        XCTAssertEqual(flow.step, .screenRecording)
        service.permissions = OnboardingPermissions(accessibility: true, inputMonitoring: true, screenRecording: true)
        await flow.pollPermissions()

        // Then provider setup is reached automatically.
        XCTAssertEqual(flow.step, .provider)
        XCTAssertEqual(OnboardingFlow.permissionPollInterval, 1)
    }

    func testScreenRecordingSkipPersistsDisabledOCRBeforeProvider() async throws {
        // Given required permissions are granted and optional Screen Recording is not.
        let service = FakeOnboardingService()
        service.permissions = OnboardingPermissions(accessibility: true, inputMonitoring: true, screenRecording: false)
        let (flow, _) = makeFlow(service: service, defaults: makeDefaults())
        try await flow.load()
        flow.continueFromIntro()
        XCTAssertEqual(flow.step, .screenRecording)

        // When Screen Recording is skipped.
        await flow.skipScreenRecording()

        // Then the daemon setting is disabled before provider setup opens.
        XCTAssertEqual(service.calls, ["screenOCR:false"])
        XCTAssertFalse(service.settings.screenOCR)
        XCTAssertEqual(flow.step, .provider)
    }

    func testRestartResumesAtProviderAfterScreenRecordingGrant() async throws {
        // Given the permission sheet reached Screen Recording before an app restart.
        let defaults = makeDefaults()
        let service = FakeOnboardingService()
        service.permissions = OnboardingPermissions(accessibility: true, inputMonitoring: true, screenRecording: false)
        let (first, _) = makeFlow(service: service, defaults: defaults)
        try await first.load()
        first.continueFromIntro()
        XCTAssertEqual(first.step, .screenRecording)

        // When the app starts again with Screen Recording granted.
        service.permissions = OnboardingPermissions(accessibility: true, inputMonitoring: true, screenRecording: true)
        let (resumed, coordinator) = makeFlow(service: service, defaults: defaults)
        try await resumed.load()

        // Then the same sheet resumes at provider setup.
        XCTAssertEqual(resumed.step, .provider)
        XCTAssertTrue(coordinator.permissionSheetVisible)
    }

    func testProviderSkipThenEnableStartsCaptureWithoutModel() async throws {
        // Given all permissions are granted and provider setup is reached.
        let service = FakeOnboardingService()
        service.permissions = OnboardingPermissions(accessibility: true, inputMonitoring: true, screenRecording: true)
        let defaults = makeDefaults()
        var completed = false
        let (flow, coordinator) = makeFlow(service: service, defaults: defaults) { completed = true }
        try await flow.load()
        flow.continueFromIntro()

        // When provider setup is skipped and capture is enabled.
        await flow.skipProvider()
        await flow.enable()

        // Then only enabled is patched and the private sheet state is cleared.
        XCTAssertEqual(service.calls, ["clearModel", "enabled:true"])
        XCTAssertTrue(service.settings.enabled)
        XCTAssertTrue(completed)
        XCTAssertFalse(coordinator.permissionSheetVisible)
        XCTAssertNil(defaults.string(forKey: OnboardingFlow.resumeStepKey))
    }

    func testProviderSetupSavesKeyTestsThenSelectsModel() async throws {
        // Given provider setup and an existing provider that must be preserved.
        let service = FakeOnboardingService()
        service.permissions = OnboardingPermissions(accessibility: true, inputMonitoring: true, screenRecording: true)
        service.settings = OnboardingSettings(enabled: false, screenOCR: true, providers: [
            OnboardingProvider(id: "existing", baseURL: "http://localhost:11434/v1", models: ["old"], supportsToolChoice: false, allowEvidence: false),
        ])
        let (flow, _) = makeFlow(service: service, defaults: makeDefaults())
        try await flow.load()
        flow.continueFromIntro()

        // When a synthetic provider is submitted.
        await flow.submitProvider(name: "Example", baseURL: "https://example.invalid/v1", apiKey: "synthetic-test-key", modelID: "model-1")

        // Then the provider is preserved, the probe precedes model selection, and evidence stays off.
        XCTAssertEqual(service.calls, ["providers", "setKey:Example", "test:Example:model-1", "select:Example:model-1"])
        XCTAssertEqual(service.settings.providers.map(\.id), ["existing", "Example"])
        XCTAssertFalse(service.settings.providers.last!.allowEvidence)
        XCTAssertEqual(flow.step, .finish)
    }

    func testMiMoPresetDoesNotForceUnsupportedToolChoice() async throws {
        let service = FakeOnboardingService()
        service.permissions = OnboardingPermissions(accessibility: true, inputMonitoring: true, screenRecording: true)
        let (flow, _) = makeFlow(service: service, defaults: makeDefaults())
        try await flow.load()
        flow.continueFromIntro()

        var draft = OnboardingProviderDraft()
        draft.select(.xiaomiMiMo26Pro)
        await flow.submitProvider(
            name: draft.name, baseURL: draft.baseURL, apiKey: "",
            modelID: draft.modelID, supportsToolChoice: draft.supportsToolChoice
        )

        XCTAssertEqual(service.settings.providers.last?.supportsToolChoice, false)
        XCTAssertEqual(flow.step, .finish)
    }

    func testProviderProbeFailureKeepsSelectionUnchanged() async throws {
        // Given provider setup with a probe that reports failure.
        let service = FakeOnboardingService()
        service.permissions = OnboardingPermissions(accessibility: true, inputMonitoring: true, screenRecording: true)
        service.testResult = OnboardingProviderTest(ok: false, error: "Provider test failed")
        let (flow, _) = makeFlow(service: service, defaults: makeDefaults())
        try await flow.load()
        flow.continueFromIntro()

        // When the synthetic provider is submitted.
        await flow.submitProvider(name: "Example", baseURL: "https://example.invalid/v1", apiKey: "synthetic-test-key", modelID: "model-1")

        // Then onboarding stays on provider setup without selecting the failed model.
        XCTAssertEqual(flow.step, .provider)
        XCTAssertFalse(service.calls.contains { $0.hasPrefix("select:") })
        XCTAssertEqual(
            flow.errorMessage,
            "제공자 연결 테스트에 실패했습니다. 세부 정보를 확인한 뒤 다시 시도하세요."
        )
    }

    func testUnexpectedProviderErrorIsNotShownWithPotentialSecret() async throws {
        let service = FakeOnboardingService()
        service.permissions = OnboardingPermissions(
            accessibility: true, inputMonitoring: true, screenRecording: true
        )
        service.testResult = OnboardingProviderTest(ok: false, error: "synthetic-secret")
        let (flow, _) = makeFlow(service: service, defaults: makeDefaults())
        try await flow.load()
        flow.continueFromIntro()

        await flow.submitProvider(
            name: "Example", baseURL: "https://example.invalid/v1", apiKey: "",
            modelID: "model-1"
        )

        XCTAssertEqual(
            flow.errorMessage,
            "제공자 연결 테스트에 실패했습니다. 세부 정보를 확인한 뒤 다시 시도하세요."
        )
        XCTAssertFalse(flow.errorMessage?.contains("synthetic-secret") == true)
    }

    func testEnglishLanguageUsesEnglishProviderValidation() async throws {
        let service = FakeOnboardingService()
        service.settings = OnboardingSettings(
            enabled: false, screenOCR: true, providers: [], language: .en
        )
        service.permissions = OnboardingPermissions(
            accessibility: true, inputMonitoring: true, screenRecording: true
        )
        let (flow, _) = makeFlow(service: service, defaults: makeDefaults())
        try await flow.load()
        flow.continueFromIntro()

        await flow.submitProvider(
            name: "Example", baseURL: "https://user:synthetic-secret@example.invalid/v1",
            apiKey: "", modelID: "model-1"
        )

        XCTAssertEqual(
            flow.errorMessage,
            "Enter a name, HTTP or HTTPS Base URL without credentials or query, and model."
        )
        XCTAssertTrue(service.calls.isEmpty)
    }

    func testSavedEnglishLanguageLoadsAndKoreanSelectionPersists() async throws {
        let service = FakeOnboardingService()
        service.settings = OnboardingSettings(
            enabled: false, screenOCR: true, providers: [], language: .en
        )
        let (flow, _) = makeFlow(service: service, defaults: makeDefaults())

        try await flow.load()
        XCTAssertEqual(flow.language, .en)

        await flow.setLanguage(.ko)
        XCTAssertEqual(service.calls, ["language:ko"])
        XCTAssertEqual(flow.language, .ko)
        XCTAssertEqual(service.settings.language, .ko)
    }

    func testKoreanProviderValidationBlocksCredentialURL() async throws {
        let service = FakeOnboardingService()
        service.permissions = OnboardingPermissions(
            accessibility: true, inputMonitoring: true, screenRecording: true
        )
        let (flow, _) = makeFlow(service: service, defaults: makeDefaults())
        try await flow.load()
        flow.continueFromIntro()

        await flow.submitProvider(
            name: "Example", baseURL: "https://user:synthetic-secret@example.invalid/v1",
            apiKey: "", modelID: "model-1"
        )

        XCTAssertEqual(flow.errorMessage, "이름, 자격 증명과 쿼리가 없는 HTTP 또는 HTTPS 기본 URL, 모델을 입력하세요.")
        XCTAssertTrue(service.calls.isEmpty)
    }

    func testClaudeCodeLoginProviderTestsAndSelectsExplicitModelWithoutKey() async throws {
        let service = FakeOnboardingService()
        service.permissions = OnboardingPermissions(
            accessibility: true, inputMonitoring: true, screenRecording: true
        )
        let (flow, _) = makeFlow(service: service, defaults: makeDefaults())
        try await flow.load()
        flow.continueFromIntro()

        await flow.submitProvider(
            name: "Claude Code", baseURL: "", apiKey: "", modelID: "claude-sonnet-4-6",
            kind: .claudeCodeCLI
        )

        XCTAssertEqual(service.calls, [
            "providers", "test:Claude Code:claude-sonnet-4-6", "select:Claude Code:claude-sonnet-4-6",
        ])
        XCTAssertEqual(service.settings.providers.last?.kind, .claudeCodeCLI)
        XCTAssertNil(service.settings.providers.last?.baseURL)
        XCTAssertEqual(service.settings.providers.last?.models, ["claude-sonnet-4-6"])
        XCTAssertFalse(service.settings.providers.last!.allowEvidence)
        XCTAssertEqual(flow.step, .finish)
    }

    func testClaudeCodeLoginRejectsInvalidModelAndUnexpectedKeyBeforeSaving() async throws {
        let service = FakeOnboardingService()
        service.permissions = OnboardingPermissions(
            accessibility: true, inputMonitoring: true, screenRecording: true
        )
        let (flow, _) = makeFlow(service: service, defaults: makeDefaults())
        try await flow.load()
        flow.continueFromIntro()

        await flow.submitProvider(
            name: "Claude Code", baseURL: "", apiKey: "", modelID: "sonnet",
            kind: .claudeCodeCLI
        )
        XCTAssertEqual(flow.errorMessage, "claude-로 시작하는 명시적인 Claude Code 모델 ID를 입력하세요.")

        await flow.submitProvider(
            name: "Claude Code", baseURL: "", apiKey: "synthetic-key",
            modelID: "claude-sonnet-4-6", kind: .claudeCodeCLI
        )
        XCTAssertTrue(service.calls.isEmpty)
    }

    func testProviderURLCredentialsNeverEnterSettingsPatch() async throws {
        // Given provider setup with a URL that embeds a credential.
        let service = FakeOnboardingService()
        service.permissions = OnboardingPermissions(accessibility: true, inputMonitoring: true, screenRecording: true)
        let (flow, _) = makeFlow(service: service, defaults: makeDefaults())
        try await flow.load()
        flow.continueFromIntro()

        // When the provider form is submitted.
        await flow.submitProvider(
            name: "Example", baseURL: "https://user:synthetic-secret@example.invalid/v1",
            apiKey: "", modelID: "model-1"
        )

        // Then no provider configuration containing that credential is sent.
        XCTAssertTrue(service.calls.isEmpty)
        XCTAssertEqual(flow.step, .provider)
    }

    func testProviderURLQueryNeverEntersSettingsPatch() async throws {
        // Given provider setup with a credential-like query parameter.
        let service = FakeOnboardingService()
        service.permissions = OnboardingPermissions(accessibility: true, inputMonitoring: true, screenRecording: true)
        let (flow, _) = makeFlow(service: service, defaults: makeDefaults())
        try await flow.load()
        flow.continueFromIntro()

        // When the provider form is submitted.
        await flow.submitProvider(
            name: "Example", baseURL: "https://example.invalid/v1?api_key=synthetic-secret",
            apiKey: "", modelID: "model-1"
        )

        // Then the URL is rejected before it reaches daemon settings.
        XCTAssertTrue(service.calls.isEmpty)
        XCTAssertEqual(flow.step, .provider)
    }

    func testPermissionDeepLinksUsePrivacyPanes() {
        // Given each native permission step.
        // When its System Settings link is calculated.
        // Then the URL selects the matching privacy pane.
        XCTAssertEqual(OnboardingStep.accessibility.settingsURL?.absoluteString, "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        XCTAssertEqual(OnboardingStep.inputMonitoring.settingsURL?.absoluteString, "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")
        XCTAssertEqual(OnboardingStep.screenRecording.settingsURL?.absoluteString, "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
    }

    func testPollingContinuesWhilePermissionRequestIsOutstanding() async throws {
        // Given an Accessibility request that has not returned from the helper.
        let service = FakeOnboardingService()
        service.suspendRequest = true
        let started = expectation(description: "permission request started")
        service.requestStarted = started
        let (flow, _) = makeFlow(service: service, defaults: makeDefaults())
        try await flow.load()
        flow.continueFromIntro()
        let request = Task { await flow.requestCurrentPermission() }
        await fulfillment(of: [started], timeout: 2)

        // When the next permission poll sees that Accessibility was granted.
        service.permissions = OnboardingPermissions(accessibility: true, inputMonitoring: false, screenRecording: false)
        await flow.pollPermissions()

        // Then the flow advances without waiting for the original request to finish.
        XCTAssertEqual(flow.step, .inputMonitoring)
        service.requestContinuation?.resume(returning: OnboardingPermissions(
            accessibility: false, inputMonitoring: false, screenRecording: false
        ))
        await request.value
        XCTAssertEqual(flow.step, .inputMonitoring)
    }

    func testEnabledInstallDoesNotDismissUnrelatedPermissionSheet() async throws {
        // Given an already enabled install whose runtime is showing a native permission sheet.
        let service = FakeOnboardingService()
        service.settings = OnboardingSettings(enabled: true, screenOCR: true, providers: [])
        let (flow, coordinator) = makeFlow(service: service, defaults: makeDefaults())
        coordinator.presentPermissionSheet()

        // When onboarding checks whether this is a first launch.
        try await flow.load()

        // Then no onboarding window is needed and the runtime's sheet state remains intact.
        XCTAssertTrue(flow.isFinished)
        XCTAssertTrue(coordinator.permissionSheetVisible)
    }

    func testOpeningOnboardingPublishesVisibleSheetInHelperHealth() async throws {
        // Given a running health monitor and a new onboarding flow.
        let service = FakeOnboardingService()
        let (flow, coordinator) = makeFlow(service: service, defaults: makeDefaults())
        var frames: [Data] = []
        let monitor = HelperHealthMonitor(
            permissions: coordinator, sample: { HelperHealth() }, send: { frames.append($0) }
        )
        try monitor.refresh()

        // When onboarding opens.
        try await flow.load()

        // Then the next health frame reports the permission sheet as visible.
        let frame = try XCTUnwrap(frames.last)
        let envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: frame) as? [String: Any])
        let health = try XCTUnwrap(envelope["health"] as? [String: Any])
        XCTAssertEqual(health["permissionSheetVisible"] as? Bool, true)
    }
}
