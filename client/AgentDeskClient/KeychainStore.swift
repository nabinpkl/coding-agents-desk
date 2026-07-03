import Foundation
import Security
import AgentDeskWire

enum KeychainError: Error {
    case unexpectedStatus(OSStatus)
}

struct StoredPairingRecord: Codable, Equatable {
    let token: SessionToken
    let hostPublicKey: Data
    let tailnetFQDN: String
    let tailnetIPv4: String
    // Host's signaling port, learned from the pairing offer. Persisted so a
    // re-dial after app relaunch reaches the same host (and the right tier)
    // without assuming a default port.
    let signalingPort: UInt16
}

protocol SessionTokenStoring {
    func load() throws -> StoredPairingRecord?
    func store(_ record: StoredPairingRecord) throws
    func clear() throws
}

struct KeychainSessionTokenStore: SessionTokenStoring {
    let service: String
    let account: String
    let accessGroup: String?

    init(
        service: String = Config.keychainService,
        account: String = Config.storedPairingAccount,
        accessGroup: String? = Config.keychainAccessGroup
    ) {
        self.service = service
        self.account = account
        self.accessGroup = accessGroup
    }

    func load() throws -> StoredPairingRecord? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess, let data = result as? Data else {
            throw KeychainError.unexpectedStatus(status)
        }
        return try JSONDecoder().decode(StoredPairingRecord.self, from: data)
    }

    func store(_ record: StoredPairingRecord) throws {
        let data = try JSONEncoder().encode(record)
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

    func clear() throws {
        let status = SecItemDelete(baseQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.unexpectedStatus(status)
        }
    }

    private func baseQuery() -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        if let accessGroup {
            query[kSecAttrAccessGroup as String] = accessGroup
        }
        return query
    }
}
