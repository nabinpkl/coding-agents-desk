import CryptoKit
import Foundation
import Security

// ADR-0003 session-establishment, host side. Pure logic; the network plumbing
// in PairingSignalingServer drives it. A new authenticator is constructed per
// inbound connection so the replay-protection set is scoped to the handshake.

struct PendingSessionHandshake: Equatable {
    let deviceFingerprint: DeviceFingerprint
    let devicePublicKey: Data
    let clientNonce: Data
    let hostNonce: Data
}

final class SessionAuthenticator {
    private let pairing: Pairing
    private let randomBytes: (Int) throws -> Data
    private let now: () -> Date
    private var seenClientNonces: Set<Data> = []
    private(set) var pending: PendingSessionHandshake?

    init(
        pairing: Pairing,
        randomBytes: @escaping (Int) throws -> Data = SessionAuthenticator.systemRandomBytes,
        now: @escaping () -> Date = Date.init
    ) {
        self.pairing = pairing
        self.randomBytes = randomBytes
        self.now = now
    }

    func processInit(_ message: SessionInit) throws -> SessionChallenge {
        guard !seenClientNonces.contains(message.clientNonce) else {
            throw SessionRejected(reason: .replay)
        }
        seenClientNonces.insert(message.clientNonce)

        // ADR-0020: reject a client whose wire protocol predates what this host
        // still supports. The returned SessionChallenge carries the host's
        // protocol version so the client can apply the symmetric check.
        guard message.protocolVersion >= Config.minCompatibleProtocolVersion else {
            throw SessionRejected(reason: .incompatibleProtocol)
        }

        guard let record = try pairing.lookup(deviceFingerprint: message.deviceFingerprint) else {
            throw SessionRejected(reason: .unknownDevice)
        }

        let key = try pairing.signingKey()
        let hostFingerprint = key.publicKey.agentDeskFingerprint
        let hostNonce = try randomBytes(32)

        let input = SessionSigning.canonicalInput(
            clientNonce: message.clientNonce,
            hostNonce: hostNonce,
            hostFingerprint: hostFingerprint,
            deviceFingerprint: record.deviceFingerprint
        )
        let signature = try key.signature(for: input)

        pending = PendingSessionHandshake(
            deviceFingerprint: record.deviceFingerprint,
            devicePublicKey: record.devicePublicKey,
            clientNonce: message.clientNonce,
            hostNonce: hostNonce
        )

        return SessionChallenge(hostNonce: hostNonce, hostSignature: signature.rawRepresentation)
    }

    func processProof(_ message: SessionProof) throws -> (SessionReady, ActiveSession, PendingSessionHandshake) {
        guard let pending else {
            throw SessionRejected(reason: .malformed)
        }
        let key = try pairing.signingKey()
        let hostFingerprint = key.publicKey.agentDeskFingerprint
        let input = SessionSigning.canonicalInput(
            clientNonce: pending.clientNonce,
            hostNonce: pending.hostNonce,
            hostFingerprint: hostFingerprint,
            deviceFingerprint: pending.deviceFingerprint
        )
        let devicePublicKey: P256.Signing.PublicKey
        do {
            devicePublicKey = try P256.Signing.PublicKey(x963Representation: pending.devicePublicKey)
        } catch {
            throw SessionRejected(reason: .badSignature)
        }
        let signature: P256.Signing.ECDSASignature
        do {
            signature = try P256.Signing.ECDSASignature(rawRepresentation: message.clientSignature)
        } catch {
            throw SessionRejected(reason: .badSignature)
        }
        guard devicePublicKey.isValidSignature(signature, for: input) else {
            throw SessionRejected(reason: .badSignature)
        }
        try pairing.markSeen(deviceFingerprint: pending.deviceFingerprint)
        let sessionId = try randomBytes(32).base64URLEncodedString()
        let establishedAt = now()
        let resumeId = try randomBytes(32)
        let resumeSecret = try randomBytes(32)
        let mediaKeySalt = try randomBytes(32)
        let resumeExpiresAt = Int(establishedAt.addingTimeInterval(Config.sessionResumeTTL).timeIntervalSince1970)
        let session = ActiveSession(
            sessionId: sessionId,
            deviceFingerprint: pending.deviceFingerprint,
            establishedAt: Int(establishedAt.timeIntervalSince1970)
        )
        self.pending = nil
        return (
            SessionReady(
                sessionId: sessionId,
                resumeId: resumeId,
                resumeSecret: resumeSecret,
                resumeExpiresAt: resumeExpiresAt,
                mediaKeySalt: mediaKeySalt
            ),
            session,
            pending
        )
    }

    static func systemRandomBytes(_ count: Int) throws -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        let status = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        guard status == errSecSuccess else {
            throw SessionRejected(reason: .malformed)
        }
        return Data(bytes)
    }
}
