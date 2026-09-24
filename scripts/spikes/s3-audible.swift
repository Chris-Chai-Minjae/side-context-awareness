import AppKit
import ApplicationServices
import CoreAudio
import Foundation

private func elapsedMilliseconds(since start: UInt64) -> Double {
    Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
}

private func propertyAddress(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
}

@available(macOS 14.2, *)
private func audioProcessIDs() -> [AudioObjectID]? {
    var address = propertyAddress(kAudioHardwarePropertyProcessObjectList)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else {
        return nil
    }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    if ids.isEmpty { return [] }
    let status = withUnsafeMutablePointer(to: &ids[0]) { pointer in
        AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, pointer)
    }
    return status == noErr ? ids : nil
}

@available(macOS 14.2, *)
private func audioProcessPID(_ object: AudioObjectID) -> pid_t? {
    var address = propertyAddress(kAudioProcessPropertyPID)
    var size = UInt32(MemoryLayout<pid_t>.size)
    var pid: pid_t = 0
    guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &pid) == noErr else {
        return nil
    }
    return pid
}

@available(macOS 14.2, *)
private func audioProcessBundleID(_ object: AudioObjectID) -> String? {
    var address = propertyAddress(kAudioProcessPropertyBundleID)
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    var value: Unmanaged<CFString>?
    guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr else {
        return nil
    }
    return value?.takeRetainedValue() as String?
}

@available(macOS 14.2, *)
private func hasRunningOutput(_ object: AudioObjectID) -> Bool? {
    var address = propertyAddress(kAudioProcessPropertyIsRunningOutput)
    var size = UInt32(MemoryLayout<UInt32>.size)
    var running: UInt32 = 0
    guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &running) == noErr else {
        return nil
    }
    return running != 0
}

private func probeCoreAudio(bundleID: String) {
    let start = DispatchTime.now().uptimeNanoseconds
    guard #available(macOS 14.2, *), let ids = audioProcessIDs() else {
        print("{\"probeOk\":false,\"targetPresent\":false,\"runningOutput\":false,\"queryMs\":\(elapsedMilliseconds(since: start))}")
        return
    }

    var targetPresent = false
    var runningOutput = false
    var probeOk = true
    for object in ids {
        if bundleID != "*" {
            let processBundleID = audioProcessBundleID(object)
                ?? audioProcessPID(object).flatMap { NSRunningApplication(processIdentifier: $0)?.bundleIdentifier }
            guard let processBundleID,
                  processBundleID == bundleID || processBundleID.hasPrefix(bundleID + ".") else {
                continue
            }
        }
        targetPresent = true
        guard let output = hasRunningOutput(object) else {
            probeOk = false
            continue
        }
        runningOutput = runningOutput || output
    }
    print("{\"probeOk\":\(probeOk),\"targetPresent\":\(targetPresent),\"runningOutput\":\(runningOutput),\"queryMs\":\(elapsedMilliseconds(since: start))}")
}

private func axValue(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success ? value : nil
}

private func hasPlaybackMarker(_ text: String) -> Bool {
    let label = text.lowercased()
    return ["playing audio", "audio playing", "소리 재생", "오디오 재생", "音声を再生", "🔊", "🔉"]
        .contains { label.contains($0) }
}

private func probeChromeAX() {
    let start = DispatchTime.now().uptimeNanoseconds
    let chrome = NSRunningApplication.runningApplications(withBundleIdentifier: "com.google.Chrome").first
    let trusted = AXIsProcessTrusted()
    guard let chrome, trusted else {
        print("{\"chromeRunning\":\(chrome != nil),\"axTrusted\":\(trusted),\"probeOk\":false,\"queryMs\":\(elapsedMilliseconds(since: start))}")
        return
    }

    let app = AXUIElementCreateApplication(chrome.processIdentifier)
    AXUIElementSetMessagingTimeout(app, 0.2)
    guard let windows = axValue(app, kAXWindowsAttribute) as? [AXUIElement] else {
        print("{\"chromeRunning\":true,\"axTrusted\":true,\"probeOk\":false,\"queryMs\":\(elapsedMilliseconds(since: start))}")
        return
    }

    var queue = windows.map { ($0, 0) }
    var visited = 0
    var tabFound = false
    var titleReadable = false
    var titleMarker = false
    var descriptionMarker = false
    var scanComplete = true
    while !queue.isEmpty && visited < 120 {
        let (element, depth) = queue.removeFirst()
        visited += 1
        let role = axValue(element, kAXRoleAttribute) as? String
        if role == "AXWebArea" { continue }
        if depth > 7 {
            scanComplete = false
            continue
        }
        if role == "AXTab" || role == "AXRadioButton" {
            tabFound = true
            if let title = axValue(element, kAXTitleAttribute) as? String {
                titleReadable = true
                titleMarker = titleMarker || hasPlaybackMarker(title)
            }
            if let description = axValue(element, kAXDescriptionAttribute) as? String {
                descriptionMarker = descriptionMarker || hasPlaybackMarker(description)
            }
        }
        if let tabs = axValue(element, kAXTabsAttribute) as? [AXUIElement] {
            queue.append(contentsOf: tabs.map { ($0, depth + 1) })
        }
        if let children = axValue(element, kAXChildrenAttribute) as? [AXUIElement] {
            queue.append(contentsOf: children.map { ($0, depth + 1) })
        }
    }
    print("{\"chromeRunning\":true,\"axTrusted\":true,\"probeOk\":true,\"scanComplete\":\(scanComplete && queue.isEmpty),\"tabFound\":\(tabFound),\"titleReadable\":\(titleReadable),\"titleMarker\":\(titleMarker),\"descriptionMarker\":\(descriptionMarker),\"queryMs\":\(elapsedMilliseconds(since: start))}")
}

switch CommandLine.arguments.dropFirst().first {
case "coreaudio":
    probeCoreAudio(bundleID: CommandLine.arguments.dropFirst(2).first ?? "com.google.Chrome")
case "chrome-ax":
    probeChromeAX()
default:
    print("{\"probeOk\":false}")
    exit(2)
}
