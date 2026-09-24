import Foundation
import XCTest
@testable import Side

@MainActor
final class MenuBarRPCTests: XCTestCase {
    func testStatusReadsApprovedCaptureFieldsOverUDS() async throws {
        // Given a synthetic daemon with a timed pause.
        let server = try OneShotRPCServer(result: [
            "enabled": true, "state": "paused", "paused_until": 1_800_000, "banner": "none",
        ])
        defer { server.close() }

        // When the menu opens and reads status.
        let status = try await UDSMenuBarService(socketPath: server.path).fetchStatus()

        // Then the approved method and pause fields cross the UDS boundary.
        XCTAssertEqual(status.state, .paused)
        XCTAssertEqual(status.pausedUntil, 1_800_000)
        XCTAssertEqual(try server.receivedRequest()["method"] as? String, "status")
    }

    func testThirtyMinutePauseSendsApprovedDurationOverUDS() async throws {
        // Given a synthetic daemon accepting a timed pause.
        let server = try OneShotRPCServer(result: ["paused_until": 1_800_000])
        defer { server.close() }

        // When the menu requests a 30 minute pause.
        try await UDSMenuBarService(socketPath: server.path).pause(.thirtyMinutes)

        // Then the approved duration reaches the daemon over UDS.
        let request = try server.receivedRequest()
        XCTAssertEqual(request["method"] as? String, "pause")
        XCTAssertEqual((request["params"] as? [String: Any])?["durationMs"] as? Int, 1_800_000)
    }

    func testResumeCallsApprovedMethodOverUDS() async throws {
        // Given a synthetic daemon accepting resume.
        let server = try OneShotRPCServer(result: ["resumed": true])
        defer { server.close() }

        // When the menu resumes capture.
        try await UDSMenuBarService(socketPath: server.path).resume()

        // Then resume reaches the daemon without adding another API method.
        XCTAssertEqual(try server.receivedRequest()["method"] as? String, "resume")
    }
}
