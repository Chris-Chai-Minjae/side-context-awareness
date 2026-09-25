import Combine
import Foundation
import SwiftUI

enum MenuCaptureState: String, Decodable {
    case starting, running, paused, stopped
}

enum MenuBanner: String, Decodable {
    case none, starting
    case notRunning = "not_running"
    case permissionsNeeded = "permissions_needed"
    case someUnavailable = "some_unavailable"
}

struct MenuCaptureStatus: Decodable {
    let enabled: Bool
    let state: MenuCaptureState
    let pausedUntil: Int64?
    let banner: MenuBanner

    private enum CodingKeys: String, CodingKey {
        case enabled, state, banner
        case pausedUntil = "paused_until"
    }
}

struct MenuDisplay {
    let text: String
    let systemImage: String
    let isPaused: Bool

    static func notRunning(language: SideLanguage) -> MenuDisplay {
        MenuDisplay(
            text: language.localized("Capture is not running", "캡처가 실행 중이지 않습니다"),
            systemImage: "exclamationmark.triangle.fill", isPaused: false
        )
    }

    init(text: String, systemImage: String, isPaused: Bool) {
        self.text = text
        self.systemImage = systemImage
        self.isPaused = isPaused
    }

    init(status: MenuCaptureStatus, language: SideLanguage = .ko, timeZone: TimeZone = .current) {
        if status.banner == .permissionsNeeded {
            self.init(
                text: language.localized("Permissions needed", "권한이 필요합니다"),
                systemImage: "exclamationmark.triangle.fill", isPaused: false
            )
            return
        }
        guard status.enabled, status.banner != .notRunning else {
            self = .notRunning(language: language)
            return
        }
        switch status.state {
        case .paused:
            guard let until = status.pausedUntil else {
                self = .notRunning(language: language)
                return
            }
            if until == 9_007_199_254_740_991 {
                self.init(
                    text: language.localized("Paused until you resume", "직접 재개할 때까지 일시정지됨"),
                    systemImage: "pause.circle.fill", isPaused: true
                )
            } else {
                let formatter = DateFormatter()
                formatter.dateFormat = "HH:mm"
                formatter.timeZone = timeZone
                self.init(
                    text: language.localized(
                        "Paused until \(formatter.string(from: Date(timeIntervalSince1970: Double(until) / 1_000)))",
                        "\(formatter.string(from: Date(timeIntervalSince1970: Double(until) / 1_000)))까지 일시 중지"
                    ),
                    systemImage: "pause.circle.fill", isPaused: true
                )
            }
        case .running:
            let icon = status.banner == .someUnavailable
                ? "exclamationmark.triangle.fill" : "circle.fill"
            self.init(text: language.localized("Capturing", "캡처 중"), systemImage: icon, isPaused: false)
        case .starting, .stopped:
            self = .notRunning(language: language)
        }
    }
}

enum MenuPauseOption: CaseIterable {
    case fifteenMinutes, thirtyMinutes, oneHour, untilIResume

    func title(language: SideLanguage) -> String {
        switch self {
        case .fifteenMinutes: return language.localized("15 minutes", "15분")
        case .thirtyMinutes: return language.localized("30 minutes", "30분")
        case .oneHour: return language.localized("1 hour", "1시간")
        case .untilIResume: return language.localized("Until I resume", "직접 재개할 때까지")
        }
    }

    var rpcParams: [String: Int64] {
        switch self {
        case .fifteenMinutes: return ["durationMs": 900_000]
        case .thirtyMinutes: return ["durationMs": 1_800_000]
        case .oneHour: return ["durationMs": 3_600_000]
        case .untilIResume: return ["until": 9_007_199_254_740_991]
        }
    }
}

@MainActor
protocol MenuBarServicing: AnyObject {
    func fetchStatus() async throws -> MenuCaptureStatus
    func pause(_ option: MenuPauseOption) async throws
    func resume() async throws
}

@MainActor
final class MenuBarState: ObservableObject {
    static let shared = MenuBarState(
        service: UDSMenuBarService(), languageLoader: {
            let settings = try await UDSOnboardingService().getSettings()
            return settings.language
        }
    )
    static let cacheSeconds: TimeInterval = 30

    @Published private(set) var language: SideLanguage = .ko
    @Published private(set) var display = MenuDisplay.notRunning(language: .ko)
    @Published private(set) var isWorking = false

    private let service: MenuBarServicing
    private let languageLoader: (() async throws -> SideLanguage)?
    private let now: () -> Date
    private var lastStatus: MenuCaptureStatus?
    private var lastRefresh: Date?
    private var refreshGeneration = 0
    private var languageRefreshGeneration = 0

