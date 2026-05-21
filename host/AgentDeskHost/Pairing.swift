import CryptoKit
import Foundation
import Security

enum PairingError: Error {
    case invalidNonce
    case expiredNonce
    case nonceAlreadyUsed
    case invalidDevicePublicKey
    case randomGenerationFailed
}

struct PairedDeviceRecord: Codable, Equatable {
    let deviceFingerprint: DeviceFingerprint
    let devicePublicKey: Data
    var approvedAt: Int
    var lastSeenAt: Int?
}

struct PairedDeviceStore {
    let url: URL

    init(url: URL = Config.pairedDevicesURL) {
        self.url = url
    }

    func load() throws -> [PairedDeviceRecord] {
        guard FileManager.default.fileExists(atPath: url.path) else {
            return []
        }
        let data = try Data(contentsOf: url)
        return try JSONDecoder().decode([PairedDeviceRecord].self, from: data)
    }

    func save(_ records: [PairedDeviceRecord]) throws {
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(records).write(to: url, options: .atomic)
    }
}

final class Pairing {
    private let keyProvider: HostSigningKeyProviding
    private let tailnetDiscovery: TailnetDiscovering
    private let pairedDevices: PairedDeviceStore
    private let nonceTTL: TimeInterval
    private let now: () -> Date
    private var nonceIssuedAt: [String: Date] = [:]

    init(
        keyProvider: HostSigningKeyProviding = HostSigningKeyStore(),
        tailnetDiscovery: TailnetDiscovering = TailscaleStatusDiscovery(),
        pairedDevices: PairedDeviceStore = PairedDeviceStore(),
        nonceTTL: TimeInterval = Config.nonceTTL,
        now: @escaping () -> Date = Date.init
    ) {
        self.keyProvider = keyProvider
        self.tailnetDiscovery = tailnetDiscovery
        self.pairedDevices = pairedDevices
        self.nonceTTL = nonceTTL
        self.now = now
    }

    var signingKeyStorage: SigningKeyStorage? {
        get throws {
            try keyProvider.loadOrCreate().storage
        }
    }

    func signingKey() throws -> HostSigningKey {
        try keyProvider.loadOrCreate()
    }

    func mintPairingPayload() throws -> PairingPayload {
        let key = try keyProvider.loadOrCreate()
        let tailnet = try tailnetDiscovery.currentIdentity()
        let nonce = try randomBytes(count: 32)
        let issuedAt = now()
        nonceIssuedAt[nonce.base64URLEncodedString()] = issuedAt

        return PairingPayload(
            hostFingerprint: key.publicKey.agentDeskFingerprint,
            hostPublicKey: key.publicKey.x963Representation,
            tailnetFQDN: tailnet.fqdn,
            tailnetIPv4: tailnet.ipv4,
            oneTimeNonce: nonce,
            expiresAt: Int(issuedAt.addingTimeInterval(nonceTTL).timeIntervalSince1970)
        )
    }

    func approve(devicePublicKey: Data) throws {
        let fingerprint = try deviceFingerprint(for: devicePublicKey)
        var records = try pairedDevices.load()
        let approvedAt = Int(now().timeIntervalSince1970)
        if let index = records.firstIndex(where: { $0.deviceFingerprint == fingerprint }) {
            records[index].approvedAt = approvedAt
        } else {
            records.append(PairedDeviceRecord(
                deviceFingerprint: fingerprint,
                devicePublicKey: devicePublicKey,
                approvedAt: approvedAt,
                lastSeenAt: nil
            ))
        }
        try pairedDevices.save(records)
    }

    func approve(devicePublicKey: Data, oneTimeNonce: Data) throws {
        try consumeNonce(oneTimeNonce)
        try approve(devicePublicKey: devicePublicKey)
    }

    func pendingDeviceFingerprint(devicePublicKey: Data, oneTimeNonce: Data) throws -> DeviceFingerprint {
        try validateNonce(oneTimeNonce)
        return try deviceFingerprint(for: devicePublicKey)
    }

    func issueApprovedSessionToken(devicePublicKey: Data, oneTimeNonce: Data) throws -> SessionToken {
        let fingerprint = try deviceFingerprint(for: devicePublicKey)
        try approve(devicePublicKey: devicePublicKey, oneTimeNonce: oneTimeNonce)
        return try sessionToken(for: fingerprint)
    }

