import AppKit
import Foundation
import SwiftUI
import WebKit

enum SettingsRoute {
    case settings
    case today

    func title(language: SideLanguage) -> String {
        switch self {
        case .settings: return language.localized("Side Settings", "Side 설정")
        case .today: return language.localized("Today's summary — Side", "오늘의 요약 — Side")
        }
    }

    func fragment(at date: Date = Date(), timeZone: TimeZone = .current) -> String {
        switch self {
        case .settings:
            return "/settings/context-awareness"
        case .today:
            let formatter = DateFormatter()
            formatter.calendar = Calendar(identifier: .gregorian)
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.timeZone = timeZone
            formatter.dateFormat = "yyyy-MM-dd"
            return "/history/\(formatter.string(from: date))"
        }
    }
}

struct SettingsWebSession {
    let port: Int
    let token: String

    init?(port: Int, token: String) {
        guard (1...65_535).contains(port), !token.isEmpty else { return nil }
        self.port = port
        self.token = token
    }

    func request(for route: SettingsRoute) -> URLRequest {
        let url = URL(string: "http://127.0.0.1:\(port)/#\(route.fragment())")!
        return authenticatedRequest(for: bootstrapURL(url))
    }

    func request(forLocalURL url: URL) -> URLRequest? {
        guard SettingsNavigationPolicy(localPort: port).isLocal(url) else { return nil }
        return authenticatedRequest(for: bootstrapURL(url))
    }

    private func bootstrapURL(_ url: URL) -> URL {
        var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        parts.queryItems = (parts.queryItems ?? []).filter { $0.name != "t" } + [URLQueryItem(name: "t", value: token)]
        return parts.url!
    }

    private func authenticatedRequest(for url: URL) -> URLRequest {
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        return request
    }
}

enum SettingsNavigationAction: Equatable {
    case allowInWebView
    case deferToUIDelegate
    case loadInWebView
    case openInDefaultBrowser
    case openSystemSettings
    case cancel
}

struct SettingsNavigationPolicy {
    let localPort: Int

    private static let permissionPanes: Set<String> = [
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    ]

    func isLocal(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "http" && url.host?.lowercased() == "127.0.0.1"
            && url.port == localPort && url.user == nil && url.password == nil
    }

    func navigationAction(for url: URL?, isUserLink: Bool, targetBlank: Bool) -> SettingsNavigationAction {
        guard let url else { return .cancel }
        if isLocal(url) {
            if targetBlank { return isUserLink ? .deferToUIDelegate : .cancel }
            return .allowInWebView
        }
        if isUserLink && Self.permissionPanes.contains(url.absoluteString) { return .openSystemSettings }
        guard isExternalHTTP(url), isUserLink else { return .cancel }
        return targetBlank ? .deferToUIDelegate : .openInDefaultBrowser
    }

    func newWindowAction(for url: URL?, isUserLink: Bool) -> SettingsNavigationAction {
        guard let url, isUserLink else { return .cancel }
        if isLocal(url) { return .loadInWebView }
        if Self.permissionPanes.contains(url.absoluteString) { return .openSystemSettings }
        return isExternalHTTP(url) ? .openInDefaultBrowser : .cancel
    }

    private func isExternalHTTP(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else { return false }
        return url.host != nil
    }
}

@MainActor
final class SettingsWindowController: NSObject {
    static let shared = SettingsWindowController()

    private var window: NSWindow?
    private var webView: WKWebView?
    private var session: SettingsWebSession?
    private var route: SettingsRoute = .settings
    private var language: SideLanguage = .ko

    func updateLanguage(_ next: SideLanguage) {
        language = next
        window?.title = route.title(language: next)
        if session == nil, let window {
            window.contentViewController = unavailableView()
        }
    }

    func accept(session: SettingsWebSession?) {
        self.session = session
        if session == nil {
            webView?.stopLoading()
            webView = nil
            if let window {
                window.contentViewController = unavailableView()
            }
        }
    }

    func open(_ route: SettingsRoute, language: SideLanguage = .ko) {
        self.route = route
        self.language = language
        let window = window ?? makeWindow()
        window.title = route.title(language: language)
        if let session {
            let webView = webView ?? makeWebView(frame: window.contentView?.bounds ?? .zero)
            self.webView = webView
            window.contentView = webView
            webView.load(session.request(for: route))
        } else {
            window.contentViewController = unavailableView()
        }
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    private func makeWindow() -> NSWindow {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 980, height: 720),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false
        )
        window.title = route.title(language: language)
        window.center()
        window.isReleasedWhenClosed = false
        self.window = window
        return window
    }

    private func unavailableView() -> NSViewController {
        NSHostingController(rootView: Text(language.localized(
            "Settings are unavailable right now.", "현재 설정을 열 수 없습니다."
        )).frame(maxWidth: .infinity, maxHeight: .infinity))
    }

    private func makeWebView(frame: NSRect) -> WKWebView {
        let webView = WKWebView(frame: frame)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        return webView
    }
}

extension SettingsWindowController: WKNavigationDelegate, WKUIDelegate {
    func webView(
        _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let session else {
            decisionHandler(.cancel)
            return
        }
        let action = SettingsNavigationPolicy(localPort: session.port).navigationAction(
            for: navigationAction.request.url,
            isUserLink: navigationAction.navigationType == .linkActivated,
            targetBlank: navigationAction.targetFrame == nil
        )
        switch action {
        case .allowInWebView, .deferToUIDelegate:
            decisionHandler(.allow)
        case .openInDefaultBrowser:
            if let url = navigationAction.request.url, !url.absoluteString.contains(session.token) {
                _ = NSWorkspace.shared.open(url)
            }
            decisionHandler(.cancel)
        case .openSystemSettings:
            if let url = navigationAction.request.url { _ = NSWorkspace.shared.open(url) }
            decisionHandler(.cancel)
        case .loadInWebView, .cancel:
            decisionHandler(.cancel)
        }
    }

    func webView(
        _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        guard let session, let url = navigationAction.request.url else { return nil }
        let action = SettingsNavigationPolicy(localPort: session.port).newWindowAction(
            for: url, isUserLink: navigationAction.navigationType == .linkActivated
        )
        switch action {
        case .loadInWebView:
            if let request = session.request(forLocalURL: url) { webView.load(request) }
        case .openInDefaultBrowser:
            if !url.absoluteString.contains(session.token) { _ = NSWorkspace.shared.open(url) }
        case .openSystemSettings:
            _ = NSWorkspace.shared.open(url)
        case .allowInWebView, .deferToUIDelegate, .cancel:
            break
        }
        return nil
    }
}
