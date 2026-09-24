import XCTest
import SideCaptureKit

final class ChordTests: XCTestCase {
    func testFormatsCommandSFromPhysicalKeyCode() {
        // Given the ANSI S key code and Command modifier.
        // When the chord is formatted.
        let notation = Chord.notation(keyCode: 0x01, modifiers: [.command])

        // Then the documented shortcut notation is produced.
        XCTAssertEqual(notation, "⌘S")
    }

    func testFormatsModifiersInStableOrder() {
        // Given ANSI A with Control, Option, Shift, and Command.
        // When the chord is formatted.
        let notation = Chord.notation(keyCode: 0x00, modifiers: [.command, .shift, .option, .control])

        // Then modifiers use the standard display order.
        XCTAssertEqual(notation, "⌃⌥⇧⌘A")
    }

    func testDiscardsUnmodifiedAndShiftOnlyKeys() {
        // Given ANSI S without a shortcut modifier.
        // When both input variants are formatted.
        let plain = Chord.notation(keyCode: 0x01, modifiers: [])
        let shifted = Chord.notation(keyCode: 0x01, modifiers: [.shift])

        // Then neither produces a keyboard event value.
        XCTAssertNil(plain)
        XCTAssertNil(shifted)
    }

    func testUnknownKeyCodeIsNotRenderedFromTypedCharacters() {
        // Given an unmapped physical key code.
        // When a chord is formatted.
        let notation = Chord.notation(keyCode: 0xFFFF, modifiers: [.command])

        // Then no typed character fallback is used.
        XCTAssertNil(notation)
    }

    func testFormatsCommandDeleteWithoutReadingText() {
        // Given the layout-independent Delete key code.
        // When Command-Delete is formatted.
        let notation = Chord.notation(keyCode: 0x33, modifiers: [.command])

        // Then it is rendered as a symbolic shortcut.
        XCTAssertEqual(notation, "⌘⌫")
    }
}
