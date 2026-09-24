import AppKit
import SwiftUI
import XCTest
@testable import Side

@MainActor
final class OnboardingWindowSizeTests: XCTestCase {
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
