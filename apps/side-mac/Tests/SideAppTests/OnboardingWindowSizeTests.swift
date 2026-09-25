import AppKit
import SwiftUI
import XCTest
@testable import Side

@MainActor
final class OnboardingWindowSizeTests: XCTestCase {
    func testIntroCopyMatchesApprovedEnglishAndKorean() {
        XCTAssertEqual(OnboardingView.introTitle(language: .en), "Let Side remember your day")
        XCTAssertEqual(OnboardingView.introTitle(language: .ko), "Side가 하루를 기억하도록")
        XCTAssertEqual(OnboardingView.headerTitle(step: .intro, language: .en), "Let Side remember your day")
        XCTAssertEqual(OnboardingView.headerTitle(step: .accessibility, language: .en), "Set up Side")
        XCTAssertEqual(
            OnboardingView.introSubtitle(language: .en),
            "Everything stays on this Mac unless you choose a summary provider."
        )
    }

    func testHostingSmallContentKeepsReadableOnboardingWindowSize() {
        let window = OnboardingWindowController.makeWindow(rootView: Text("Small"))
        defer { window.close() }

        window.contentView?.layoutSubtreeIfNeeded()
        XCTAssertGreaterThanOrEqual(window.contentLayoutRect.width, 640)
        XCTAssertGreaterThanOrEqual(window.contentLayoutRect.height, 470)
    }

    func testOnboardingWindowTitleUsesSelectedLanguageWithoutChangingSize() {
        let window = OnboardingWindowController.makeWindow(rootView: Text("Small"), language: .en)
        defer { window.close() }

        XCTAssertEqual(window.title, "Set up Side")
        XCTAssertGreaterThanOrEqual(window.contentLayoutRect.width, 640)
        XCTAssertGreaterThanOrEqual(window.contentLayoutRect.height, 470)
    }
}
