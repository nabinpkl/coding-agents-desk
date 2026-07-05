import CryptoKit
import Foundation
import Security
import os
import AgentDeskWire

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
    // ADR-0019: human-readable label from the tailnet pick, so the host can show
    // which device it paired with instead of the opaque fingerprint. Optional and
    // decode-tolerant: records written before this field decode with name == nil.
    var name: String?
}

// ADR-0019: result of consuming a pre-approval. Distinguishes "was pre-approved"
// (non-nil) from "not pre-approved" (nil), and carries the picked device name.
struct PreApproval {
    let name: String?
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
    private let logger = Logger(subsystem: Config.logSubsystem, category: "pairing")
    private var nonceIssuedAt: [String: Date] = [:]
    // ADR-0019: nonces minted for a Mac-pushed pairing offer, mapped to the
    // picked device's display name. The host-side pick is the authorization, so a
    // device that dials back with one of these nonces skips the approval prompt.
    // Key present means pre-approved; the value (optional) is the device name.
    private var preApprovals: [String: String?] = [:]

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
            try loadSigningKey(context: "storage-check").storage
        }
    }

    func signingKey() throws -> HostSigningKey {
        try loadSigningKey(context: "session-auth")
    }

    func mintPairingPayload() throws -> PairingPayload {
        let key = try loadSigningKey(context: "pairing-payload")
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
            expiresAt: Int(issuedAt.addingTimeInterval(nonceTTL).timeIntervalSince1970),
            signalingPort: Config.signalingPort
        )
    }

    private func loadSigningKey(context: String) throws -> HostSigningKey {
        do {
            let key = try keyProvider.loadOrCreate()
            logger.notice("host signing key loaded context=\(context, privacy: .public) signingKeyStorage=\(key.storage.rawValue, privacy: .public)")
            return key
        } catch {
            logger.error("host signing key load failed context=\(context, privacy: .public) reason=\(String(describing: error), privacy: .public)")
            throw error
        }
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
                lastSeenAt: nil,
                name: nil
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

    // ADR-0019: mark a freshly minted nonce as pre-approved because the user
    // picked this device on the Mac, tagging it with the picked device name.
    // Called right after mintPairingPayload when the Mac pushes an offer.
    func markPreApproved(nonce: Data, name: String? = nil) {
        preApprovals[nonce.base64URLEncodedString()] = name
    }

    // Returns a PreApproval exactly once if `nonce` was pre-approved and is still
    // live, otherwise nil. Does not consume the nonce itself;
    // issueApprovedSessionToken stays the single consumption point so the offer
    // path and the prompt path share one replay guard.
    func consumePreApproval(nonce: Data) -> PreApproval? {
        pruneExpiredNonces()
        let key = nonce.base64URLEncodedString()
        guard let storedName = preApprovals.removeValue(forKey: key),
              nonceIssuedAt[key] != nil else {
            return nil
        }
        return PreApproval(name: storedName)
    }

    // ADR-0019: attach a display name to a paired record (from the tailnet pick),
    // so the host can show which device it paired with.
    func setName(_ name: String, for deviceFingerprint: DeviceFingerprint) throws {
        var records = try pairedDevices.load()
        guard let index = records.firstIndex(where: { $0.deviceFingerprint == deviceFingerprint }) else {
            return
        }
        records[index].name = name
        try pairedDevices.save(records)
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
        // A pre-approval is only meaningful while its nonce is live; drop any
        // whose nonce has expired or already been consumed so the map cannot
        // grow and an expired pre-approval cannot auto-approve.
        preApprovals = preApprovals.filter { nonceIssuedAt[$0.key] != nil }
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
