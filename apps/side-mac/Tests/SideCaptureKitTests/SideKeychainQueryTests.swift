import LocalAuthentication
import Security
import XCTest
@testable import Side

final class SideKeychainQueryTests: XCTestCase {
    func testProviderMetadataQueryFailsWhenAuthenticationUIIsNeeded() throws {
        let query = SideKeychain(account: "synthetic").nonInteractiveQuery(
            service: SideKeychain.providerService, account: "synthetic-ref", returnAttributes: true
        )

        XCTAssertEqual(query[kSecReturnAttributes as String] as? Bool, true)
        XCTAssertNil(query[kSecReturnData as String])
        XCTAssertEqual(query[kSecUseAuthenticationUI as String] as? String, kSecUseAuthenticationUIFail as String)
        XCTAssertEqual((query[kSecUseAuthenticationContext as String] as? LAContext)?.interactionNotAllowed, true)
    }

    func testProviderDataQueryFailsWhenAuthenticationUIIsNeeded() throws {
        let query = SideKeychain(account: "synthetic").nonInteractiveQuery(
            service: SideKeychain.providerService, account: "synthetic-ref", returnAttributes: false
        )

        XCTAssertEqual(query[kSecReturnData as String] as? Bool, true)
        XCTAssertNil(query[kSecReturnAttributes as String])
        XCTAssertEqual(query[kSecUseAuthenticationUI as String] as? String, kSecUseAuthenticationUIFail as String)
        XCTAssertEqual((query[kSecUseAuthenticationContext as String] as? LAContext)?.interactionNotAllowed, true)
    }
}
