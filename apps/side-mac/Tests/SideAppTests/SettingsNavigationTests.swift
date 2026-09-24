import Foundation
import XCTest
@testable import Side

final class SettingsNavigationTests: XCTestCase {
    private let policy = SettingsNavigationPolicy(localPort: 4_321)

    func testNativeSettingsWindowTitlesFollowSelectedLanguage() {
        XCTAssertEqual(SettingsRoute.settings.title(language: .ko), "Side 설정")
        XCTAssertEqual(SettingsRoute.settings.title(language: .en), "Side Settings")
        XCTAssertEqual(SettingsRoute.today.title(language: .ko), "오늘의 요약 — Side")
        XCTAssertEqual(SettingsRoute.today.title(language: .en), "Today's summary — Side")
    }

    func testSameOriginHashNavigationStaysInWebView() throws {
        // Given a link to another Side page on the authenticated loopback origin.
        let url = try XCTUnwrap(URL(string: "http://127.0.0.1:4321/#/history/2026-09-24"))

        // When the current web view receives the navigation.
        let action = policy.navigationAction(for: url, isUserLink: true, targetBlank: false)

        // Then the hash route remains in the existing WKWebView.
        XCTAssertEqual(action, .allowInWebView)
    }

    func testExternalHTTPSLinkOpensDefaultBrowser() throws {
        // Given a validated user link to a nonlocal HTTPS page.
        let url = try XCTUnwrap(URL(string: "https://example.test/article"))

        // When the current web view receives the navigation.
        let action = policy.navigationAction(for: url, isUserLink: true, targetBlank: false)

        // Then WebKit must cancel navigation and hand it to the system browser.
        XCTAssertEqual(action, .openInDefaultBrowser)
    }

    func testTargetBlankUsesUIDelegateForExternalAndLocalLinks() throws {
        // Given target=_blank links to a validated external URL and a local hash route.
        let external = try XCTUnwrap(URL(string: "https://example.test/article"))
        let local = try XCTUnwrap(URL(string: "http://127.0.0.1:4321/#/settings/context-awareness"))

        // When WebKit requests a new window for each link.
        let externalNavigation = policy.navigationAction(for: external, isUserLink: true, targetBlank: true)
        let localNavigation = policy.navigationAction(for: local, isUserLink: true, targetBlank: true)

        // Then the UI delegate opens external links in the browser and local links in the existing view.
        XCTAssertEqual(externalNavigation, .deferToUIDelegate)
        XCTAssertEqual(localNavigation, .deferToUIDelegate)
        XCTAssertEqual(policy.newWindowAction(for: external, isUserLink: true), .openInDefaultBrowser)
        XCTAssertEqual(policy.newWindowAction(for: local, isUserLink: true), .loadInWebView)
    }

    func testUnsafeSchemesAndAutomaticExternalNavigationAreCancelled() throws {
        // Given an unsafe scheme, a nonlocal HTTP origin and a local-looking HTTPS origin.
        let unsafe = try XCTUnwrap(URL(string: "javascript:alert(1)"))
        let file = try XCTUnwrap(URL(string: "file:///tmp/side-test"))
        let external = try XCTUnwrap(URL(string: "http://example.test/"))
        let wrongOrigin = try XCTUnwrap(URL(string: "https://127.0.0.1:4321/"))

        // When WebKit evaluates navigation without a user-activated link.
        let actions = [unsafe, file, external, wrongOrigin].map {
            policy.navigationAction(for: $0, isUserLink: false, targetBlank: false)
        }

        // Then none of these URLs navigate inside WKWebView or launch another application.
        XCTAssertEqual(actions, Array(repeating: .cancel, count: actions.count))
        XCTAssertEqual(policy.newWindowAction(for: unsafe, isUserLink: true), .cancel)
        XCTAssertEqual(policy.navigationAction(for: external, isUserLink: true, targetBlank: false),
                       .openInDefaultBrowser)
        XCTAssertEqual(policy.navigationAction(for: wrongOrigin, isUserLink: true, targetBlank: false),
                       .openInDefaultBrowser)
    }

    func testOnlyUserClickedPermissionPanesOpenSystemSettings() throws {
        let panes = ["Privacy_Accessibility", "Privacy_ListenEvent", "Privacy_ScreenCapture"]
        for pane in panes {
            let url = try XCTUnwrap(URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)"))
            XCTAssertEqual(policy.navigationAction(for: url, isUserLink: true, targetBlank: false), .openSystemSettings)
            XCTAssertEqual(policy.navigationAction(for: url, isUserLink: false, targetBlank: false), .cancel)
            XCTAssertEqual(policy.newWindowAction(for: url, isUserLink: true), .openSystemSettings)
        }
        let unrelated = try XCTUnwrap(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"))
        XCTAssertEqual(policy.navigationAction(for: unrelated, isUserLink: true, targetBlank: false), .cancel)
        XCTAssertEqual(policy.newWindowAction(for: unrelated, isUserLink: true), .cancel)
    }
}