    init(
        service: MenuBarServicing,
        languageLoader: (() async throws -> SideLanguage)? = nil,
        now: @escaping () -> Date = Date.init
    ) {
        self.service = service
        self.languageLoader = languageLoader
        self.now = now
    }

    func menuDidOpen() async {
        languageRefreshGeneration += 1
        let generation = languageRefreshGeneration
        if let languageLoader, let savedLanguage = try? await languageLoader() {
            if generation == languageRefreshGeneration { setLanguage(savedLanguage) }
        }
        await refresh(force: true)
    }

    func setLanguage(_ next: SideLanguage) {
        guard next != language else { return }
        language = next
        display = lastStatus.map { MenuDisplay(status: $0, language: next) }
            ?? .notRunning(language: next)
    }

    func poll() async {
        while !Task.isCancelled {
            await refresh()
            try? await Task.sleep(nanoseconds: UInt64(Self.cacheSeconds * 1_000_000_000))
        }
    }

    func refresh(force: Bool = false) async {
        let startedAt = now()
        if !force, let lastRefresh, startedAt.timeIntervalSince(lastRefresh) < Self.cacheSeconds {
            return
        }
        refreshGeneration += 1
        let generation = refreshGeneration
        do {
            let status = try await service.fetchStatus()
            guard generation == refreshGeneration else { return }
            lastStatus = status
            display = MenuDisplay(status: status, language: language)
        } catch {
            guard generation == refreshGeneration else { return }
            lastStatus = nil
            display = .notRunning(language: language)
        }
        lastRefresh = startedAt
    }

    func pause(_ option: MenuPauseOption) async {
        guard !isWorking else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            try await service.pause(option)
            await refresh(force: true)
        } catch {
            lastStatus = nil
            display = .notRunning(language: language)
            lastRefresh = nil
        }
    }

    func resume() async {
        guard !isWorking else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            try await service.resume()
            await refresh(force: true)
        } catch {
            lastStatus = nil
            display = .notRunning(language: language)
            lastRefresh = nil
        }
    }
}

struct MenuBarView: View {
    @ObservedObject private var runtime = SideRuntime.shared
    @ObservedObject var state: MenuBarState
    @ObservedObject var loginItem: LoginItemState
    let settingsWindow: SettingsWindowController
    let quit: () -> Void

    static func pauseTitle(language: SideLanguage) -> String {
        language.localized("Pause", "일시정지")
    }

    static func resumeTitle(language: SideLanguage) -> String {
        language.localized("Resume", "재개")
    }

    var body: some View {
        Group {
            Text(runtime.supervisorState == .keychainLocked
                ? MenuDisplay.notRunning(language: state.language).text : state.display.text)
            if let title = runtime.supervisorState.unlockKeychainTitle(language: state.language) {
                Button(title) { runtime.supervisor.retryKeychain() }
            }
            Divider()
            Menu(Self.pauseTitle(language: state.language)) {
                ForEach(MenuPauseOption.allCases, id: \.self) { option in
                    Button(option.title(language: state.language)) { Task { await state.pause(option) } }
                }
            }
            .disabled(state.isWorking)
            if state.display.isPaused {
                Button(Self.resumeTitle(language: state.language)) {
                    Task { await state.resume() }
                }
                    .disabled(state.isWorking)
            }
            Divider()
            Button(state.language.localized("Today's summary…", "오늘의 요약…")) {
                settingsWindow.open(.today, language: state.language)
            }
            Button(state.language.localized("Settings…", "설정…")) {
                settingsWindow.open(.settings, language: state.language)
            }
            Toggle(state.language.localized("Open at Login", "로그인 시 열기"), isOn: Binding(
                get: { loginItem.isEnabled },
                set: { enabled in Task { await loginItem.setEnabled(enabled) } }
            ))
            .disabled(loginItem.isWorking)
            if loginItem.requiresApproval {
                Text(state.language.localized(
                    "Allow Side in System Settings → General → Login Items",
                    "시스템 설정 → 일반 → 로그인 항목에서 Side를 허용하세요"
                ))
            }
            if loginItem.errorMessage != nil {
                Text(state.language.localized(
                    "Could not update Open at Login. Check System Settings and try again.",
                    "로그인 시 열기 설정을 변경할 수 없습니다. 시스템 설정을 확인한 뒤 다시 시도하세요."
                ))
            }
            Divider()
            Button(state.language.localized("Quit Side", "Side 종료"), action: quit)
        }
        .onAppear {
            loginItem.refresh()
            Task { await state.menuDidOpen() }
        }
        .onChange(of: state.language) { _, language in
            settingsWindow.updateLanguage(language)
        }
    }
}
