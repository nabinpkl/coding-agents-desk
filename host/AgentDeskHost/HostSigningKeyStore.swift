import CryptoKit
import Foundation
import Security

enum SigningKeyStorage: String {
    case secureEnclave
    case keychainPlain
}

enum HostSigningKeyError: Error {
    case accessControlUnavailable
}

enum HostSigningKey {
    case secureEnclave(SecureEnclave.P256.Signing.PrivateKey)
    case plain(P256.Signing.PrivateKey)

    var storage: SigningKeyStorage {
        switch self {
        case .secureEnclave:
            return .secureEnclave
        case .plain:
            return .keychainPlain
        }
    }

    var publicKey: P256.Signing.PublicKey {
        switch self {
        case .secureEnclave(let key):
            return key.publicKey
        case .plain(let key):
            return key.publicKey
        }
    }

    func signature(for data: Data) throws -> P256.Signing.ECDSASignature {
        switch self {
        case .secureEnclave(let key):
            return try key.signature(for: data)
        case .plain(let key):
            return try key.signature(for: data)
        }
    }
}

protocol HostSigningKeyProviding {
    func loadOrCreate() throws -> HostSigningKey
}

struct HostSigningKeyStore: HostSigningKeyProviding {
    let keychain: KeychainStore

    init(keychain: KeychainStore = KeychainStore()) {
        self.keychain = keychain
    }

    func loadOrCreate() throws -> HostSigningKey {
        if SecureEnclave.isAvailable {
            return try loadOrCreateSecureEnclaveKey()
        }
        return try loadOrCreatePlainKey()
    }

    private func loadOrCreateSecureEnclaveKey() throws -> HostSigningKey {
        if let data = try keychain.read(account: Config.hostSigningKeyAccount) {
            return try .secureEnclave(SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: data))
        }

        var accessError: Unmanaged<CFError>?
        guard let accessControl = SecAccessControlCreateWithFlags(
            kCFAllocatorDefault,
            kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            [.privateKeyUsage],
            &accessError
        ) else {
            throw HostSigningKeyError.accessControlUnavailable
        }

        let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: accessControl)
        try keychain.write(key.dataRepresentation, account: Config.hostSigningKeyAccount)
        return .secureEnclave(key)
    }

    private func loadOrCreatePlainKey() throws -> HostSigningKey {
        if let data = try keychain.read(account: Config.hostSigningKeyAccount) {
            return try .plain(P256.Signing.PrivateKey(rawRepresentation: data))
        }
        let key = P256.Signing.PrivateKey()
        try keychain.write(key.rawRepresentation, account: Config.hostSigningKeyAccount)
        return .plain(key)
    }
}

extension P256.Signing.PublicKey {
    var agentDeskFingerprint: String {
        SHA256.hash(data: derRepresentation)
            .map { String(format: "%02x", $0) }
            .joined()
    }
}
