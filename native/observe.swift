import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

struct FrontWindow: Encodable {
    let bundleId: String
    let appName: String
    let windowTitle: String
    let windowId: UInt32?
    let readableText: String?
    let focusedText: String?
    let focusedElementKey: String?
    let accessibilityAvailable: Bool
}

func attribute(_ element: AXUIElement, _ name: CFString) -> Any? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name, &value) == .success else { return nil }
    return value
}

func textFrom(_ element: AXUIElement) -> String {
    var queue = [element]
    var parts: [String] = []
    var seen = Set<String>()
    var nodeCount = 0
    var characterCount = 0

    while !queue.isEmpty && nodeCount < 400 && characterCount < 12_000 {
        let node = queue.removeFirst()
        nodeCount += 1
        let role = attribute(node, kAXRoleAttribute as CFString) as? String ?? ""
        let subrole = attribute(node, kAXSubroleAttribute as CFString) as? String ?? ""
        if subrole == "AXSecureTextField" || role == "AXSecureTextField" { continue }

        let readable = role == "AXStaticText"
        if readable, let value = attribute(node, kAXValueAttribute as CFString) as? String {
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty && !seen.contains(trimmed) {
                let remaining = 12_000 - characterCount
                let excerpt = String(trimmed.prefix(remaining))
                parts.append(excerpt)
                seen.insert(trimmed)
                characterCount += excerpt.count
            }
        }
        if let children = attribute(node, kAXChildrenAttribute as CFString) as? [AXUIElement] {
            queue.append(contentsOf: children.prefix(100))
        }
    }
    return parts.joined(separator: "\n")
}

guard let app = NSWorkspace.shared.frontmostApplication else {
    fputs("No foreground application\n", stderr)
    exit(1)
}

let arguments = CommandLine.arguments
let readText = arguments.contains("--text")
let includeFields = arguments.contains("--include-fields")
if let expectedIndex = arguments.firstIndex(of: "--expect-bundle"), expectedIndex + 1 < arguments.count {
    guard app.bundleIdentifier == arguments[expectedIndex + 1] else {
        fputs("Foreground application changed\n", stderr)
        exit(2)
    }
}

let info = CGWindowListCopyWindowInfo(
    [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
) as? [[String: Any]] ?? []
let frontWindow = info.first { window in
    let owner = window[kCGWindowOwnerPID as String] as? NSNumber
    let layer = window[kCGWindowLayer as String] as? NSNumber
    return owner?.int32Value == app.processIdentifier && layer?.intValue == 0
}

var readableText: String?
var focusedText: String?
var focusedElementKey: String?
let accessible = AXIsProcessTrusted()
if readText && accessible {
    let application = AXUIElementCreateApplication(app.processIdentifier)
    if let window = attribute(application, kAXFocusedWindowAttribute as CFString) as! AXUIElement? {
        readableText = textFrom(window)
    }
    if includeFields,
       let focused = attribute(application, kAXFocusedUIElementAttribute as CFString) as! AXUIElement? {
        let role = attribute(focused, kAXRoleAttribute as CFString) as? String ?? ""
        let subrole = attribute(focused, kAXSubroleAttribute as CFString) as? String ?? ""
        if (role == "AXTextField" || role == "AXTextArea") && subrole != "AXSecureTextField" {
            focusedText = attribute(focused, kAXValueAttribute as CFString) as? String
            let identifier = attribute(focused, kAXIdentifierAttribute as CFString) as? String
            let position = attribute(focused, kAXPositionAttribute as CFString)
            let title = attribute(focused, kAXTitleAttribute as CFString) as? String ?? ""
            if let identifier, !identifier.isEmpty {
                focusedElementKey = "\(role):\(identifier)"
            } else if let position {
                focusedElementKey = "\(role):\(title):\(position)"
            }
        }
    }
}

let output = FrontWindow(
    bundleId: app.bundleIdentifier ?? "",
    appName: app.localizedName ?? "",
    windowTitle: frontWindow?[kCGWindowName as String] as? String ?? "",
    windowId: (frontWindow?[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
    readableText: readableText,
    focusedText: focusedText,
    focusedElementKey: focusedElementKey,
    accessibilityAvailable: accessible
)

let data = try JSONEncoder().encode(output)
FileHandle.standardOutput.write(data)
