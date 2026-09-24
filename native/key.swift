import Foundation
import Security

let service = "local-context-awareness-ledger"
let account = NSUserName()
let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
    kSecReturnData as String: true,
    kSecMatchLimit as String: kSecMatchLimitOne
]

var result: CFTypeRef?
let status = SecItemCopyMatching(query as CFDictionary, &result)
if status == errSecSuccess, let data = result as? Data, data.count == 32 {
    print(data.base64EncodedString())
    exit(0)
}
if status != errSecItemNotFound {
    fputs("Keychain read failed: \(status)\n", stderr)
    exit(1)
}

var bytes = [UInt8](repeating: 0, count: 32)
guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
    fputs("Random key generation failed\n", stderr)
    exit(1)
}
let key = Data(bytes)
var add = query
add.removeValue(forKey: kSecReturnData as String)
add.removeValue(forKey: kSecMatchLimit as String)
add[kSecValueData as String] = key
add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
let addStatus = SecItemAdd(add as CFDictionary, nil)
guard addStatus == errSecSuccess else {
    fputs("Keychain write failed: \(addStatus)\n", stderr)
    exit(1)
}
print(key.base64EncodedString())
