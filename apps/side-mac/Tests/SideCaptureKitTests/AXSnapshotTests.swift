import XCTest
@testable import Side
import SideCaptureKit

private final class FakeSnapshotElement: Equatable {
    static func == (lhs: FakeSnapshotElement, rhs: FakeSnapshotElement) -> Bool { lhs === rhs }

    let role: String
    let subrole: String
    let value: String?
    let title: String?
    let description: String?
    let placeholder: String?
    let children: [FakeSnapshotElement]
    var valueReads = 0
    var childrenReads = 0
    var onValueRead: (() -> Void)?

    init(
        _ role: String, value: String? = nil, subrole: String = "",
        title: String? = nil, description: String? = nil, placeholder: String? = nil,
        children: [FakeSnapshotElement] = []
    ) {
        self.role = role
        self.subrole = subrole
        self.value = value
        self.title = title
        self.description = description
        self.placeholder = placeholder
        self.children = children
    }
}

private struct FakeSnapshotReader: AXSnapshotReading {
    let focusedWindow: (pid_t) -> FakeSnapshotElement?

    func focusedWindow(for pid: pid_t) -> FakeSnapshotElement? { focusedWindow(pid) }
    func role(of element: FakeSnapshotElement) -> String { element.role }
    func subrole(of element: FakeSnapshotElement) -> String { element.subrole }
    func value(of element: FakeSnapshotElement) -> String? {
        element.valueReads += 1
        element.onValueRead?()
        return element.value
    }
    func children(of element: FakeSnapshotElement) -> [FakeSnapshotElement] {
        element.childrenReads += 1
        return element.children
    }
    func fieldMetadata(of element: FakeSnapshotElement) -> FieldMetadata {
        FieldMetadata(
            role: element.role, subrole: element.subrole,
            title: element.title, description: element.description, placeholder: element.placeholder
        )
    }
}

final class AXSnapshotTests: XCTestCase {
    private let bundleID = "com.example.Editor"
    private let pid: pid_t = 4242
    private let windowID: UInt32 = 17

    func testCaptureExtractsStaticTextWithoutReadingSecureFieldOrDescendants() {
        // Given a focused window with safe text and secure fields in both AX forms.
        let hiddenChild = FakeSnapshotElement("AXStaticText", value: "synthetic hidden child")
        let secureBySubrole = FakeSnapshotElement(
            "AXTextField", value: "synthetic secret", subrole: "AXSecureTextField", children: [hiddenChild]
        )
        let secureByRole = FakeSnapshotElement("AXSecureTextField", value: "synthetic secret")
        let safe = FakeSnapshotElement("AXStaticText", value: "safe")
        let root = FakeSnapshotElement("AXWindow", children: [secureBySubrole, secureByRole, safe])
        let front = AXSnapshotForeground(bundleID: bundleID, pid: pid, windowID: windowID)
        let snapshot = AXSnapshot(
            reader: FakeSnapshotReader(focusedWindow: { _ in root }),
            foreground: { front }
        )

        // When the requested window is captured.
        let text = snapshot.capture(bundleID: bundleID, windowID: windowID)

        // Then only safe static text is returned; secure values and descendants are not read.
        XCTAssertEqual(text, "safe")
        XCTAssertEqual(secureBySubrole.valueReads, 0)
        XCTAssertEqual(secureBySubrole.childrenReads, 0)
        XCTAssertEqual(secureByRole.valueReads, 0)
        XCTAssertEqual(secureByRole.childrenReads, 0)
        XCTAssertEqual(hiddenChild.valueReads, 0)
        XCTAssertEqual(hiddenChild.childrenReads, 0)
    }

