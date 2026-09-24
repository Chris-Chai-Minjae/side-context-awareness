import AppKit
import ApplicationServices
import Darwin
import Foundation

// Usage: swift scripts/spikes/s2-ax.swift --inventory
//        swift scripts/spikes/s2-ax.swift --measure [Chrome|Arc|Brave|Edge|Aside]
// Only --measure writes browser AX activation attributes. No page text is emitted or saved.

struct Browser {
    let name: String
    let bundleID: String
}

struct TreeSample {
    var bytes = 0
    var webAreas = 0
    var nodes = 0
    var truncated = false
}

struct ProbeResult: Encodable {
    let browser: String
    let status: String
    let pid: Int32?
    let tccTrusted: Bool
    let beforeBytes: Int?
    let afterBytes: Int?
    let firstTreeMs: Int?
    let baselineCPUPercent: Double?
    let enabledCPUPercent: Double?
    let cpuDeltaPoints: Double?
    let cpuNote: String?
    let manualSetAXError: Int32?
    let manualWindowSetAXError: Int32?
    let enhancedSetAXError: Int32?
    let enhancedWindowSetAXError: Int32?
    let restoreAXErrors: [Int32]
    let beforeTruncated: Bool?
    let afterTruncated: Bool?
    let beforeWebAreas: Int?
    let afterWebAreas: Int?
    let beforeNodes: Int?
    let afterNodes: Int?
    let preexistingTree: Bool?
}

let browsers = [
    Browser(name: "Chrome", bundleID: "com.google.Chrome"),
    Browser(name: "Arc", bundleID: "company.thebrowser.Browser"),
    Browser(name: "Brave", bundleID: "com.brave.Browser"),
    Browser(name: "Edge", bundleID: "com.microsoft.edgemac"),
    Browser(name: "Aside", bundleID: "at.studio.AsideBrowser"),
]
let measure = CommandLine.arguments.dropFirst().first == "--measure"
let inventory = CommandLine.arguments.dropFirst().first == "--inventory"
let chosen = CommandLine.arguments.dropFirst(2).first
guard (measure || inventory), CommandLine.arguments.count <= 3,
      chosen == nil || browsers.contains(where: { $0.name == chosen }) else {
    fputs("Usage: swift scripts/spikes/s2-ax.swift --inventory | --measure [Chrome|Arc|Brave|Edge|Aside]\n", stderr)
    exit(2)
}

func emit(_ result: ProbeResult) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    guard let data = try? encoder.encode(result) else { exit(3) }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}

func result(_ browser: Browser, _ status: String, _ pid: pid_t? = nil,
            _ trusted: Bool = false) -> ProbeResult {
    ProbeResult(browser: browser.name, status: status, pid: pid,
                tccTrusted: trusted, beforeBytes: nil, afterBytes: nil,
                firstTreeMs: nil, baselineCPUPercent: nil,
                enabledCPUPercent: nil, cpuDeltaPoints: nil, cpuNote: nil,
                manualSetAXError: nil, manualWindowSetAXError: nil,
                enhancedSetAXError: nil, enhancedWindowSetAXError: nil,
                restoreAXErrors: [], beforeTruncated: nil, afterTruncated: nil,
                beforeWebAreas: nil, afterWebAreas: nil, beforeNodes: nil,
                afterNodes: nil, preexistingTree: nil)
}

func attribute(_ element: AXUIElement, _ name: CFString) -> Any? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name, &value) == .success else { return nil }
    return value
}

func selectedWindow(_ app: AXUIElement) -> AXUIElement? {
    if let window = attribute(app, kAXFocusedWindowAttribute as CFString) as! AXUIElement? {
        return window
    }
    if let window = attribute(app, kAXMainWindowAttribute as CFString) as! AXUIElement? {
        return window
    }
    return (attribute(app, kAXWindowsAttribute as CFString) as? [AXUIElement])?.first
}

