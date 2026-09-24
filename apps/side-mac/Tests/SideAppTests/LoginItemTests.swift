import XCTest
@testable import Side

@MainActor
private final class FakeLoginItemService: LoginItemServicing {
    var status: LoginItemStatus = .notRegistered
    var registerCount = 0
    var unregisterCount = 0
    var failure: Error?

    func register() throws {
        registerCount += 1
        if let failure { throw failure }
        status = .enabled
    }

    func unregister() throws {
        unregisterCount += 1
        if let failure { throw failure }
        status = .notRegistered
    }
}

@MainActor
final class LoginItemTests: XCTestCase {
    func testRegisterAndUnregisterFollowUserToggle() async {
        // Given an unregistered login item.
        let service = FakeLoginItemService()
        let state = LoginItemState(service: service)

        // When the user enables Open at Login.
        await state.setEnabled(true)

        // Then the app is registered and the menu reflects it.
        XCTAssertEqual(service.registerCount, 1)
        XCTAssertTrue(state.isEnabled)

        // When the user disables Open at Login.
        await state.setEnabled(false)

        // Then the app is unregistered and the menu reflects it.
        XCTAssertEqual(service.unregisterCount, 1)
        XCTAssertFalse(state.isEnabled)
    }

    func testMenuRefreshShowsSystemApprovalState() {
        // Given a registered item that requires approval in System Settings.
        let service = FakeLoginItemService()
        service.status = .requiresApproval
        let state = LoginItemState(service: service)

        // When the menu reads the current system state.
        state.refresh()

        // Then registration and the approval requirement are both visible.
        XCTAssertTrue(state.isEnabled)
        XCTAssertTrue(state.requiresApproval)
    }

    func testRegistrationErrorPreservesActualStatus() async {
        // Given an item whose registration is denied by macOS.
        let service = FakeLoginItemService()
        service.failure = NSError(domain: "synthetic", code: 1)
        let state = LoginItemState(service: service)

        // When the user enables Open at Login.
        await state.setEnabled(true)

        // Then the menu remains off and reports the failure.
        XCTAssertFalse(state.isEnabled)
        XCTAssertNotNil(state.errorMessage)
    }
}