    func testCaptureSkipsBlockedLabelFieldsBeforeReadingTheirDescendants() {
        // Given AX fields blocked by title, description, and placeholder labels.
        let hiddenChildren = (0..<3).map { FakeSnapshotElement("AXStaticText", value: "synthetic secret \($0)") }
        let fields = [
            FakeSnapshotElement("AXTextField", title: "Password", children: [hiddenChildren[0]]),
            FakeSnapshotElement("AXTextField", description: "OTP code", children: [hiddenChildren[1]]),
            FakeSnapshotElement("AXTextArea", placeholder: "Card number", children: [hiddenChildren[2]]),
        ]
        let root = FakeSnapshotElement("AXWindow", children: fields + [FakeSnapshotElement("AXStaticText", value: "safe")])
        let front = AXSnapshotForeground(bundleID: bundleID, pid: pid, windowID: windowID)
        let snapshot = AXSnapshot(
            reader: FakeSnapshotReader(focusedWindow: { _ in root }),
            foreground: { front }
        )

        // When the window is captured.
        let text = snapshot.capture(bundleID: bundleID, windowID: windowID)

        // Then blocked field subtrees are skipped before any value or child read.
        XCTAssertEqual(text, "safe")
        for field in fields {
            XCTAssertEqual(field.valueReads, 0)
            XCTAssertEqual(field.childrenReads, 0)
        }
        for child in hiddenChildren { XCTAssertEqual(child.valueReads, 0) }
    }

    func testCaptureAcceptsUnknownRequestedWindowIDButChecksObservedIdentity() {
        // Given an unspecified request window ID and a concrete stable foreground window.
        let front = AXSnapshotForeground(bundleID: bundleID, pid: pid, windowID: windowID)
        let root = FakeSnapshotElement("AXWindow", children: [FakeSnapshotElement("AXStaticText", value: "safe")])
        let snapshot = AXSnapshot(
            reader: FakeSnapshotReader(focusedWindow: { _ in root }),
            foreground: { front }
        )

        // When the request is captured without a window ID.
        let text = snapshot.capture(bundleID: bundleID, windowID: nil)

        // Then stable content is returned.
        XCTAssertEqual(text, "safe")
    }

    func testCaptureDiscardsUnknownRequestedWindowIDWhenObservedWindowChanges() {
        // Given an unspecified request window ID and a window switch during extraction.
        var front = AXSnapshotForeground(bundleID: bundleID, pid: pid, windowID: windowID)
        let textNode = FakeSnapshotElement("AXStaticText", value: "synthetic private text")
        textNode.onValueRead = { front = AXSnapshotForeground(bundleID: self.bundleID, pid: self.pid, windowID: 18) }
        let root = FakeSnapshotElement("AXWindow", children: [textNode])
        let snapshot = AXSnapshot(
            reader: FakeSnapshotReader(focusedWindow: { _ in root }),
            foreground: { front }
        )

        // When the request is captured without a window ID.
        let text = snapshot.capture(bundleID: bundleID, windowID: nil)

        // Then the observed window change discards the result.
        XCTAssertNil(text)
    }

    func testCaptureDiscardsTextWhenForegroundBundleChangesDuringRead() {
        // Given a static text read that activates another application.
        var front = AXSnapshotForeground(bundleID: bundleID, pid: pid, windowID: windowID)
        let textNode = FakeSnapshotElement("AXStaticText", value: "synthetic private text")
        textNode.onValueRead = { front = AXSnapshotForeground(bundleID: "com.example.Other", pid: 5252, windowID: 18) }
        let root = FakeSnapshotElement("AXWindow", children: [textNode])
        let snapshot = AXSnapshot(
            reader: FakeSnapshotReader(focusedWindow: { _ in root }),
            foreground: { front }
        )

        // When the requested window is captured.
        let text = snapshot.capture(bundleID: bundleID, windowID: windowID)

        // Then content from the former foreground application is discarded.
        XCTAssertNil(text)
    }

    func testCaptureDiscardsTextWhenWindowIDChangesDuringRead() {
        // Given a focused window whose CG window identity changes during AX extraction.
        var front = AXSnapshotForeground(bundleID: bundleID, pid: pid, windowID: windowID)
        let textNode = FakeSnapshotElement("AXStaticText", value: "synthetic private text")
        textNode.onValueRead = { front = AXSnapshotForeground(bundleID: self.bundleID, pid: self.pid, windowID: 18) }
        let root = FakeSnapshotElement("AXWindow", children: [textNode])
        let snapshot = AXSnapshot(
            reader: FakeSnapshotReader(focusedWindow: { _ in root }),
            foreground: { front }
        )

        // When the requested window is captured.
        let text = snapshot.capture(bundleID: bundleID, windowID: windowID)

        // Then the stale window's content is discarded.
        XCTAssertNil(text)
    }