func scan(_ window: AXUIElement) -> TreeSample {
    var sample = TreeSample()
    var queue: [(AXUIElement, Int?)] = [(window, nil)]
    var areaBytes: [Int] = []
    var index = 0
    let deadline = DispatchTime.now().uptimeNanoseconds + 4_000_000_000
    while index < queue.count && sample.nodes < 8_000 &&
          DispatchTime.now().uptimeNanoseconds < deadline {
        let (node, parentArea) = queue[index]
        index += 1
        sample.nodes += 1
        let role = attribute(node, kAXRoleAttribute as CFString) as? String ?? ""
        var area = parentArea
        if role == "AXWebArea" {
            area = areaBytes.count
            areaBytes.append(0)
            sample.webAreas += 1
        }
        if let area, role == "AXStaticText",
           let value = attribute(node, kAXValueAttribute as CFString) as? String {
            areaBytes[area] += value.utf8.count
        }
        if let children = attribute(node, kAXChildrenAttribute as CFString) as? [AXUIElement] {
            queue.append(contentsOf: children.map { ($0, area) })
        }
    }
    sample.bytes = areaBytes.max() ?? 0
    sample.truncated = index < queue.count
    return sample
}

func processIDs(_ root: pid_t) -> Set<pid_t>? {
    var found: Set<pid_t> = [root]
    var pending = [root]
    while let parent = pending.popLast() {
        var children = [pid_t](repeating: 0, count: 2_048)
        let bytes = children.withUnsafeMutableBufferPointer {
            proc_listchildpids(parent, $0.baseAddress,
                               Int32($0.count * MemoryLayout<pid_t>.size))
        }
        if bytes < 0 || bytes >= children.count * MemoryLayout<pid_t>.size { return nil }
        for child in children.prefix(Int(bytes) / MemoryLayout<pid_t>.size) where child > 0 {
            if found.insert(child).inserted { pending.append(child) }
        }
    }
    return found
}

func cpuTicks(_ pid: pid_t) -> UInt64? {
    var info = proc_taskinfo()
    let size = Int32(MemoryLayout<proc_taskinfo>.size)
    let bytes = withUnsafeMutablePointer(to: &info) { pointer in
        proc_pidinfo(pid, PROC_PIDTASKINFO, 0, pointer, size)
    }
    guard bytes == size else { return nil }
    return info.pti_total_user + info.pti_total_system
}

func cpuSnapshot(_ root: pid_t) -> [pid_t: UInt64]? {
    guard let pids = processIDs(root) else { return nil }
    var ticks: [pid_t: UInt64] = [:]
    for pid in pids {
        guard let value = cpuTicks(pid) else { return nil }
        ticks[pid] = value
    }
    return ticks
}

func cpuWindow(_ root: pid_t) -> (Double?, String?) {
    guard let start = cpuSnapshot(root) else { return (nil, "taskinfo_unavailable") }
    let startTime = DispatchTime.now().uptimeNanoseconds
    Thread.sleep(forTimeInterval: 4)
    guard let end = cpuSnapshot(root) else { return (nil, "taskinfo_unavailable") }
    let elapsed = Double(DispatchTime.now().uptimeNanoseconds - startTime) / 1e9
    guard start.keys == end.keys else { return (nil, "pid_set_changed") }
    var timebase = mach_timebase_info_data_t()
    guard mach_timebase_info(&timebase) == KERN_SUCCESS, timebase.denom > 0 else {
        return (nil, "timebase_unavailable")
    }
    var ticks: UInt64 = 0
    for (pid, startTicks) in start {
        guard let endTicks = end[pid], endTicks >= startTicks else {
            return (nil, "counter_reset")
        }
        ticks += endTicks - startTicks
    }
    let cpuSeconds = Double(ticks) * Double(timebase.numer) /
                     Double(timebase.denom) / 1e9
    return (100 * cpuSeconds / elapsed, nil)
}

