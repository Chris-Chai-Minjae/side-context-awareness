import AppKit
import Combine
import SwiftUI

@MainActor
final class OnboardingWindowController {
    static let shared = OnboardingWindowController()
    private static let startupRetryLimit = 10
    private static let windowWidth: CGFloat = 640
    private static let windowHeight: CGFloat = 470

    private var window: NSWindow?
    private var startTask: Task<Void, Never>?
    private weak var flow: OnboardingFlow?
    private var languageSubscription: AnyCancellable?

    func start(runtime: SideRuntime, menuState: MenuBarState) {
        guard startTask == nil else { return }
        let flow = makeFlow(
            service: UDSOnboardingService(), permissions: runtime.permissions, menuState: menuState
        )
        startTask = Task { [weak self] in
            for attempt in 0..<Self.startupRetryLimit {
                do {
                    try await flow.load()
                    break
                } catch {
                    guard attempt + 1 < Self.startupRetryLimit else { break }
                    try? await Task.sleep(nanoseconds: OnboardingFlow.permissionPollNanoseconds)
                }
            }
            guard !Task.isCancelled, !flow.isFinished else { return }
            self?.show(flow: flow)
        }
    }

    func stop() {
        startTask?.cancel()
        startTask = nil
        close()
    }

    func makeFlow(
        service: OnboardingService, permissions: PermissionCoordinator, menuState: MenuBarState
    ) -> OnboardingFlow {
        let flow = OnboardingFlow(
            service: service, permissions: permissions,
            onLanguageChange: { [weak menuState] language in menuState?.setLanguage(language) },
            onComplete: { [weak self, weak menuState] in
                self?.close()
                guard self?.flow?.isLoaded == true else { return }
                Task { await menuState?.refresh(force: true) }
            }
        )
        self.flow = flow
        return flow
    }

    private func show(flow: OnboardingFlow) {
        let window = Self.makeWindow(rootView: OnboardingView(flow: flow), language: flow.language)
        self.window = window
        languageSubscription = flow.$language.sink { [weak self] language in
            self?.window?.title = language.localized("Set up Side", "Side 설정")
        }
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    static func makeWindow<Content: View>(rootView: Content, language: SideLanguage = .ko) -> NSWindow {
        let rect = NSRect(x: 0, y: 0, width: Self.windowWidth, height: Self.windowHeight)
        let window = NSWindow(
            contentRect: rect, styleMask: [.titled, .miniaturizable], backing: .buffered, defer: false
        )
        window.isReleasedWhenClosed = false
        window.title = language.localized("Set up Side", "Side 설정")
        let hosting = NSHostingController(rootView: rootView)
        hosting.sizingOptions = []
        window.contentViewController = hosting
        let size = NSSize(width: Self.windowWidth, height: Self.windowHeight)
        window.contentMinSize = size
        window.setContentSize(size)
        return window
    }

    private func close() {
        languageSubscription = nil
        window?.close()
        window = nil
    }
}
