import XCTest
@testable import Side

final class OnboardingProviderPresetTests: XCTestCase {
    func testPresetsAppearInRequestedOrderWithoutSelectingOneByDefault() {
        // Given a fresh provider form.
        let draft = OnboardingProviderDraft()

        // Then MiMo precedes MiniMax and OpenAI, while custom entry remains available.
        XCTAssertEqual(OnboardingProviderPreset.allCases, [
            .xiaomiMiMo26Pro, .miniMaxM3, .openAI, .codexLogin, .claudeCode, .custom,
        ])
        XCTAssertEqual(draft.preset, .custom)
        XCTAssertEqual(draft.name, "")
        XCTAssertEqual(draft.baseURL, "")
        XCTAssertEqual(draft.modelID, "")
    }

    func testSwitchingBetweenMiMoAndMiniMaxReplacesEndpointAndModelTogether() {
        // Given a fresh provider form.
        var draft = OnboardingProviderDraft()

        // When MiMo is selected.
        draft.select(.xiaomiMiMo26Pro)

        // Then its Singapore Token Plan endpoint and model are filled in.
        XCTAssertEqual(draft.name, "Xiaomi MiMo 2.6 Pro (Singapore Token Plan)")
        XCTAssertEqual(draft.baseURL, "https://token-plan-sgp.xiaomimimo.com/v1")
        XCTAssertEqual(draft.modelID, "mimo-v2.6-pro")

        // When a different provider is selected, none of MiMo's values carry over.
        draft.select(.miniMaxM3)
        XCTAssertEqual(draft.name, "MiniMax M3")
        XCTAssertEqual(draft.baseURL, "https://api.minimax.io/v1")
        XCTAssertEqual(draft.modelID, "MiniMax-M3")
    }

    func testSwitchingProviderClearsPreviousProviderKey() {
        // Given a key entered for MiMo in the provider form.
        var draft = OnboardingProviderDraft()
        draft.select(.xiaomiMiMo26Pro)
        draft.apiKey = "synthetic-key"

        // When a different provider is selected, its endpoint must not inherit that key.
        draft.select(.miniMaxM3)

        // Then the password field is blank before Save and test can be used.
        XCTAssertEqual(draft.apiKey, "")
    }

    func testOpenAIUsesItsEndpointAndRequiresManualModelEntry() {
        // Given a model-filled preset.
        var draft = OnboardingProviderDraft()
        draft.select(.miniMaxM3)

        // When OpenAI is selected.
        draft.select(.openAI)

        // Then the previous model is cleared so the user can enter an OpenAI model.
        XCTAssertEqual(draft.name, "OpenAI")
        XCTAssertEqual(draft.baseURL, "https://api.openai.com/v1")
        XCTAssertEqual(draft.modelID, "")
        draft.modelID = "chosen-model"
        XCTAssertEqual(draft.modelID, "chosen-model")
    }

    func testCustomSelectionClearsPresetValuesForManualEntry() {
        // Given a filled preset.
        var draft = OnboardingProviderDraft()
        draft.select(.xiaomiMiMo26Pro)

        // When the user chooses Custom URL.
        draft.select(.custom)

        // Then every provider field is available for manual entry.
        XCTAssertEqual(draft.name, "")
        XCTAssertEqual(draft.baseURL, "")
        XCTAssertEqual(draft.modelID, "")
        draft.name = "Private endpoint"
        draft.baseURL = "https://example.invalid/v1"
        draft.modelID = "custom-model"
        XCTAssertEqual(draft.name, "Private endpoint")
        XCTAssertEqual(draft.baseURL, "https://example.invalid/v1")
        XCTAssertEqual(draft.modelID, "custom-model")
    }

    func testClaudeCodePresetUsesExistingLoginAndExplicitModel() {
        var draft = OnboardingProviderDraft()
        draft.select(.openAI)
        draft.apiKey = "synthetic-key"

        draft.select(.claudeCode)

        XCTAssertEqual(draft.name, "Claude Code")
        XCTAssertEqual(draft.baseURL, "")
        XCTAssertEqual(draft.apiKey, "")
        XCTAssertEqual(draft.modelID, "")
        XCTAssertEqual(draft.kind, .claudeCodeCLI)
        XCTAssertFalse(draft.supportsToolChoice)
        XCTAssertEqual(OnboardingProviderPreset.claudeCode.displayTitle(language: .ko), "Claude Code 로그인")
    }

    func testCodexPresetUsesExistingLoginAndKeepsManualOpenAI() {
        var draft = OnboardingProviderDraft()
        draft.select(.openAI)
        XCTAssertEqual(draft.baseURL, "https://api.openai.com/v1")
        draft.apiKey = "synthetic-key"

        draft.select(.codexLogin)

        XCTAssertEqual(draft.name, "OpenAI (Codex login)")
        XCTAssertEqual(draft.baseURL, "")
        XCTAssertEqual(draft.apiKey, "")
        XCTAssertEqual(draft.modelID, "gpt-6-luna")
        XCTAssertEqual(draft.kind, .codexCLI)
        XCTAssertFalse(draft.supportsToolChoice)
        XCTAssertEqual(OnboardingProviderPreset.codexLogin.displayTitle(language: .ko), "OpenAI (Codex 로그인)")
    }
}
