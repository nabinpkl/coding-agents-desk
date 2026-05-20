import CryptoKit
import Foundation
import Security

enum DeviceSigningKeyError: Error {
    case secureEnclaveUnavailable
    case accessControlUnavailable
}

protocol DeviceSigningKeyProviding {
    var publicKey: P256.Signing.PublicKey { get throws }
    func signature(for data: Data) throws -> P256.Signing.ECDSASignature
}

final class SecureEnclaveDeviceSigningKeyStore: DeviceSigningKeyProviding {
    private let keychain = KeychainSessionTokenStore()
    private var cachedKey: SecureEnclave.P256.Signing.PrivateKey?
    private let account = "device-signing-key"

    var publicKey: P256.Signing.PublicKey {
        get throws { try loadOrCreate().publicKey }
    }

    func signature(for data: Data) throws -> P256.Signing.ECDSASignature {
        try loadOrCreate().signature(for: data)
    }

    private func loadOrCreate() throws -> SecureEnclave.P256.Signing.PrivateKey {
        if let cachedKey {
            return cachedKey
        }
        guard SecureEnclave.isAvailable else {
            throw DeviceSigningKeyError.secureEnclaveUnavailable
        }
        if let data = try readKeyData() {
            let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: data)
            cachedKey = key
            return key
        }

        var accessError: Unmanaged<CFError>?
        guard let accessControl = SecAccessControlCreateWithFlags(
            kCFAllocatorDefault,
            kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            [.privateKeyUsage],
            &accessError
        ) else {
            throw DeviceSigningKeyError.accessControlUnavailable
        }
        let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: accessControl)
        try writeKeyData(key.dataRepresentation)
        cachedKey = key
        return key
    }

    private func readKeyData() throws -> Data? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess else {
            throw KeychainError.unexpectedStatus(status)
        }
        return result as? Data
    }

    private func writeKeyData(_ data: Data) throws {
        var query = baseQuery()
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess {
            return
        }
        guard updateStatus == errSecItemNotFound else {
            throw KeychainError.unexpectedStatus(updateStatus)
        }
        query.merge(attributes) { _, new in new }
        let addStatus = SecItemAdd(query as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw KeychainError.unexpectedStatus(addStatus)
        }
    }

    private func baseQuery() -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Config.keychainService,
            kSecAttrAccount as String: account
        ]
        if let accessGroup = Config.keychainAccessGroup {
            query[kSecAttrAccessGroup as String] = accessGroup
        }
        return query
    }
}
