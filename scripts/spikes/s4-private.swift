import AppKit
import ApplicationServices
import Carbon

// Read-only S-4 probe. Run only with an existing browser window in the foreground.
// Output contains detection booleans and numeric errors, never window data.
struct Browser {
    let name: String
    let bundleID: String
    let safari: Bool
}

let browsers: [String: Browser] = [
    "chrome": Browser(name: "Chrome", bundleID: "com.google.Chrome", safari: false),
    "arc": Browser(name: "Arc", bundleID: "company.thebrowser.Browser", safari: false),
    "brave": Browser(name: "Brave", bundleID: "com.brave.Browser", safari: false),
    "edge": Browser(name: "Edge", bundleID: "com.microsoft.edgemac", safari: false),
    "aside": Browser(name: "Aside", bundleID: "at.studio.AsideBrowser", safari: false),
    "safari": Browser(name: "Safari", bundleID: "com.apple.Safari", safari: true),
]

struct Result: Encodable {
    let browser: String
    let installed: Bool
    let running: Bool
    let frontmost: Bool
    var automationAllowed: Bool?
    var automationError: Int32?
    var appleScriptModeRecognized: Bool?
    var appleScriptPrivate: Bool?
    var appleScriptModeError: Int?
    var appleScriptTitleMarker: Bool?
    var appleScriptTitleError: Int?
    var axAllowed: Bool?
    var axPrivateAttributePresent: Bool?
    var axTitleMarker: Bool?
    var axDescriptionMarker: Bool?
    var axSubroleMarker: Bool?
    var axError: Int32?
}

func hasPrivateMarker(_ value: String) -> Bool {
    let text = value.lowercased()
    return text.contains("private browsing") || text.contains("private window")
        || text.contains("비공개") || text.contains("プライベート")
}

func appleScriptValue(_ source: String) -> (String?, Int?) {
    guard let script = NSAppleScript(source: source) else { return (nil, -1) }
    var error: NSDictionary?
    let value = script.executeAndReturnError(&error)
    return (value.stringValue, (error?["NSAppleScriptErrorNumber"] as? NSNumber)?.intValue)
}

func axString(_ window: AXUIElement, _ key: String) -> (String?, Int32?) {
    var value: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(window, key as CFString, &value)
    if status != .success { return (nil, status.rawValue) }
    return (value as? String, nil)
}

guard CommandLine.arguments.count == 2,
      let browser = browsers[CommandLine.arguments[1]] else {
    fputs("usage: swift scripts/spikes/s4-private.swift chrome|arc|brave|edge|aside|safari\n", stderr)
    exit(2)
}

let app = NSRunningApplication.runningApplications(withBundleIdentifier: browser.bundleID).first
var result = Result(
    browser: browser.name,
    installed: NSWorkspace.shared.urlForApplication(withBundleIdentifier: browser.bundleID) != nil,
    running: app != nil,
    frontmost: NSWorkspace.shared.frontmostApplication?.bundleIdentifier == browser.bundleID
)

// Never launch an app, change focus, open a window, or trigger a TCC consent prompt.
if let app, result.frontmost {
    let address = NSAppleEventDescriptor(bundleIdentifier: browser.bundleID)
    if let descriptor = address.aeDesc {
        let permission = AEDeterminePermissionToAutomateTarget(
            descriptor, AEEventClass(kAECoreSuite), AEEventID(kAEGetData), false
        )
        result.automationAllowed = permission == noErr
        if permission == noErr {
            let source = "tell application id \"\(browser.bundleID)\" to get mode of front window"
            let (mode, error) = appleScriptValue(source)
            result.appleScriptModeError = error
            if let mode {
                let normalized = mode.lowercased()
                result.appleScriptModeRecognized = normalized == "incognito" || normalized == "normal"
                if result.appleScriptModeRecognized == true {
                    result.appleScriptPrivate = normalized == "incognito"
                }
            }
            if browser.safari {
                let titleSource = "tell application id \"\(browser.bundleID)\" to get name of front window"
                let (title, titleError) = appleScriptValue(titleSource)
                if let title { result.appleScriptTitleMarker = hasPrivateMarker(title) }
                result.appleScriptTitleError = titleError
            }
        } else {
            result.automationError = permission
        }
    } else {
        result.automationAllowed = false
        result.automationError = -1
    }

    if browser.safari {
        result.axAllowed = AXIsProcessTrusted()
        if result.axAllowed == true {
            let axApp = AXUIElementCreateApplication(app.processIdentifier)
            var windowValue: CFTypeRef?
            let windowStatus = AXUIElementCopyAttributeValue(
                axApp, kAXFocusedWindowAttribute as CFString, &windowValue
            )
            if windowStatus == .success, let windowValue,
               CFGetTypeID(windowValue) == AXUIElementGetTypeID() {
                let window = windowValue as! AXUIElement
                var namesValue: CFArray?
                let namesStatus = AXUIElementCopyAttributeNames(window, &namesValue)
                if namesStatus == .success, let names = namesValue as? [String] {
                    result.axPrivateAttributePresent = names.contains {
                        $0.localizedCaseInsensitiveContains("private")
                    }
                } else {
                    result.axError = namesStatus.rawValue
                }
                let (title, titleError) = axString(window, kAXTitleAttribute)
                if let title { result.axTitleMarker = hasPrivateMarker(title) }
                if result.axError == nil { result.axError = titleError }
                let (description, descriptionError) = axString(window, kAXDescriptionAttribute)
                if let description { result.axDescriptionMarker = hasPrivateMarker(description) }
                if result.axError == nil { result.axError = descriptionError }
                let (subrole, subroleError) = axString(window, kAXSubroleAttribute)
                if let subrole { result.axSubroleMarker = hasPrivateMarker(subrole) }
                if result.axError == nil { result.axError = subroleError }
            } else {
                result.axError = windowStatus.rawValue
            }
        }
    }
}

let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
let data = try encoder.encode(result)
print(String(decoding: data, as: UTF8.self))
