import ImageIO
import XCTest
@testable import Side

final class OCRTests: XCTestCase {
    func testRecognizesSyntheticFixtureInMemory() throws {
        // Given the same synthetic image used by the tesseract test.
        let fixtureURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("../../../../tests/fixtures/ocr.png")
            .standardizedFileURL
        let imageData = try Data(contentsOf: fixtureURL)
        guard let source = CGImageSourceCreateWithData(imageData as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            return XCTFail("Could not decode OCR fixture")
        }

        // When Vision recognizes the in-memory image.
        let text = try WindowOCR.recognize(image: image)

        // Then it contains the established tesseract expectation.
        XCTAssertTrue(text.contains("LOCAL CONTEXT"))
    }
}
