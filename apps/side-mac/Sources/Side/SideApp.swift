import AppKit
import SwiftUI

@main
struct SideApp: App {
    @NSApplicationDelegateAdaptor(SideApplicationDelegate.self) private var appDelegate
    @StateObject private var runtime = SideRuntime.shared
    @StateObject private var menuState = MenuBarState.shared
    @StateObject private var loginItem = LoginItemState.shared

    var body: some Scene {
        MenuBarExtra {
            MenuBarView(state: menuState, loginItem: loginItem, settingsWindow: .shared) {
                Task { await runtime.quit(); NSApplication.shared.terminate(nil) }
            }
        } label: {
            Image(systemName: menuState.display.systemImage)
                .accessibilityLabel("Side, \(menuState.display.text)")
                .task { await menuState.poll() }
        }
    }
}

@MainActor
private final class SideApplicationDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        SideRuntime.shared.start()
        OnboardingWindowController.shared.start(runtime: SideRuntime.shared, menuState: .shared)
    }

    func applicationWillTerminate(_ notification: Notification) {
        OnboardingWindowController.shared.stop()
        SideRuntime.shared.stop()
    }
}
