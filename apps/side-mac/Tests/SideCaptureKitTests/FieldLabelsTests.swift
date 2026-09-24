import Foundation
import XCTest
import SideCaptureKit

private struct FieldFixture: Decodable {
    struct TestCase: Decodable {
        let name: String
        let field: FieldMetadata
        let blocked: Bool
    }

    let cases: [TestCase]
}

final class FieldLabelsTests: XCTestCase {
    func testSharedSyntheticFieldLabelCases() throws {
        // Given the shared Swift/TypeScript field-label fixture.
        let fixtureURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("tests/fixtures/field-labels.json")
        let fixture = try JSONDecoder().decode(FieldFixture.self, from: Data(contentsOf: fixtureURL))

        // When each synthetic field is checked.
        let verdicts = fixture.cases.map { ($0.name, FieldLabels.blockedRule(for: $0.field) != nil, $0.blocked) }

        // Then Swift agrees with every expected shared verdict.
        for (name, actual, expected) in verdicts {
            XCTAssertEqual(actual, expected, name)
        }
    }

    func testSecureFieldTakesPriorityOverLabelMatch() {
        // Given a secure AX field whose title also matches the label pattern.
        let field = FieldMetadata(subrole: "AXSecureTextField", title: "Password")

        // When the field is classified.
        let rule = FieldLabels.blockedRule(for: field)

        // Then the secure AX rule is reported.
        XCTAssertEqual(rule, .secureTextField)
    }

    func testReportedLabelRuleMatchesTypeScriptContract() {
        XCTAssertEqual(FieldLabels.blockedRule(for: FieldMetadata(title: "Password"))?.rawValue,
                       "field-label")
    }
}