func probe(_ browser: Browser, _ pid: pid_t) -> ProbeResult {
    let (baselineCPU, baselineNote) = cpuWindow(pid)
    let app = AXUIElementCreateApplication(pid)
    guard let window = selectedWindow(app) else {
        return result(browser, "no_ax_window", pid, true)
    }
    let before = scan(window)
    let preexistingTree = before.bytes > 0 && !before.truncated
    let manual = "AXManualAccessibility" as CFString
    let enhanced = "AXEnhancedUserInterface" as CFString
    let previousManual = attribute(app, manual) as? Bool
    let previousEnhanced = browser.name == "Chrome" ? attribute(app, enhanced) as? Bool : nil
    let manualError = AXUIElementSetAttributeValue(app, manual, true as CFTypeRef)
    let previousWindowManual = manualError == .success ? nil : attribute(window, manual) as? Bool
    let manualWindowError = manualError == .success ? nil
        : AXUIElementSetAttributeValue(window, manual, true as CFTypeRef)
    let enhancedError = browser.name == "Chrome"
        ? AXUIElementSetAttributeValue(app, enhanced, true as CFTypeRef) : nil
    let previousWindowEnhanced = enhancedError == .success ? nil
        : attribute(window, enhanced) as? Bool
    let enhancedWindowError = enhancedError == nil || enhancedError == .success ? nil
        : AXUIElementSetAttributeValue(window, enhanced, true as CFTypeRef)
    let activationStart = DispatchTime.now().uptimeNanoseconds
    var after = TreeSample()
    var firstTreeMs: Int? = preexistingTree ? 0 : nil
    repeat {
        after = scan(window)
        if after.bytes > 0 && !after.truncated {
            if !preexistingTree {
                firstTreeMs = Int((DispatchTime.now().uptimeNanoseconds - activationStart) / 1_000_000)
            }
            break
        }
        if DispatchTime.now().uptimeNanoseconds - activationStart >= 8_000_000_000 { break }
        Thread.sleep(forTimeInterval: 0.1)
    } while true
    let (enabledCPU, enabledNote) = cpuWindow(pid)
    var restoreErrors: [Int32] = []
    if enhancedWindowError == .success {
        let error = AXUIElementSetAttributeValue(window, enhanced,
                                                 (previousWindowEnhanced ?? false) as CFTypeRef)
        if error != .success { restoreErrors.append(error.rawValue) }
    }
    if enhancedError == .success {
        let error = AXUIElementSetAttributeValue(app, enhanced,
                                                 (previousEnhanced ?? false) as CFTypeRef)
        if error != .success { restoreErrors.append(error.rawValue) }
    }
    if manualWindowError == .success {
        let error = AXUIElementSetAttributeValue(window, manual,
                                                 (previousWindowManual ?? false) as CFTypeRef)
        if error != .success { restoreErrors.append(error.rawValue) }
    }
    if manualError == .success {
        let error = AXUIElementSetAttributeValue(app, manual,
                                                 (previousManual ?? false) as CFTypeRef)
        if error != .success { restoreErrors.append(error.rawValue) }
    }
    let delta = baselineCPU.flatMap { base in enabledCPU.map { $0 - base } }
    let activated = manualError == .success || manualWindowError == .success ||
                    enhancedError == .success || enhancedWindowError == .success
    let status = !restoreErrors.isEmpty ? "restore_failed"
        : activated ? "measured" : "activation_unavailable"
    return ProbeResult(browser: browser.name, status: status, pid: pid,
                       tccTrusted: true, beforeBytes: before.bytes, afterBytes: after.bytes,
                       firstTreeMs: firstTreeMs, baselineCPUPercent: baselineCPU,
                       enabledCPUPercent: enabledCPU, cpuDeltaPoints: delta,
                       cpuNote: baselineNote ?? enabledNote,
                       manualSetAXError: manualError.rawValue,
                       manualWindowSetAXError: manualWindowError?.rawValue,
                       enhancedSetAXError: enhancedError?.rawValue,
                       enhancedWindowSetAXError: enhancedWindowError?.rawValue,
                       restoreAXErrors: restoreErrors,
                       beforeTruncated: before.truncated, afterTruncated: after.truncated,
                       beforeWebAreas: before.webAreas, afterWebAreas: after.webAreas,
                       beforeNodes: before.nodes, afterNodes: after.nodes,
                       preexistingTree: preexistingTree)
}

let trusted = AXIsProcessTrusted()
AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 2)
for browser in browsers where chosen == nil || chosen == browser.name {
    let installed = NSWorkspace.shared.urlForApplication(withBundleIdentifier: browser.bundleID) != nil
    let running = NSRunningApplication.runningApplications(withBundleIdentifier: browser.bundleID).first
    if !installed && running == nil {
        emit(result(browser, "absent", nil, trusted))
    } else if let running {
        let pid = running.processIdentifier
        if !measure { emit(result(browser, "running", pid, trusted)) }
        else if !trusted { emit(result(browser, "tcc_untrusted", pid, false)) }
        else { emit(probe(browser, pid)) }
    } else {
        emit(result(browser, "not_running", nil, trusted))
    }
}
