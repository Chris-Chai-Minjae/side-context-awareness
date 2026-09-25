import Foundation
import XCTest
@testable import Side

@MainActor
private final class FakeMenuService: MenuBarServicing {
    var status = MenuCaptureStatus(enabled: true, state: .running, pausedUntil: nil, banner: .none)
    var fetchCount = 0
    var pauses: [MenuPauseOption] = []
    var resumeCount = 0

    func fetchStatus() async throws -> MenuCaptureStatus {
        fetchCount += 1
        return status
    }

    func pause(_ option: MenuPauseOption) async throws {
        pauses.append(option)
        status = MenuCaptureStatus(
            enabled: true, state: .paused,
            pausedUntil: option == .untilIResume ? 9_007_199_254_740_991 : 1_800_000,
            banner: .none
        )
    }

    func resume() async throws {
        resumeCount += 1
        status = MenuCaptureStatus(enabled: true, state: .running, pausedUntil: nil, banner: .none)
    }
}

@MainActor
final class MenuStateTests: XCTestCase {
    func testUnlockKeychainActionOnlyAppearsWhileLocked() {
        XCTAssertEqual(SupervisorState.keychainLocked.unlockKeychainTitle(language: .en), "Unlock Keychain…")
        XCTAssertEqual(SupervisorState.keychainLocked.unlockKeychainTitle(language: .ko), "Keychain 허용…")
        for state: SupervisorState in [.stopped, .starting, .running, .waitingToRestart(1), .captureNotRunning] {
            XCTAssertNil(state.unlockKeychainTitle(language: .en))
        }
    }

    func testMenuKoreanMatchesWebCopy() {
        let paused = MenuCaptureStatus(enabled: true, state: .paused, pausedUntil: 9_007_199_254_740_991, banner: .none)
        XCTAssertEqual(MenuDisplay(status: paused, language: .ko).text, "직접 재개할 때까지 일시정지됨")
        XCTAssertEqual(MenuPauseOption.untilIResume.title(language: .ko), "직접 재개할 때까지")
        XCTAssertEqual(MenuBarView.pauseTitle(language: .ko), "일시정지")
        XCTAssertEqual(MenuBarView.resumeTitle(language: .ko), "재개")
    }

    func testFiveStatusStringsAndThreeIconsWhenCaptureStateChanges() {
        // Given five approved capture states at a fixed local time.
        let timezone = TimeZone(secondsFromGMT: 0)!
        let cases: [(MenuCaptureStatus, String, String)] = [
            (.init(enabled: true, state: .running, pausedUntil: nil, banner: .none),
             "Capturing", "circle.fill"),
            (.init(enabled: true, state: .paused, pausedUntil: 1_800_000, banner: .none),
             "Paused until 00:30", "pause.circle.fill"),
            (.init(enabled: true, state: .paused, pausedUntil: 9_007_199_254_740_991, banner: .none),
             "Paused until you resume", "pause.circle.fill"),
            (.init(enabled: true, state: .stopped, pausedUntil: nil, banner: .notRunning),
             "Capture is not running", "exclamationmark.triangle.fill"),
            (.init(enabled: true, state: .paused, pausedUntil: nil, banner: .permissionsNeeded),
             "Permissions needed", "exclamationmark.triangle.fill"),
        ]

        // When each status is mapped to a menu display.
        let displays = cases.map { MenuDisplay(status: $0.0, language: .en, timeZone: timezone) }

        // Then the exact five strings and three icons match the spec.
        XCTAssertEqual(displays.map(\.text), cases.map(\.1))
        XCTAssertEqual(displays.map(\.systemImage), cases.map(\.2))
        XCTAssertEqual(Set(displays.map(\.systemImage)).count, 3)
    }

    func testThirtySecondCacheAndMenuOpenForcesStatusRefresh() async {
        // Given a loaded menu state and a controllable clock.
        let service = FakeMenuService()
        var now = Date(timeIntervalSince1970: 100)
        let model = MenuBarState(service: service, now: { now })
        await model.refresh()
        now.addTimeInterval(29)

        // When the periodic refresh fires before expiry, then the cached value is used.
        await model.refresh()
        XCTAssertEqual(service.fetchCount, 1)
        now.addTimeInterval(1)
        await model.refresh()
        XCTAssertEqual(service.fetchCount, 2)

        // When the menu opens before the next expiry, then status is fetched immediately.
        now.addTimeInterval(1)
        await model.menuDidOpen()
        XCTAssertEqual(service.fetchCount, 3)
    }

