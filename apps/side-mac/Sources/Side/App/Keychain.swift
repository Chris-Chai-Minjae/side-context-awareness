import Foundation
import Security

protocol SideKeyStore {
    func masterKey() throws -> Data
    func rotateMasterKey() throws -> Data
    func setProviderKey(ref: String, secret: String) throws
    func providerKey(ref: String) throws -> String?
}

enum SideKeychainError: Error {
    case invalidMasterKey
    case invalidProviderKey
    case randomGenerationFailed
    case keychain(OSStatus)
}

struct SideKeychain: SideKeyStore {
    static let masterService = "local-context-awareness-ledger"
    static let providerService = "side-provider-api-key"

    private let account: String

    init(account: String = NSUserName()) {
        self.account = account
    }

    func masterKey() throws -> Data {
        if let existing = try read(service: Self.masterService, account: account) {
            guard existing.count == 32 else { throw SideKeychainError.invalidMasterKey }
            return existing
        }

        let key = try randomKey()
        let status = SecItemAdd(addQuery(service: Self.masterService, account: account, data: key) as CFDictionary, nil)
        if status == errSecDuplicateItem {
            guard let existing = try read(service: Self.masterService, account: account), existing.count == 32 else {
                throw SideKeychainError.invalidMasterKey
            }
            return existing
        }
        guard status == errSecSuccess else { throw SideKeychainError.keychain(status) }
        return key
    }

    func rotateMasterKey() throws -> Data {
        let replacement = try randomKey()
        let status = SecItemDelete(itemQuery(service: Self.masterService, account: account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw SideKeychainError.keychain(status)
        }
        let addStatus = SecItemAdd(
            addQuery(service: Self.masterService, account: account, data: replacement) as CFDictionary,
            nil
        )
        guard addStatus == errSecSuccess else { throw SideKeychainError.keychain(addStatus) }
        return replacement
    }

    func setProviderKey(ref: String, secret: String) throws {
        guard !ref.isEmpty, !secret.isEmpty, let data = secret.data(using: .utf8) else {
            throw SideKeychainError.invalidProviderKey
        }
        let status = SecItemAdd(addQuery(service: Self.providerService, account: ref, data: data) as CFDictionary, nil)
        if status == errSecDuplicateItem {
            let updateStatus = SecItemUpdate(
                itemQuery(service: Self.providerService, account: ref) as CFDictionary,
                [kSecValueData as String: data] as CFDictionary
            )
            guard updateStatus == errSecSuccess else { throw SideKeychainError.keychain(updateStatus) }
            return
        }
        guard status == errSecSuccess else { throw SideKeychainError.keychain(status) }
    }

    func providerKey(ref: String) throws -> String? {
        guard !ref.isEmpty else { throw SideKeychainError.invalidProviderKey }
        guard let data = try read(service: Self.providerService, account: ref) else { return nil }
        guard let secret = String(data: data, encoding: .utf8) else {
            throw SideKeychainError.invalidProviderKey
        }
        return secret
    }

    private func read(service: String, account: String) throws -> Data? {
        var query = itemQuery(service: service, account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw SideKeychainError.keychain(status) }
        guard let data = item as? Data else { throw SideKeychainError.invalidProviderKey }
        return data
    }

    private func itemQuery(service: String, account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    private func addQuery(service: String, account: String, data: Data) -> [String: Any] {
        var query = itemQuery(service: service, account: account)
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        return query
    }

    private func randomKey() throws -> Data {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw SideKeychainError.randomGenerationFailed
        }
        return Data(bytes)
    }
}