    func lookup(deviceFingerprint: DeviceFingerprint) throws -> PairedDeviceRecord? {
        try pairedDevices.load().first { $0.deviceFingerprint == deviceFingerprint }
    }

    func validate(token: SessionToken) -> Bool {
        do {
            guard try pairedDevices.load().contains(where: { $0.deviceFingerprint == token.deviceFingerprint }) else {
                return false
            }
            let key = try keyProvider.loadOrCreate()
            guard token.hostFingerprint == key.publicKey.agentDeskFingerprint else {
                return false
            }
            let signature = try P256.Signing.ECDSASignature(rawRepresentation: token.signature)
            return key.publicKey.isValidSignature(signature, for: Self.signingData(
                hostFingerprint: token.hostFingerprint,
                deviceFingerprint: token.deviceFingerprint,
                issuedAt: token.issuedAt
            ))
        } catch {
            return false
        }
    }

    func revoke(deviceFingerprint: DeviceFingerprint) throws {
        let records = try pairedDevices.load().filter { $0.deviceFingerprint != deviceFingerprint }
        try pairedDevices.save(records)
    }

    func markSeen(deviceFingerprint: DeviceFingerprint) throws {
        var records = try pairedDevices.load()
        guard let index = records.firstIndex(where: { $0.deviceFingerprint == deviceFingerprint }) else {
            return
        }
        records[index].lastSeenAt = Int(now().timeIntervalSince1970)
        try pairedDevices.save(records)
    }

    func approvedDevices() throws -> [PairedDeviceRecord] {
        try pairedDevices.load()
    }

    func sessionToken(for deviceFingerprint: DeviceFingerprint) throws -> SessionToken {
        let key = try keyProvider.loadOrCreate()
        let issuedAt = Int(now().timeIntervalSince1970)
        let hostFingerprint = key.publicKey.agentDeskFingerprint
        let data = Self.signingData(
            hostFingerprint: hostFingerprint,
            deviceFingerprint: deviceFingerprint,
            issuedAt: issuedAt
        )
        let signature = try key.signature(for: data)
        return SessionToken(
            hostFingerprint: hostFingerprint,
            deviceFingerprint: deviceFingerprint,
            issuedAt: issuedAt,
            signature: signature.rawRepresentation
        )
    }

    func deviceFingerprint(for devicePublicKey: Data) throws -> DeviceFingerprint {
        do {
            let publicKey = try P256.Signing.PublicKey(x963Representation: devicePublicKey)
            return DeviceFingerprint(publicKey.agentDeskFingerprint)
        } catch {
            throw PairingError.invalidDevicePublicKey
        }
    }

    static func signingData(hostFingerprint: String, deviceFingerprint: DeviceFingerprint, issuedAt: Int) -> Data {
        var data = Data()
        data.append(Data(hostFingerprint.utf8))
        data.append(Data(deviceFingerprint.rawValue.utf8))
        var issuedAtBigEndian = Int64(issuedAt).bigEndian
        withUnsafeBytes(of: &issuedAtBigEndian) { data.append(contentsOf: $0) }
        return data
    }

    private func validateNonce(_ nonce: Data) throws {
        pruneExpiredNonces()
        let key = nonce.base64URLEncodedString()
        guard let issuedAt = nonceIssuedAt[key] else {
            throw PairingError.invalidNonce
        }
        guard now().timeIntervalSince(issuedAt) <= nonceTTL else {
            nonceIssuedAt.removeValue(forKey: key)
            throw PairingError.expiredNonce
        }
    }

    private func consumeNonce(_ nonce: Data) throws {
        try validateNonce(nonce)
        let key = nonce.base64URLEncodedString()
        guard nonceIssuedAt.removeValue(forKey: key) != nil else {
            throw PairingError.nonceAlreadyUsed
        }
    }

    private func pruneExpiredNonces() {
        let current = now()
        nonceIssuedAt = nonceIssuedAt.filter { current.timeIntervalSince($0.value) <= nonceTTL }
    }

    private func randomBytes(count: Int) throws -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        let status = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        guard status == errSecSuccess else {
            throw PairingError.randomGenerationFailed
        }
        return Data(bytes)
    }
}