    func testPauseOptionsAndResumeRefreshTheVisibleState() async {
        // Given the four approved pause choices and a running service.
        let service = FakeMenuService()
        let model = MenuBarState(service: service)
        XCTAssertEqual(MenuPauseOption.allCases.map { $0.title(language: .en) }, [
            "15 minutes", "30 minutes", "1 hour", "Until I resume",
        ])

        // When pause is selected, then the daemon call and a fresh status update occur.
        await model.pause(.thirtyMinutes)
        XCTAssertEqual(service.pauses, [.thirtyMinutes])
        XCTAssertTrue(model.display.isPaused)
        XCTAssertEqual(service.fetchCount, 1)

        // When resume is selected, then the daemon call and a fresh status update occur.
        await model.resume()
        XCTAssertEqual(service.resumeCount, 1)
        XCTAssertFalse(model.display.isPaused)
        XCTAssertEqual(service.fetchCount, 2)
    }

    func testDaemonFailureShowsErrorStatusWhenMenuOpens() async {
        // Given a menu service with a daemon that cannot be reached.
        let service = FailingMenuService()
        let model = MenuBarState(service: service)

        // When the menu opens, then the error state is visible.
        await model.menuDidOpen()
        XCTAssertEqual(model.display.text, "캡처가 실행 중이지 않습니다")
        XCTAssertEqual(model.display.systemImage, "exclamationmark.triangle.fill")
    }

    func testSettingsSessionBootstrapsBothRoutesWithoutExternalTokenLeak() throws {
        // Given an in-memory session and a fixed local day.
        let session = try XCTUnwrap(SettingsWebSession(port: 4_321, token: "synthetic-token"))
        let timeZone = TimeZone(secondsFromGMT: 0)!
        let day = Date(timeIntervalSince1970: 1_790_208_000)

        // When the settings and summary requests are constructed.
        let settings = session.request(for: .settings)
        let summary = session.request(for: .today)

        // Then the token reaches the local shell in both the header and bootstrap query.
        XCTAssertEqual(settings.url?.host, "127.0.0.1")
        XCTAssertEqual(settings.url?.fragment, "/settings/context-awareness")
        XCTAssertTrue(summary.url?.fragment?.hasPrefix("/history/") == true)
        XCTAssertEqual(SettingsRoute.today.fragment(at: day, timeZone: timeZone), "/history/2026-09-24")
        XCTAssertEqual(settings.value(forHTTPHeaderField: "Authorization"), "Bearer synthetic-token")
        XCTAssertEqual(URLComponents(url: settings.url!, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "t" })?.value, "synthetic-token")
        XCTAssertEqual(URLComponents(url: summary.url!, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "t" })?.value, "synthetic-token")
        XCTAssertNil(session.request(forLocalURL: URL(string: "https://example.com/?t=synthetic-token")!))
    }

    func testDaemonStatusDecodesApprovedFieldNamesAndPauseParameters() throws {
        // Given a daemon status payload and all four pause choices.
        let data = Data(#"{"enabled":true,"state":"paused","paused_until":9007199254740991,"banner":"none"}"#.utf8)

        // When the status is decoded for the menu.
        let status = try JSONDecoder().decode(MenuCaptureStatus.self, from: data)

        // Then the indefinite marker and approved RPC parameters are preserved.
        XCTAssertEqual(MenuDisplay(status: status, language: .en).text, "Paused until you resume")
        XCTAssertEqual(MenuPauseOption.fifteenMinutes.rpcParams, ["durationMs": 900_000])
        XCTAssertEqual(MenuPauseOption.thirtyMinutes.rpcParams, ["durationMs": 1_800_000])
        XCTAssertEqual(MenuPauseOption.oneHour.rpcParams, ["durationMs": 3_600_000])
        XCTAssertEqual(MenuPauseOption.untilIResume.rpcParams, ["until": 9_007_199_254_740_991])
    }

    func testSavedLanguageRefreshesOnEveryMenuOpenAndChangesStatusText() async {
        let service = FakeMenuService()
        var savedLanguage = SideLanguage.en
        var languageFetches = 0
        let model = MenuBarState(service: service, languageLoader: {
            languageFetches += 1
            return savedLanguage
        })

        await model.menuDidOpen()
        XCTAssertEqual(model.language, .en)
        XCTAssertEqual(model.display.text, "Capturing")

        savedLanguage = .ko
        await model.menuDidOpen()
        XCTAssertEqual(model.language, .ko)
        XCTAssertEqual(model.display.text, "캡처 중")
        XCTAssertEqual(languageFetches, 2)
        XCTAssertEqual(MenuPauseOption.fifteenMinutes.title(language: .ko), "15분")
    }
}

@MainActor
private final class FailingMenuService: MenuBarServicing {
    func fetchStatus() async throws -> MenuCaptureStatus { throw NSError(domain: "synthetic", code: 1) }
    func pause(_ option: MenuPauseOption) async throws {}
    func resume() async throws {}
}
