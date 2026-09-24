import CoreGraphics
import ScreenCaptureKit
import Vision

enum WindowOCR {
    static func captureText(for window: SCWindow) async throws -> String {
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let configuration = SCStreamConfiguration()
        let scale = CGFloat(filter.pointPixelScale)
        configuration.width = Int((filter.contentRect.width * scale).rounded(.up))
        configuration.height = Int((filter.contentRect.height * scale).rounded(.up))

        let image = try await SCScreenshotManager.captureImage(
            contentFilter: filter,
            configuration: configuration
        )
        return try recognize(image: image)
    }

    static func recognize(image: CGImage) throws -> String {
        let request = VNRecognizeTextRequest()
        request.recognitionLanguages = ["ko-KR", "en-US"]
        request.recognitionLevel = .accurate

        try VNImageRequestHandler(cgImage: image).perform([request])
        return request.results?
            .compactMap { $0.topCandidates(1).first?.string }
            .joined(separator: "\n") ?? ""
    }
}
