public struct ChordModifiers: OptionSet {
    public let rawValue: Int

    public init(rawValue: Int) { self.rawValue = rawValue }

    public static let control = ChordModifiers(rawValue: 1 << 0)
    public static let option = ChordModifiers(rawValue: 1 << 1)
    public static let shift = ChordModifiers(rawValue: 1 << 2)
    public static let command = ChordModifiers(rawValue: 1 << 3)
}

public enum Chord {
    // Physical ANSI virtual-key codes from HIToolbox/Events.h; no typed characters are inspected.
    private static let keys: [UInt16: String] = [
        0x00: "A", 0x01: "S", 0x02: "D", 0x03: "F", 0x04: "H", 0x05: "G",
        0x06: "Z", 0x07: "X", 0x08: "C", 0x09: "V", 0x0B: "B", 0x0C: "Q",
        0x0D: "W", 0x0E: "E", 0x0F: "R", 0x10: "Y", 0x11: "T", 0x12: "1",
        0x13: "2", 0x14: "3", 0x15: "4", 0x16: "6", 0x17: "5", 0x18: "=",
        0x19: "9", 0x1A: "7", 0x1B: "-", 0x1C: "8", 0x1D: "0", 0x1E: "]",
        0x1F: "O", 0x20: "U", 0x21: "[", 0x22: "I", 0x23: "P", 0x24: "↩",
        0x25: "L", 0x26: "J", 0x27: "'", 0x28: "K", 0x29: ";", 0x2A: "\\",
        0x2B: ",", 0x2C: "/", 0x2D: "N", 0x2E: "M", 0x2F: ".", 0x30: "⇥",
        0x31: "Space", 0x32: "`", 0x33: "⌫", 0x35: "⎋", 0x7B: "←", 0x7C: "→",
        0x7D: "↓", 0x7E: "↑",
    ]

    public static func notation(keyCode: UInt16, modifiers: ChordModifiers) -> String? {
        guard modifiers.contains(.control) || modifiers.contains(.option) || modifiers.contains(.command),
              let key = keys[keyCode] else {
            return nil
        }

        var notation = ""
        if modifiers.contains(.control) { notation += "⌃" }
        if modifiers.contains(.option) { notation += "⌥" }
        if modifiers.contains(.shift) { notation += "⇧" }
        if modifiers.contains(.command) { notation += "⌘" }
        return notation + key
    }
}