    func testCaptureDiscardsTextWhenAXFocusMovesWithinSameWindowID() {
        // Given AX focus moves while the foreground CG window identity stays the same.
        let replacement = FakeSnapshotElement("AXWindow")
        var focused = FakeSnapshotElement("AXWindow")
        let textNode = FakeSnapshotElement("AXStaticText", value: "synthetic private text")
        focused = FakeSnapshotElement("AXWindow", children: [textNode])
        textNode.onValueRead = { focused = replacement }
        let front = AXSnapshotForeground(bundleID: bundleID, pid: pid, windowID: windowID)
        let snapshot = AXSnapshot(
            reader: FakeSnapshotReader(focusedWindow: { _ in focused }),
            foreground: { front }
        )

        // When the requested window is captured.
        let text = snapshot.capture(bundleID: bundleID, windowID: windowID)

        // Then text from the previously focused AX window is discarded.
        XCTAssertNil(text)
    }

    func testCaptureDiscardsTextWhenForegroundChangesDuringFinalAXCheck() {
        // Given a second AX focus check that coincides with an app switch.
        var front = AXSnapshotForeground(bundleID: bundleID, pid: pid, windowID: windowID)
        let root = FakeSnapshotElement("AXWindow", children: [FakeSnapshotElement("AXStaticText", value: "synthetic text")])
        var focusedReads = 0
        let snapshot = AXSnapshot(reader: FakeSnapshotReader(focusedWindow: { _ in
            focusedReads += 1
            if focusedReads == 2 {
                front = AXSnapshotForeground(bundleID: "com.example.Other", pid: 5252, windowID: 18)
            }
            return root
        }), foreground: { front })

        // When the requested window is captured.
        let text = snapshot.capture(bundleID: bundleID, windowID: windowID)

        // Then a final foreground check discards the stale text.
        XCTAssertNil(text)
    }

    func testCaptureRejectsWrongTargetBeforeReadingAX() {
        // Given a request for another CG window.
        let front = AXSnapshotForeground(bundleID: bundleID, pid: pid, windowID: windowID)
        var focusedReads = 0
        let snapshot = AXSnapshot(reader: FakeSnapshotReader(focusedWindow: { _ in
            focusedReads += 1
            return FakeSnapshotElement("AXWindow")
        }), foreground: { front })

        // When the request is captured.
        let text = snapshot.capture(bundleID: bundleID, windowID: 18)

        // Then no AX tree is read for the wrong target.
        XCTAssertNil(text)
        XCTAssertEqual(focusedReads, 0)
    }

    func testCaptureUsesAXTextNodeAndCharacterLimits() {
        // Given more than 100 children and static content longer than 12,000 characters.
        let longText = FakeSnapshotElement("AXStaticText", value: String(repeating: "a", count: 12_100))
        let children = [longText] + (1..<100).map { FakeSnapshotElement("AXGroup", value: "\($0)") }
            + [FakeSnapshotElement("AXStaticText", value: "outside child limit")]
        let root = FakeSnapshotElement("AXWindow", children: children)
        let front = AXSnapshotForeground(bundleID: bundleID, pid: pid, windowID: windowID)
        let snapshot = AXSnapshot(
            reader: FakeSnapshotReader(focusedWindow: { _ in root }),
            foreground: { front }
        )

        // When the requested window is captured.
        let text = snapshot.capture(bundleID: bundleID, windowID: windowID)

        // Then the kit truncates output and excludes the 101st child.
        XCTAssertEqual(text?.count, 12_000)
        XCTAssertFalse(text?.contains("outside child limit") ?? true)
    }
}
