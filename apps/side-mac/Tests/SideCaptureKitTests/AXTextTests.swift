import XCTest
import SideCaptureKit

private final class StubAXNode: AXTextNode {
    let role: String
    let subrole: String
    let children: [StubAXNode]
    private let storedValue: String?
    private(set) var valueReads = 0

    var value: String? {
        valueReads += 1
        return storedValue
    }

    init(_ role: String, value: String? = nil, subrole: String = "", children: [StubAXNode] = []) {
        self.role = role
        self.storedValue = value
        self.subrole = subrole
        self.children = children
    }
}

final class AXTextTests: XCTestCase {
    func testExtractsDistinctStaticTextInBreadthFirstOrder() {
        // Given a nested synthetic AX tree with repeated text.
        let nested = StubAXNode("AXStaticText", value: " second ")
        let root = StubAXNode("AXWindow", children: [
            StubAXNode("AXGroup", children: [nested]),
            StubAXNode("AXStaticText", value: " first "),
            StubAXNode("AXStaticText", value: " first "),
            StubAXNode("AXTextField", value: "not static"),
        ])

        // When the tree is extracted.
        let text = AXText.extract(from: root)

        // Then only distinct static values appear in breadth-first order.
        XCTAssertEqual(text, "first\nsecond")
    }

    func testSecureFieldAndItsDescendantsAreNeverRead() {
        // Given a secure field that contains a synthetic child value.
        let child = StubAXNode("AXStaticText", value: "synthetic secret")
        let secure = StubAXNode("AXStaticText", value: "synthetic secret", subrole: "AXSecureTextField", children: [child])
        let secureRole = StubAXNode("AXSecureTextField", value: "synthetic secret")
        let root = StubAXNode("AXWindow", children: [secure, secureRole, StubAXNode("AXStaticText", value: "safe")])

        // When the tree is extracted.
        let text = AXText.extract(from: root)

        // Then neither the secure value nor its child is read.
        XCTAssertEqual(text, "safe")
        XCTAssertEqual(secure.valueReads, 0)
        XCTAssertEqual(secureRole.valueReads, 0)
        XCTAssertEqual(child.valueReads, 0)
    }

    func testStopsAtFourHundredNodes() {
        // Given a chain with one root and 400 static text descendants.
        var node = StubAXNode("AXStaticText", value: "outside limit")
        for _ in 0..<400 {
            node = StubAXNode("AXGroup", children: [node])
        }

        // When extraction reaches the node limit.
        let text = AXText.extract(from: node)

        // Then the 401st node is not read.
        XCTAssertEqual(text, "")
    }

    func testStopsAtTwelveThousandCharactersIncludingSeparator() {
        // Given two static values whose combined output crosses the limit.
        let first = String(repeating: "a", count: 11_998)
        let root = StubAXNode("AXWindow", children: [
            StubAXNode("AXStaticText", value: first),
            StubAXNode("AXStaticText", value: "bc"),
        ])

        // When the tree is extracted.
        let text = AXText.extract(from: root)

        // Then output, including the separator, stays within 12,000 characters.
        XCTAssertEqual(text, first + "\nb")
        XCTAssertEqual(text.count, 12_000)
    }

    func testVisitsOnlyFirstHundredChildrenOfEachNode() {
        // Given more than 100 direct children.
        let children = (0..<100).map { StubAXNode("AXStaticText", value: "\($0)") }
            + [StubAXNode("AXStaticText", value: "outside limit")]
        let root = StubAXNode("AXWindow", children: children)

        // When the tree is extracted.
        let text = AXText.extract(from: root)

        // Then the 101st child is never visited.
        XCTAssertEqual(text.split(separator: "\n").count, 100)
        XCTAssertFalse(text.contains("outside limit"))
    }
}
