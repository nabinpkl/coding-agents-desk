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

    // AGENTDESK_DEV_PERMISSIVE_KEYSTORE=1 disables the Secure Enclave path
    // and stores the host's P-256 key in a flat file under Application
    // Support so the legacy-keychain ACL prompt doesn't fire after every
    // rebuild. Dev convenience only; production builds must not set this.
    // Single source of truth: Config.devPermissiveKeystore (also gates the
    // LaunchAgent so a dev run stays a single, identity-stable process).
    private var permissiveDevMode: Bool {
        Config.devPermissiveKeystore
    }

    func loadOrCreate() throws -> HostSigningKey {
        if permissiveDevMode {
            return try loadOrCreateFileBackedKey()
        }
        if SecureEnclave.isAvailable {
            return try loadOrCreateSecureEnclaveKey()
        }
        return try loadOrCreatePlainKey()
    }

    private func loadOrCreateFileBackedKey() throws -> HostSigningKey {
        let url = Config.devHostSigningKeyFile
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        if let data = try? Data(contentsOf: url) {
            return try .plain(P256.Signing.PrivateKey(rawRepresentation: data))
        }
        let key = P256.Signing.PrivateKey()
        try key.rawRepresentation.write(to: url, options: [.atomic, .completeFileProtection])
        return .plain(key)
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
