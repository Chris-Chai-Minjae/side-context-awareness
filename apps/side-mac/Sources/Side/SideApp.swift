import AppKit
import SwiftUI

@main
struct SideApp: App {
    private static let menuBarMark: NSImage? = {
        guard let path = Bundle.main.path(forResource: "MenuBarTemplate@2x", ofType: "png"),
              let image = NSImage(contentsOfFile: path) else { return nil }
        image.isTemplate = true
        return image
    }()

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
            HStack(spacing: 2) {
                if let mark = Self.menuBarMark {
                    Image(nsImage: mark)
                        .resizable()
                        .frame(width: 18, height: 18)
                }
                Image(systemName: menuState.display.systemImage)
                    .font(.system(size: 11, weight: .semibold))
            }
            .accessibilityElement(children: .ignore)
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
