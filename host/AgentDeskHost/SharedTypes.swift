import CryptoKit
import Foundation

struct DeviceFingerprint: Codable, Hashable, Equatable, CustomStringConvertible {
    let rawValue: String

    init(_ rawValue: String) {
        self.rawValue = rawValue
    }

    var description: String { rawValue }
}

// ADR-0002 fixes the P-256 pairing wire shapes mirrored by host and client.
struct PairingPayload: Codable, Equatable {
    let hostFingerprint: String
    let hostPublicKey: Data
    let tailnetFQDN: String
    let tailnetIPv4: String
    let oneTimeNonce: Data
    let expiresAt: Int

    enum CodingKeys: String, CodingKey {
        case hostFingerprint = "h"
        case hostPublicKey = "k"
        case tailnetFQDN = "d"
        case tailnetIPv4 = "i"
        case oneTimeNonce = "n"
        case expiresAt = "e"
    }

    init(
        hostFingerprint: String,
        hostPublicKey: Data,
        tailnetFQDN: String,
        tailnetIPv4: String,
        oneTimeNonce: Data,
        expiresAt: Int
    ) {
        self.hostFingerprint = hostFingerprint
        self.hostPublicKey = hostPublicKey
        self.tailnetFQDN = tailnetFQDN
        self.tailnetIPv4 = tailnetIPv4
        self.oneTimeNonce = oneTimeNonce
        self.expiresAt = expiresAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        hostFingerprint = try container.decode(String.self, forKey: .hostFingerprint)
        hostPublicKey = try Data(base64URLEncoded: container.decode(String.self, forKey: .hostPublicKey))
        tailnetFQDN = try container.decode(String.self, forKey: .tailnetFQDN)
        tailnetIPv4 = try container.decode(String.self, forKey: .tailnetIPv4)
        oneTimeNonce = try Data(base64URLEncoded: container.decode(String.self, forKey: .oneTimeNonce))
        expiresAt = try container.decode(Int.self, forKey: .expiresAt)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(hostFingerprint, forKey: .hostFingerprint)
        try container.encode(hostPublicKey.base64URLEncodedString(), forKey: .hostPublicKey)
        try container.encode(tailnetFQDN, forKey: .tailnetFQDN)
        try container.encode(tailnetIPv4, forKey: .tailnetIPv4)
        try container.encode(oneTimeNonce.base64URLEncodedString(), forKey: .oneTimeNonce)
        try container.encode(expiresAt, forKey: .expiresAt)
    }

    func compactJSONData() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(self)
    }

    func pairingURL() throws -> URL {
        let encodedPayload = try compactJSONData().base64URLEncodedString()
        guard let url = URL(string: "agentdesk://pair?p=\(encodedPayload)") else {
            throw PairingPayloadError.invalidURL
        }
        return url
    }

    static func decode(fromPairingURL url: URL) throws -> PairingPayload {
        guard url.scheme == "agentdesk", url.host == "pair" else {
            throw PairingPayloadError.invalidURL
        }
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        guard let encodedPayload = components?.queryItems?.first(where: { $0.name == "p" })?.value else {
            throw PairingPayloadError.missingPayload
        }
        let payloadData = try Data(base64URLEncoded: encodedPayload)
        return try JSONDecoder().decode(PairingPayload.self, from: payloadData)
    }
}

enum PairingPayloadError: Error {
    case invalidURL
    case missingPayload
    case malformedOffer
}

// Mac-initiated tailnet pairing (ADR-0019). The Mac pushes a pairing offer to
// the iPhone over the tailnet on a dedicated plain-TCP port: a 4-byte
// big-endian length prefix followed by the offer's compact JSON. WireGuard
// encrypts the peer-to-peer hop, the host public key in the payload is public,
// and the one-time nonce is pre-approval-gated, so plaintext on the wire is
// acceptable. Mirror of the client definition.
enum OfferPortFrame {
    static let fixedHeaderByteCount = 4
    static let maxPayloadByteCount = 64 * 1024

    static func encode(_ body: Data) throws -> Data {
        guard body.count <= maxPayloadByteCount else {
            throw PairingPayloadError.malformedOffer
        }
        var encoded = Data()
        var length = UInt32(body.count).bigEndian
        withUnsafeBytes(of: &length) { encoded.append(contentsOf: $0) }
        encoded.append(body)
        return encoded
    }
}

// Accumulates inbound bytes and yields each complete JSON body. Tolerates a
// frame split across multiple reads, the normal case for a streamed TCP
// connection. The caller routes each body via OfferPortMessage.classify.
struct OfferPortFrameParser {
    private var buffer = Data()

    mutating func append(_ chunk: Data) throws -> [Data] {
        buffer.append(chunk)
        guard buffer.count <= OfferPortFrame.maxPayloadByteCount + OfferPortFrame.fixedHeaderByteCount else {
            throw PairingPayloadError.malformedOffer
        }
        var bodies: [Data] = []
        while buffer.count >= OfferPortFrame.fixedHeaderByteCount {
            let header = [UInt8](buffer.prefix(OfferPortFrame.fixedHeaderByteCount))
            let payloadLength = header.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
            guard payloadLength > 0,
                  payloadLength <= UInt32(OfferPortFrame.maxPayloadByteCount) else {
                throw PairingPayloadError.malformedOffer
            }
            let frameLength = OfferPortFrame.fixedHeaderByteCount + Int(payloadLength)
            guard buffer.count >= frameLength else { break }
            let body = Data(
                buffer
                    .dropFirst(OfferPortFrame.fixedHeaderByteCount)
                    .prefix(Int(payloadLength))
            )
            bodies.append(body)
            buffer.removeFirst(frameLength)
        }
        return bodies
    }
}

// ADR-0019: pre-pairing device discovery over the offer port. The host probes
// each tailnet peer with a whois request; an unpaired client replies with a
// display-only identity, so the picker lists real devices instead of the
// tailnet "localhost". Display-only and pre-auth: tailnet membership is the
// trust boundary, and the signed handshake still gates actual pairing.
struct DeviceIdentityRequest: Codable, Equatable {
    let type: String

    enum CodingKeys: String, CodingKey {
        case type = "t"
    }

    init() {
        self.type = "whois"
    }
}

struct DeviceIdentity: Codable, Equatable {
    let type: String
    let displayName: String

    enum CodingKeys: String, CodingKey {
        case type = "t"
        case displayName = "n"
    }

    init(displayName: String) {
        self.type = "id"
        self.displayName = displayName
    }
}

// Routes a decoded offer-port body. A pairing offer (PairingPayload) carries no
// "t" tag; whois and identity replies do.
enum OfferPortMessage {
    case offer(PairingPayload)
    case whois
    case identity(DeviceIdentity)
    case unknown

    private struct TypeTag: Decodable {
        let t: String?
    }

    static func classify(_ body: Data) -> OfferPortMessage {
        let tag = (try? JSONDecoder().decode(TypeTag.self, from: body))?.t
        switch tag {
        case "whois":
            return .whois
        case "id":
            if let identity = try? JSONDecoder().decode(DeviceIdentity.self, from: body) {
                return .identity(identity)
            }
            return .unknown
        default:
            if let payload = try? JSONDecoder().decode(PairingPayload.self, from: body) {
                return .offer(payload)
            }
            return .unknown
        }
    }
}

struct SessionToken: Codable, Equatable {
    let hostFingerprint: String
    let deviceFingerprint: DeviceFingerprint
    let issuedAt: Int
    let signature: Data

    enum CodingKeys: String, CodingKey {
        case hostFingerprint = "h"
        case deviceFingerprint = "d"
        case issuedAt = "i"
        case signature = "s"
    }

    init(hostFingerprint: String, deviceFingerprint: DeviceFingerprint, issuedAt: Int, signature: Data) {
        self.hostFingerprint = hostFingerprint
        self.deviceFingerprint = deviceFingerprint
        self.issuedAt = issuedAt
        self.signature = signature
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        hostFingerprint = try container.decode(String.self, forKey: .hostFingerprint)
        deviceFingerprint = try container.decode(DeviceFingerprint.self, forKey: .deviceFingerprint)
        issuedAt = try container.decode(Int.self, forKey: .issuedAt)
        signature = try Data(base64URLEncoded: container.decode(String.self, forKey: .signature))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(hostFingerprint, forKey: .hostFingerprint)
        try container.encode(deviceFingerprint, forKey: .deviceFingerprint)
        try container.encode(issuedAt, forKey: .issuedAt)
        try container.encode(signature.base64URLEncodedString(), forKey: .signature)
    }
}

// ADR-0003 and ADR-0030 session-establishment wire shapes. Sent on the control
// stream inside the authenticated session QUIC connection.

struct SessionInit: Codable, Equatable {
    let type: String
    let deviceFingerprint: DeviceFingerprint
    let sessionToken: SessionToken
    let clientNonce: Data
    // ADR-0020: client's wire protocol version. Decode-tolerant (older peers omit
    // it and read as 1).
    let protocolVersion: Int

    enum CodingKeys: String, CodingKey {
        case type = "t"
        case deviceFingerprint = "d"
        case sessionToken = "s"
        case clientNonce = "n"
        case protocolVersion = "pv"
    }

    init(deviceFingerprint: DeviceFingerprint, sessionToken: SessionToken, clientNonce: Data, protocolVersion: Int = Config.protocolVersion) {
        self.type = "session-init"
        self.deviceFingerprint = deviceFingerprint
        self.sessionToken = sessionToken
        self.clientNonce = clientNonce
        self.protocolVersion = protocolVersion
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        deviceFingerprint = try container.decode(DeviceFingerprint.self, forKey: .deviceFingerprint)
        sessionToken = try container.decode(SessionToken.self, forKey: .sessionToken)
        clientNonce = try Data(base64URLEncoded: container.decode(String.self, forKey: .clientNonce))
        protocolVersion = try container.decodeIfPresent(Int.self, forKey: .protocolVersion) ?? 1
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)
        try container.encode(deviceFingerprint, forKey: .deviceFingerprint)
        try container.encode(sessionToken, forKey: .sessionToken)
        try container.encode(clientNonce.base64URLEncodedString(), forKey: .clientNonce)
        try container.encode(protocolVersion, forKey: .protocolVersion)
    }
}

struct SessionChallenge: Codable, Equatable {
    let type: String
    let hostNonce: Data
    let hostSignature: Data
    // ADR-0020: host's wire protocol version, so the client can detect a host too
    // old for it. Decode-tolerant (older peers omit it and read as 1).
    let protocolVersion: Int

    enum CodingKeys: String, CodingKey {
        case type = "t"
        case hostNonce = "n"
        case hostSignature = "s"
        case protocolVersion = "pv"
    }

    init(hostNonce: Data, hostSignature: Data, protocolVersion: Int = Config.protocolVersion) {
        self.type = "session-challenge"
        self.hostNonce = hostNonce
        self.hostSignature = hostSignature
        self.protocolVersion = protocolVersion
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        hostNonce = try Data(base64URLEncoded: container.decode(String.self, forKey: .hostNonce))
        hostSignature = try Data(base64URLEncoded: container.decode(String.self, forKey: .hostSignature))
        protocolVersion = try container.decodeIfPresent(Int.self, forKey: .protocolVersion) ?? 1
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)
        try container.encode(hostNonce.base64URLEncodedString(), forKey: .hostNonce)
        try container.encode(hostSignature.base64URLEncodedString(), forKey: .hostSignature)
        try container.encode(protocolVersion, forKey: .protocolVersion)
    }
}

struct SessionProof: Codable, Equatable {
    let type: String
    let clientSignature: Data

    enum CodingKeys: String, CodingKey {
        case type = "t"
        case clientSignature = "s"
    }

    init(clientSignature: Data) {
        self.type = "session-proof"
        self.clientSignature = clientSignature
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        clientSignature = try Data(base64URLEncoded: container.decode(String.self, forKey: .clientSignature))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)
        try container.encode(clientSignature.base64URLEncodedString(), forKey: .clientSignature)
    }
}

struct SessionReady: Codable, Equatable {
    let type: String
    let sessionId: String
    let resumeId: Data
    let resumeSecret: Data
    let resumeExpiresAt: Int
    let mediaKeySalt: Data

    enum CodingKeys: String, CodingKey {
        case type = "t"
        case sessionId = "sid"
        case resumeId = "rid"
        case resumeSecret = "rs"
        case resumeExpiresAt = "re"
        case mediaKeySalt = "mk"
    }

    init(
        sessionId: String,
        resumeId: Data,
        resumeSecret: Data,
        resumeExpiresAt: Int,
        mediaKeySalt: Data
    ) {
        self.type = "session-ready"
        self.sessionId = sessionId
        self.resumeId = resumeId
        self.resumeSecret = resumeSecret
        self.resumeExpiresAt = resumeExpiresAt
        self.mediaKeySalt = mediaKeySalt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        sessionId = try container.decode(String.self, forKey: .sessionId)
        resumeId = try Data(base64URLEncoded: container.decode(String.self, forKey: .resumeId))
        resumeSecret = try Data(base64URLEncoded: container.decode(String.self, forKey: .resumeSecret))
        resumeExpiresAt = try container.decode(Int.self, forKey: .resumeExpiresAt)
        mediaKeySalt = try Data(base64URLEncoded: container.decode(String.self, forKey: .mediaKeySalt))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)
        try container.encode(sessionId, forKey: .sessionId)
        try container.encode(resumeId.base64URLEncodedString(), forKey: .resumeId)
        try container.encode(resumeSecret.base64URLEncodedString(), forKey: .resumeSecret)
        try container.encode(resumeExpiresAt, forKey: .resumeExpiresAt)
        try container.encode(mediaKeySalt.base64URLEncodedString(), forKey: .mediaKeySalt)
    }
}

struct SessionResumeInit: Codable, Equatable {
    let type: String
    let deviceFingerprint: DeviceFingerprint
    let sessionId: String
    let resumeId: Data
    let clientNonce: Data
    let protocolVersion: Int

    enum CodingKeys: String, CodingKey {
        case type = "t"
        case deviceFingerprint = "d"
        case sessionId = "sid"
        case resumeId = "rid"
        case clientNonce = "cn"
        case protocolVersion = "pv"
    }

    init(
        deviceFingerprint: DeviceFingerprint,
        sessionId: String,
        resumeId: Data,
        clientNonce: Data = Data(),
        protocolVersion: Int = Config.protocolVersion
    ) {
        self.type = "session-resume"
        self.deviceFingerprint = deviceFingerprint
        self.sessionId = sessionId
        self.resumeId = resumeId
        self.clientNonce = clientNonce
        self.protocolVersion = protocolVersion
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        deviceFingerprint = try container.decode(DeviceFingerprint.self, forKey: .deviceFingerprint)
        sessionId = try container.decode(String.self, forKey: .sessionId)
        resumeId = try Data(base64URLEncoded: container.decode(String.self, forKey: .resumeId))
        clientNonce = try Data(base64URLEncoded: container.decode(String.self, forKey: .clientNonce))
        protocolVersion = try container.decode(Int.self, forKey: .protocolVersion)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)
        try container.encode(deviceFingerprint, forKey: .deviceFingerprint)
        try container.encode(sessionId, forKey: .sessionId)
        try container.encode(resumeId.base64URLEncodedString(), forKey: .resumeId)
        try container.encode(clientNonce.base64URLEncodedString(), forKey: .clientNonce)
        try container.encode(protocolVersion, forKey: .protocolVersion)
    }
}

struct SessionResumeChallenge: Codable, Equatable {
    let type: String
    let hostNonce: Data
    let resumeExpiresAt: Int

    enum CodingKeys: String, CodingKey {
        case type = "t"
        case hostNonce = "hn"
        case resumeExpiresAt = "re"
    }

    init(hostNonce: Data, resumeExpiresAt: Int) {
        self.type = "session-resume-challenge"
        self.hostNonce = hostNonce
        self.resumeExpiresAt = resumeExpiresAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        hostNonce = try Data(base64URLEncoded: container.decode(String.self, forKey: .hostNonce))
        resumeExpiresAt = try container.decode(Int.self, forKey: .resumeExpiresAt)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)
        try container.encode(hostNonce.base64URLEncodedString(), forKey: .hostNonce)
        try container.encode(resumeExpiresAt, forKey: .resumeExpiresAt)
    }
}

struct SessionResumeProof: Codable, Equatable {
    let type: String
    let proof: Data

    enum CodingKeys: String, CodingKey {
        case type = "t"
        case proof = "p"
    }

    init(proof: Data) {
        self.type = "session-resume-proof"
        self.proof = proof
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let decodedType = try container.decode(String.self, forKey: .type)
        guard decodedType == "session-resume-proof" else {
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "Unexpected session resume proof type"
            )
        }
        type = decodedType
        proof = try Data(base64URLEncoded: container.decode(String.self, forKey: .proof))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)
        try container.encode(proof.base64URLEncodedString(), forKey: .proof)
    }
}

enum SessionResumeSigning {
    private static let domainPrefix = "agentdesk-session-resume-v2"

    static func proof(
        sessionId: String,
        deviceFingerprint: DeviceFingerprint,
        resumeId: Data,
        clientNonce: Data,
        hostNonce: Data,
        protocolVersion: Int,
        secret: Data
    ) -> Data {
        let input = canonicalInput(
            sessionId: sessionId,
            deviceFingerprint: deviceFingerprint,
            resumeId: resumeId,
            clientNonce: clientNonce,
            hostNonce: hostNonce,
            protocolVersion: protocolVersion
        )
        let code = HMAC<SHA256>.authenticationCode(
            for: input,
            using: SymmetricKey(data: secret)
        )
        return Data(code)
    }

    static func isValid(
        _ proof: Data,
        sessionId: String,
        deviceFingerprint: DeviceFingerprint,
        resumeId: Data,
        clientNonce: Data,
        hostNonce: Data,
        protocolVersion: Int,
        secret: Data
    ) -> Bool {
        let input = canonicalInput(
            sessionId: sessionId,
            deviceFingerprint: deviceFingerprint,
            resumeId: resumeId,
            clientNonce: clientNonce,
            hostNonce: hostNonce,
            protocolVersion: protocolVersion
        )
        return HMAC<SHA256>.isValidAuthenticationCode(
            proof,
            authenticating: input,
            using: SymmetricKey(data: secret)
        )
    }

    private static func canonicalInput(
        sessionId: String,
        deviceFingerprint: DeviceFingerprint,
        resumeId: Data,
        clientNonce: Data,
        hostNonce: Data,
        protocolVersion: Int
    ) -> Data {
        var data = Data()
        appendField(Data(domainPrefix.utf8), to: &data)
        appendField(Data(Config.sessionQuicALPN.utf8), to: &data)
        appendField(Data(sessionId.utf8), to: &data)
        appendField(Data(deviceFingerprint.rawValue.utf8), to: &data)
        appendField(resumeId, to: &data)
        appendField(clientNonce, to: &data)
        appendField(hostNonce, to: &data)
        appendField(Data(String(protocolVersion).utf8), to: &data)
        return data
    }

    private static func appendField(_ field: Data, to data: inout Data) {
        data.append(UInt8((field.count >> 24) & 0xff))
        data.append(UInt8((field.count >> 16) & 0xff))
        data.append(UInt8((field.count >> 8) & 0xff))
        data.append(UInt8(field.count & 0xff))
        data.append(field)
    }
}

enum SessionRejectionReason: String, Codable, Equatable, Error {
    case revoked
    case unknownDevice = "unknown-device"
    case replay
    case badSignature = "bad-signature"
    case malformed
    case unauthorized
    case expiredResume = "expired-resume"
    // ADR-0020: peer's wire protocol version is incompatible; the user must
    // update the older app. Not recoverable by retrying.
    case incompatibleProtocol = "incompatible-protocol"
}

struct SessionRejected: Codable, Equatable, Error {
    let type: String
    let reason: SessionRejectionReason

    enum CodingKeys: String, CodingKey {
        case type = "t"
        case reason = "r"
    }

    init(reason: SessionRejectionReason) {
        self.type = "session-rejected"
        self.reason = reason
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        reason = try container.decode(SessionRejectionReason.self, forKey: .reason)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)
        try container.encode(reason, forKey: .reason)
    }
}

struct ActiveSession: Equatable {
    let sessionId: String
    let deviceFingerprint: DeviceFingerprint
    let establishedAt: Int
}

struct OwnedSurfaceUpdateId: Codable, Equatable, Hashable, Comparable {
    let surfaceGeneration: UInt32
    let frameId: UInt64

    enum CodingKeys: String, CodingKey {
        case surfaceGeneration = "sg"
        case frameId = "id"
    }

    static func < (lhs: OwnedSurfaceUpdateId, rhs: OwnedSurfaceUpdateId) -> Bool {
        if lhs.surfaceGeneration != rhs.surfaceGeneration {
            return lhs.surfaceGeneration < rhs.surfaceGeneration
        }
        return lhs.frameId < rhs.frameId
    }

    func isStrictlyNewer(than committed: OwnedSurfaceUpdateId) -> Bool {
        self > committed
    }

    static func canAcceptReset(surfaceGeneration: UInt32, committedSurfaceGeneration: UInt32) -> Bool {
        surfaceGeneration > committedSurfaceGeneration
    }

    static func acceptedResetBaseline(
        surfaceGeneration: UInt32,
        committedSurfaceGeneration: UInt32
    ) -> OwnedSurfaceUpdateId? {
        guard canAcceptReset(
            surfaceGeneration: surfaceGeneration,
            committedSurfaceGeneration: committedSurfaceGeneration
        ) else {
            return nil
        }
        return OwnedSurfaceUpdateId(surfaceGeneration: surfaceGeneration, frameId: 0)
    }
}

// Owned-media video wire types. Scrolling motion rides hardware HEVC over the
// session QUIC datagram lane. These are the carrier-agnostic frame shapes; the
// host encoder fills them and the client video layer decodes them.
// Length-prefixed NAL payload, parameter sets carried on keyframes only.

enum OwnedMediaCodec: String, Codable, Equatable {
    case hevc
    case h264
}

enum OwnedMediaPayloadFormat: String, Codable, Equatable {
    case lengthPrefixedNal = "length-prefixed-nal"
}

enum OwnedMediaRefreshReason: String, Codable, Equatable {
    case initial
    case rest
    case scrollCorrectness = "scroll-correctness"
    case reset
}

struct OwnedMediaParameterSets: Codable, Equatable {
    let vps: Data?
    let sps: Data
    let pps: Data

    init(vps: Data? = nil, sps: Data, pps: Data) {
        self.vps = vps
        self.sps = sps
        self.pps = pps
    }
}

struct OwnedMediaFrameHeader: Codable, Equatable {
    let surfaceGeneration: UInt32
    let frameId: UInt64
    let codec: OwnedMediaCodec
    let width: Int
    let height: Int
    let capturedAtUptimeNs: UInt64
    let presentationTimeNs: UInt64
    let isKeyframe: Bool
    let parameterSets: OwnedMediaParameterSets?
    let payloadFormat: OwnedMediaPayloadFormat
    let refreshReason: OwnedMediaRefreshReason

    var updateId: OwnedSurfaceUpdateId {
        OwnedSurfaceUpdateId(surfaceGeneration: surfaceGeneration, frameId: frameId)
    }

    enum CodingKeys: String, CodingKey {
        case surfaceGeneration = "sg"
        case frameId = "id"
        case codec = "c"
        case width = "w"
        case height = "h"
        case capturedAtUptimeNs = "cu"
        case presentationTimeNs = "pt"
        case isKeyframe = "k"
        case parameterSets = "ps"
        case payloadFormat = "pf"
        case refreshReason = "rr"
    }

    init(
        surfaceGeneration: UInt32,
        frameId: UInt64,
        codec: OwnedMediaCodec,
        width: Int,
        height: Int,
        capturedAtUptimeNs: UInt64,
        presentationTimeNs: UInt64,
        isKeyframe: Bool,
        parameterSets: OwnedMediaParameterSets?,
        payloadFormat: OwnedMediaPayloadFormat = .lengthPrefixedNal,
        refreshReason: OwnedMediaRefreshReason
    ) {
        self.surfaceGeneration = surfaceGeneration
        self.frameId = frameId
        self.codec = codec
        self.width = width
        self.height = height
        self.capturedAtUptimeNs = capturedAtUptimeNs
        self.presentationTimeNs = presentationTimeNs
        self.isKeyframe = isKeyframe
        self.parameterSets = parameterSets
        self.payloadFormat = payloadFormat
        self.refreshReason = refreshReason
    }
}

struct OwnedMediaFrameEnvelope: Equatable {
    static let magic = [UInt8]("ADMF".utf8)
    static let version: UInt8 = 1
    static let fixedHeaderByteCount = 9

    let header: OwnedMediaFrameHeader
    let payload: Data

    init(header: OwnedMediaFrameHeader, payload: Data) {
        self.header = header
        self.payload = payload
    }

    func encode() throws -> Data {
        let headerData = try JSONEncoder().encode(header)
        guard headerData.count <= Int(UInt32.max) else {
            throw SessionRejected(reason: .malformed)
        }
        var encoded = Data(Self.magic)
        encoded.append(Self.version)
        var headerLength = UInt32(headerData.count).bigEndian
        withUnsafeBytes(of: &headerLength) { encoded.append(contentsOf: $0) }
        encoded.append(headerData)
        encoded.append(payload)
        return encoded
    }

    static func decode(_ data: Data) throws -> OwnedMediaFrameEnvelope {
        guard data.count >= fixedHeaderByteCount else {
            throw SessionRejected(reason: .malformed)
        }
        let bytes = [UInt8](data.prefix(fixedHeaderByteCount))
        guard Array(bytes[0..<4]) == magic, bytes[4] == version else {
            throw SessionRejected(reason: .malformed)
        }
        let headerLength = bytes[5..<9].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        let headerStart = fixedHeaderByteCount
        let headerEnd = headerStart + Int(headerLength)
        guard data.count >= headerEnd else {
            throw SessionRejected(reason: .malformed)
        }
        let headerData = data[headerStart..<headerEnd]
        let header = try JSONDecoder().decode(OwnedMediaFrameHeader.self, from: headerData)
        let payload = data[headerEnd..<data.count]
        return OwnedMediaFrameEnvelope(header: header, payload: payload)
    }
}

// Client-to-host control for the datagram carrier: a keyframe request when the
// stream desyncs past repair, and a packet-resend request naming the missing
// indexes of a frame. frameAck/graphicsResetRequest/keepalive round out the
// protocol the pre-ADR-0022 carrier used.
enum OwnedMediaControlKind: String, Codable, Equatable {
    case keyframeRequest = "keyframe-request"
    case packetResendRequest = "packet-resend-request"
    case frameAck = "frame-ack"
    case graphicsResetRequest = "graphics-reset-request"
    case keepalive = "keepalive"
    // ADR-0027: client->host link-health report carrying the window's completed and
    // expired (lost) frame counts, which drive the host adaptive bitrate controller.
    case linkHealth = "link-health"
}

struct OwnedMediaControlMessage: Codable, Equatable {
    let type: String
    let kind: OwnedMediaControlKind
    let frameId: UInt64
    let packetIndexes: [UInt16]
    let totalFramesDecoded: UInt64?
    let renderGapMs: Double?
    let frameAgeMs: Double?
    let clientBacklogFrames: Int?
    let clientBacklogBytes: Int?
    let graphicsSurfaceGeneration: UInt32?
    let reason: String?
    // ADR-0027 link-health: frames completed and frames expired (lost past repair)
    // in the report window. Present only on a .linkHealth message.
    let linkHealthCompletedFrames: Int?
    let linkHealthExpiredFrames: Int?

    enum CodingKeys: String, CodingKey {
        case type = "t"
        case kind = "k"
        case frameId = "id"
        case packetIndexes = "px"
        case totalFramesDecoded = "td"
        case renderGapMs = "rg"
        case clientBacklogFrames = "qf"
        case clientBacklogBytes = "qb"
        case graphicsSurfaceGeneration = "sg"
        case reason = "r"
        case linkHealthCompletedFrames = "lc"
        case linkHealthExpiredFrames = "le"
    }

    init(
        kind: OwnedMediaControlKind,
        frameId: UInt64,
        packetIndexes: [UInt16] = [],
        totalFramesDecoded: UInt64? = nil,
        renderGapMs: Double? = nil,
        frameAgeMs: Double? = nil,
        clientBacklogFrames: Int? = nil,
        clientBacklogBytes: Int? = nil,
        graphicsSurfaceGeneration: UInt32? = nil,
        reason: String? = nil,
        linkHealthCompletedFrames: Int? = nil,
        linkHealthExpiredFrames: Int? = nil
    ) {
        self.type = "owned-media-control"
        self.kind = kind
        self.frameId = frameId
        self.packetIndexes = packetIndexes
        self.totalFramesDecoded = totalFramesDecoded
        self.renderGapMs = renderGapMs
        self.frameAgeMs = frameAgeMs
        self.clientBacklogFrames = clientBacklogFrames
        self.clientBacklogBytes = clientBacklogBytes
        self.graphicsSurfaceGeneration = graphicsSurfaceGeneration
        self.reason = reason
        self.linkHealthCompletedFrames = linkHealthCompletedFrames
        self.linkHealthExpiredFrames = linkHealthExpiredFrames
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        kind = try container.decode(OwnedMediaControlKind.self, forKey: .kind)
        frameId = try container.decode(UInt64.self, forKey: .frameId)
        packetIndexes = try container.decodeIfPresent([UInt16].self, forKey: .packetIndexes) ?? []
        totalFramesDecoded = try container.decodeIfPresent(UInt64.self, forKey: .totalFramesDecoded)
        renderGapMs = try container.decodeIfPresent(Double.self, forKey: .renderGapMs)
        frameAgeMs = nil
        clientBacklogFrames = try container.decodeIfPresent(Int.self, forKey: .clientBacklogFrames)
        clientBacklogBytes = try container.decodeIfPresent(Int.self, forKey: .clientBacklogBytes)
        graphicsSurfaceGeneration = try container.decodeIfPresent(UInt32.self, forKey: .graphicsSurfaceGeneration)
        reason = try container.decodeIfPresent(String.self, forKey: .reason)
        linkHealthCompletedFrames = try container.decodeIfPresent(Int.self, forKey: .linkHealthCompletedFrames)
        linkHealthExpiredFrames = try container.decodeIfPresent(Int.self, forKey: .linkHealthExpiredFrames)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)
        try container.encode(kind, forKey: .kind)
        try container.encode(frameId, forKey: .frameId)
        if !packetIndexes.isEmpty {
            try container.encode(packetIndexes, forKey: .packetIndexes)
        }
        try container.encodeIfPresent(totalFramesDecoded, forKey: .totalFramesDecoded)
        try container.encodeIfPresent(renderGapMs, forKey: .renderGapMs)
        try container.encodeIfPresent(clientBacklogFrames, forKey: .clientBacklogFrames)
        try container.encodeIfPresent(clientBacklogBytes, forKey: .clientBacklogBytes)
        try container.encodeIfPresent(graphicsSurfaceGeneration, forKey: .graphicsSurfaceGeneration)
        try container.encodeIfPresent(reason, forKey: .reason)
        try container.encodeIfPresent(linkHealthCompletedFrames, forKey: .linkHealthCompletedFrames)
        try container.encodeIfPresent(linkHealthExpiredFrames, forKey: .linkHealthExpiredFrames)
    }
}

enum SessionSigning {
    static let domainPrefix = "agentdesk-session"

    static func canonicalInput(
        clientNonce: Data,
        hostNonce: Data,
        hostFingerprint: String,
        deviceFingerprint: DeviceFingerprint
    ) -> Data {
        var data = Data()
        data.append(Data(domainPrefix.utf8))
        data.append(clientNonce)
        data.append(hostNonce)
        data.append(Data(hostFingerprint.utf8))
        data.append(Data(deviceFingerprint.rawValue.utf8))
        return data
    }
}

enum MediaTimingMath {
    static func millisecondsBetween(currentNs: UInt64, previousNs: UInt64?) -> Double? {
        guard let previousNs, currentNs >= previousNs else { return nil }
        return Double(currentNs - previousNs) / 1_000_000.0
    }

    static func millisecondsPerUnit(
        currentCount: Double?,
        previousCount: Double?,
        currentTotalSeconds: Double?,
        previousTotalSeconds: Double?
    ) -> Double? {
        guard let currentCount,
              let previousCount,
              let currentTotalSeconds,
              let previousTotalSeconds else { return nil }
        let countDelta = currentCount - previousCount
        let secondsDelta = currentTotalSeconds - previousTotalSeconds
        guard countDelta > 0, secondsDelta >= 0 else { return nil }
        return secondsDelta * 1_000.0 / countDelta
    }

    static func formatMilliseconds(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "?" }
        return String(format: "%.2f", value)
    }
}

enum NormalizedInput: Codable, Equatable {
    case cursorMove(dx: Float, dy: Float)
    case click(button: MouseButton)
    case scroll(dx: Float, dy: Float, phase: ScrollPhase)
    case dragStart
    case dragEnd
    case switchSpaceGesture(phase: SwipePhase, progress: Float, velocityX: Float)
    // Tap-to-jump: one wire frame covers an N-Space jump. The host runs
    // |delta| Began/Changed/Ended dock-swipe cycles back-to-back on a
    // dedicated serial queue, much tighter than the WSS round-trip the
    // client could afford between cycles. Sign convention matches
    // switchSpaceGesture's progress sign for the equivalent direction:
    // positive delta = same direction a positive-progress swipe would
    // commit. Client applies its direction toggle when computing the
    // sign so tap-to-jump and swipe-to-jump stay in agreement.
    case switchSpaceStep(delta: Int)
    case key(code: String, modifiers: [Modifier])
    case modifierArm(mod: Modifier)

    enum MouseButton: String, Codable {
        case left
        case right
        case double
    }

    // SwipePhase mirrors the CGSGesturePhase values the Dock listens
    // for on dock-swipe events. Began opens a swipe (no commit), Changed
    // streams progress while the finger moves, Ended commits (or
    // snaps back if progress + velocity are below the Dock's
    // commit threshold), Cancelled abandons.
    enum SwipePhase: String, Codable {
        case began
        case changed
        case ended
        case cancelled
    }

    enum Modifier: String, Codable {
        case cmd
        case ctrl
        case option
        case shift
    }

    // Mirrors the two-axis macOS scroll phase model so the host can post
    // CGEvents with the right kCGScrollWheelEventScrollPhase /
    // kCGScrollWheelEventMomentumPhase combination. Without these, macOS
    // treats every event as a discrete mouse-wheel notch rather than a
    // continuous trackpad-style scroll.
    enum ScrollPhase: String, Codable {
        case began            // first event of a touch drag
        case changed          // subsequent events during drag
        case ended            // finger lift signal (often zero delta)
        case momentumBegan    // first inertia event after lift
        case momentumChanged  // subsequent inertia events
        case momentumEnded    // inertia decayed below cutoff
    }
}

struct OwnedGraphicsFrameHeader: Codable, Equatable {
    let surfaceGeneration: UInt32
    let frameId: UInt64
    let capturedAtUptimeNs: UInt64
    let commandCount: Int
    let payloadLength: Int

    var updateId: OwnedSurfaceUpdateId {
        OwnedSurfaceUpdateId(surfaceGeneration: surfaceGeneration, frameId: frameId)
    }

    enum CodingKeys: String, CodingKey {
        case surfaceGeneration = "sg"
        case frameId = "id"
        case capturedAtUptimeNs = "cu"
        case commandCount = "cc"
        case payloadLength = "pl"
    }
}

struct OwnedGraphicsFrameEnvelope: Equatable {
    static let magic = [UInt8]("ADGC".utf8)
    static let version: UInt8 = 1
    static let fixedHeaderByteCount = 13

    let header: OwnedGraphicsFrameHeader
    let commands: [OwnedGraphicsCommand]
    let payload: Data

    init(
        header: OwnedGraphicsFrameHeader,
        commands: [OwnedGraphicsCommand],
        payload: Data
    ) {
        self.header = header
        self.commands = commands
        self.payload = payload
    }

    func encode() throws -> Data {
        try validate()
        let metadata = OwnedGraphicsFrameMetadata(header: header, commands: commands)
        let metadataData = try JSONEncoder().encode(metadata)
        guard metadataData.count <= Int(UInt32.max),
              payload.count <= Int(UInt32.max) else {
            throw SessionRejected(reason: .malformed)
        }
        var encoded = Data(Self.magic)
        encoded.append(Self.version)
        var metadataLength = UInt32(metadataData.count).bigEndian
        var payloadLength = UInt32(payload.count).bigEndian
        withUnsafeBytes(of: &metadataLength) { encoded.append(contentsOf: $0) }
        withUnsafeBytes(of: &payloadLength) { encoded.append(contentsOf: $0) }
        encoded.append(metadataData)
        encoded.append(payload)
        return encoded
    }

    var wireByteCount: Int {
        let metadata = OwnedGraphicsFrameMetadata(header: header, commands: commands)
        let metadataByteCount = (try? JSONEncoder().encode(metadata).count) ?? 0
        return Self.fixedHeaderByteCount + metadataByteCount + payload.count
    }

    static func decode(_ data: Data) throws -> OwnedGraphicsFrameEnvelope {
        guard data.count >= fixedHeaderByteCount else {
            throw SessionRejected(reason: .malformed)
        }
        let bytes = [UInt8](data.prefix(fixedHeaderByteCount))
        guard Array(bytes[0..<4]) == magic, bytes[4] == version else {
            throw SessionRejected(reason: .malformed)
        }
        let metadataLength = bytes[5..<9].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        let payloadLength = bytes[9..<13].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        let metadataStart = fixedHeaderByteCount
        let metadataEnd = metadataStart + Int(metadataLength)
        let payloadEnd = metadataEnd + Int(payloadLength)
        guard data.count >= metadataEnd,
              data.count == payloadEnd else {
            throw SessionRejected(reason: .malformed)
        }
        let metadataData = Data(data[metadataStart..<metadataEnd])
        let metadata = try JSONDecoder().decode(OwnedGraphicsFrameMetadata.self, from: metadataData)
        let payload = Data(data[metadataEnd..<payloadEnd])
        let envelope = OwnedGraphicsFrameEnvelope(
            header: metadata.header,
            commands: metadata.commands,
            payload: payload
        )
        try envelope.validate()
        return envelope
    }

    private func validate() throws {
        guard header.commandCount == commands.count,
              header.payloadLength == payload.count else {
            throw SessionRejected(reason: .malformed)
        }
        for command in commands {
            try command.validateForCurrentScope(payloadLength: payload.count)
        }
    }
}

struct OwnedGraphicsStreamFrameParser {
    static let maxFrameByteCount = 8 * 1024 * 1024
    private var buffer = Data()

    mutating func append(_ chunk: Data) throws -> [OwnedGraphicsFrameEnvelope] {
        buffer.append(chunk)
        var frames: [OwnedGraphicsFrameEnvelope] = []
        while buffer.count >= OwnedGraphicsFrameEnvelope.fixedHeaderByteCount {
            let fixedHeader = [UInt8](buffer.prefix(OwnedGraphicsFrameEnvelope.fixedHeaderByteCount))
            guard Array(fixedHeader[0..<4]) == OwnedGraphicsFrameEnvelope.magic,
                  fixedHeader[4] == OwnedGraphicsFrameEnvelope.version else {
                throw SessionRejected(reason: .malformed)
            }
            let metadataLength = fixedHeader[5..<9].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
            let payloadLength = fixedHeader[9..<13].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
            let frameLength = OwnedGraphicsFrameEnvelope.fixedHeaderByteCount + Int(metadataLength) + Int(payloadLength)
            guard frameLength >= OwnedGraphicsFrameEnvelope.fixedHeaderByteCount,
                  frameLength <= Self.maxFrameByteCount else {
                throw SessionRejected(reason: .malformed)
            }
            guard buffer.count >= frameLength else {
                break
            }
            frames.append(try OwnedGraphicsFrameEnvelope.decode(Data(buffer.prefix(frameLength))))
            buffer.removeFirst(frameLength)
        }
        return frames
    }
}

enum OwnedGraphicsControlStreamFrame {
    static let fixedHeaderByteCount = 4
    static let maxPayloadByteCount = 64 * 1024

    static func encode<T: Encodable>(_ message: T) throws -> Data {
        let payload = try JSONEncoder().encode(message)
        guard payload.count <= maxPayloadByteCount else {
            throw SessionRejected(reason: .malformed)
        }
        var encoded = Data()
        var length = UInt32(payload.count).bigEndian
        withUnsafeBytes(of: &length) { encoded.append(contentsOf: $0) }
        encoded.append(payload)
        return encoded
    }
}

struct OwnedGraphicsControlStreamFrameParser {
    private var buffer = Data()

    mutating func append(_ chunk: Data) throws -> [Data] {
        buffer.append(chunk)
        guard buffer.count <= OwnedGraphicsControlStreamFrame.maxPayloadByteCount + OwnedGraphicsControlStreamFrame.fixedHeaderByteCount else {
            throw SessionRejected(reason: .malformed)
        }
        var frames: [Data] = []
        while buffer.count >= OwnedGraphicsControlStreamFrame.fixedHeaderByteCount {
            let fixedHeader = [UInt8](buffer.prefix(OwnedGraphicsControlStreamFrame.fixedHeaderByteCount))
            let payloadLength = fixedHeader.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
            guard payloadLength > 0,
                  payloadLength <= UInt32(OwnedGraphicsControlStreamFrame.maxPayloadByteCount) else {
                throw SessionRejected(reason: .malformed)
            }
            let frameLength = OwnedGraphicsControlStreamFrame.fixedHeaderByteCount + Int(payloadLength)
            guard buffer.count >= frameLength else {
                break
            }
            frames.append(
                Data(
                    buffer
                        .dropFirst(OwnedGraphicsControlStreamFrame.fixedHeaderByteCount)
                        .prefix(Int(payloadLength))
                )
            )
            buffer.removeFirst(frameLength)
        }
        return frames
    }
}

private struct OwnedGraphicsFrameMetadata: Codable, Equatable {
    let header: OwnedGraphicsFrameHeader
    let commands: [OwnedGraphicsCommand]

    enum CodingKeys: String, CodingKey {
        case header = "h"
        case commands = "c"
    }
}

enum OwnedGraphicsPixelFormat: String, Codable, Equatable {
    case bgra
}

enum OwnedGraphicsTileCompression: String, Codable, Equatable {
    case lzfse
    // Lossy JPEG for the fullframe fallback. A whole-screen change (video, a
    // page load, or a fast scroll) is multi-MB as raw LZFSE and saturated the
    // single reliable graphics channel, freezing the
    // screen. JPEG cuts it ~10x. Small text changes stay .lzfse (lossless); the
    // lossy path is reserved for large motion the way RDP mixes codecs by region.
    case jpeg
}

struct OwnedGraphicsByteRange: Codable, Equatable {
    let offset: Int
    let length: Int

    enum CodingKeys: String, CodingKey {
        case offset = "o"
        case length = "l"
    }
}

// ADR-0022: one QUIC session is two connections/streams. Each opens with a 1-byte
// role tag as its first byte so the host can route an inbound connection (graphics
// frames vs interactive control) regardless of arrival order.
enum OwnedGraphicsStreamRole: UInt8 {
    case graphics = 0x47      // 'G'
    case interactive = 0x49   // 'I'
}

enum OwnedGraphicsCommand: Equatable {
    case resetSurface(surfaceGeneration: UInt32, width: Int, height: Int, pixelFormat: OwnedGraphicsPixelFormat)
    case bitmapTile(x: Int, y: Int, width: Int, height: Int, compression: OwnedGraphicsTileCompression, byteRange: OwnedGraphicsByteRange)
    case cacheTile(slot: UInt16, x: Int, y: Int, width: Int, height: Int, compression: OwnedGraphicsTileCompression, byteRange: OwnedGraphicsByteRange)
    case drawCachedTile(slot: UInt16, x: Int, y: Int, width: Int, height: Int)

    enum Kind: String, Codable {
        case resetSurface
        case bitmapTile
        case cacheTile
        case drawCachedTile
    }

    enum CodingKeys: String, CodingKey {
        case kind = "k"
        case surfaceGeneration = "sg"
        case width = "w"
        case height = "h"
        case pixelFormat = "pf"
        case x
        case y
        case compression = "comp"
        case byteRange = "br"
        case slot = "sl"
    }

    var kindIsBitmapTile: Bool {
        if case .bitmapTile = self { return true }
        return false
    }

    var kindIsReset: Bool {
        if case .resetSurface = self { return true }
        return false
    }

    func validateForCurrentScope(payloadLength: Int = Int.max) throws {
        switch self {
        case let .resetSurface(_, width, height, _):
            guard width > 0, height > 0 else {
                throw SessionRejected(reason: .malformed)
            }
        case let .bitmapTile(x, y, width, height, _, byteRange):
            guard x >= 0, y >= 0, width > 0, height > 0,
                  byteRange.offset >= 0,
                  byteRange.length > 0,
                  byteRange.offset <= payloadLength,
                  byteRange.length <= payloadLength - byteRange.offset
            else {
                throw SessionRejected(reason: .malformed)
            }
        case let .cacheTile(_, x, y, width, height, _, byteRange):
            guard x >= 0, y >= 0, width > 0, height > 0,
                  byteRange.offset >= 0, byteRange.length > 0,
                  byteRange.offset <= payloadLength,
                  byteRange.length <= payloadLength - byteRange.offset
            else { throw SessionRejected(reason: .malformed) }
        case let .drawCachedTile(_, x, y, width, height):
            guard x >= 0, y >= 0, width > 0, height > 0 else { throw SessionRejected(reason: .malformed) }
        }
    }
}

extension OwnedGraphicsCommand: Codable {
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(Kind.self, forKey: .kind) {
        case .resetSurface:
            self = .resetSurface(
                surfaceGeneration: try container.decode(UInt32.self, forKey: .surfaceGeneration),
                width: try container.decode(Int.self, forKey: .width),
                height: try container.decode(Int.self, forKey: .height),
                pixelFormat: try container.decode(OwnedGraphicsPixelFormat.self, forKey: .pixelFormat)
            )
        case .bitmapTile:
            self = .bitmapTile(
                x: try container.decode(Int.self, forKey: .x),
                y: try container.decode(Int.self, forKey: .y),
                width: try container.decode(Int.self, forKey: .width),
                height: try container.decode(Int.self, forKey: .height),
                compression: try container.decode(OwnedGraphicsTileCompression.self, forKey: .compression),
                byteRange: try container.decode(OwnedGraphicsByteRange.self, forKey: .byteRange)
            )
        case .cacheTile:
            self = .cacheTile(
                slot: try container.decode(UInt16.self, forKey: .slot),
                x: try container.decode(Int.self, forKey: .x),
                y: try container.decode(Int.self, forKey: .y),
                width: try container.decode(Int.self, forKey: .width),
                height: try container.decode(Int.self, forKey: .height),
                compression: try container.decode(OwnedGraphicsTileCompression.self, forKey: .compression),
                byteRange: try container.decode(OwnedGraphicsByteRange.self, forKey: .byteRange)
            )
        case .drawCachedTile:
            self = .drawCachedTile(
                slot: try container.decode(UInt16.self, forKey: .slot),
                x: try container.decode(Int.self, forKey: .x),
                y: try container.decode(Int.self, forKey: .y),
                width: try container.decode(Int.self, forKey: .width),
                height: try container.decode(Int.self, forKey: .height)
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .resetSurface(surfaceGeneration, width, height, pixelFormat):
            try container.encode(Kind.resetSurface, forKey: .kind)
            try container.encode(surfaceGeneration, forKey: .surfaceGeneration)
            try container.encode(width, forKey: .width)
            try container.encode(height, forKey: .height)
            try container.encode(pixelFormat, forKey: .pixelFormat)
        case let .bitmapTile(x, y, width, height, compression, byteRange):
            try container.encode(Kind.bitmapTile, forKey: .kind)
            try container.encode(x, forKey: .x)
            try container.encode(y, forKey: .y)
            try container.encode(width, forKey: .width)
            try container.encode(height, forKey: .height)
            try container.encode(compression, forKey: .compression)
            try container.encode(byteRange, forKey: .byteRange)
        case let .cacheTile(slot, x, y, width, height, compression, byteRange):
            try container.encode(Kind.cacheTile, forKey: .kind)
            try container.encode(slot, forKey: .slot)
            try container.encode(x, forKey: .x)
            try container.encode(y, forKey: .y)
            try container.encode(width, forKey: .width)
            try container.encode(height, forKey: .height)
            try container.encode(compression, forKey: .compression)
            try container.encode(byteRange, forKey: .byteRange)
        case let .drawCachedTile(slot, x, y, width, height):
            try container.encode(Kind.drawCachedTile, forKey: .kind)
            try container.encode(slot, forKey: .slot)
            try container.encode(x, forKey: .x)
            try container.encode(y, forKey: .y)
            try container.encode(width, forKey: .width)
            try container.encode(height, forKey: .height)
        }
    }
}

struct OwnedGraphicsFrameAck: Codable, Equatable {
    let type: String
    let surfaceGeneration: UInt32
    let frameId: UInt64
    let compositorMs: Double
    let queueDepthBytes: Int
    let queuedFrames: Int
    let totalGraphicsFramesApplied: UInt64
    let staleDiscardCount: Int

    var updateId: OwnedSurfaceUpdateId {
        OwnedSurfaceUpdateId(surfaceGeneration: surfaceGeneration, frameId: frameId)
    }

    enum CodingKeys: String, CodingKey {
        case type = "t"
        case surfaceGeneration = "sg"
        case frameId = "id"
        case compositorMs = "cm"
        case queueDepthBytes = "qb"
        case queuedFrames = "qf"
        case totalGraphicsFramesApplied = "tg"
        case staleDiscardCount = "sd"
    }

    init(
        surfaceGeneration: UInt32,
        frameId: UInt64,
        compositorMs: Double,
        queueDepthBytes: Int = 0,
        queuedFrames: Int = 0,
        totalGraphicsFramesApplied: UInt64 = 0,
        staleDiscardCount: Int
    ) {
        self.type = "graphics-frame-ack"
        self.surfaceGeneration = surfaceGeneration
        self.frameId = frameId
        self.compositorMs = compositorMs
        self.queueDepthBytes = queueDepthBytes
        self.queuedFrames = queuedFrames
        self.totalGraphicsFramesApplied = totalGraphicsFramesApplied
        self.staleDiscardCount = staleDiscardCount
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        surfaceGeneration = try container.decode(UInt32.self, forKey: .surfaceGeneration)
        frameId = try container.decode(UInt64.self, forKey: .frameId)
        compositorMs = try container.decodeIfPresent(Double.self, forKey: .compositorMs) ?? 0
        queueDepthBytes = try container.decodeIfPresent(Int.self, forKey: .queueDepthBytes) ?? 0
        queuedFrames = try container.decodeIfPresent(Int.self, forKey: .queuedFrames) ?? 0
        totalGraphicsFramesApplied = try container.decodeIfPresent(UInt64.self, forKey: .totalGraphicsFramesApplied) ?? 0
        staleDiscardCount = try container.decodeIfPresent(Int.self, forKey: .staleDiscardCount) ?? 0
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)
        try container.encode(surfaceGeneration, forKey: .surfaceGeneration)
        try container.encode(frameId, forKey: .frameId)
        try container.encode(compositorMs, forKey: .compositorMs)
        try container.encode(queueDepthBytes, forKey: .queueDepthBytes)
        try container.encode(queuedFrames, forKey: .queuedFrames)
        try container.encode(totalGraphicsFramesApplied, forKey: .totalGraphicsFramesApplied)
        try container.encode(staleDiscardCount, forKey: .staleDiscardCount)
    }
}

struct OwnedGraphicsResetRequest: Codable, Equatable {
    let type: String
    let reason: String
    let lastCommittedSurfaceGeneration: UInt32
    let lastCommittedFrameId: UInt64

    var lastCommittedUpdateId: OwnedSurfaceUpdateId {
        OwnedSurfaceUpdateId(
            surfaceGeneration: lastCommittedSurfaceGeneration,
            frameId: lastCommittedFrameId
        )
    }

    enum CodingKeys: String, CodingKey {
        case type = "t"
        case reason = "r"
        case lastCommittedSurfaceGeneration = "sg"
        case lastCommittedFrameId = "id"
    }

    init(reason: String, lastCommittedSurfaceGeneration: UInt32, lastCommittedFrameId: UInt64) {
        self.type = "graphics-reset-request"
        self.reason = reason
        self.lastCommittedSurfaceGeneration = lastCommittedSurfaceGeneration
        self.lastCommittedFrameId = lastCommittedFrameId
    }
}

enum HybridGraphicsRecoveryState: String, Equatable, Sendable {
    case idle
    case resetting
    case reconnecting
    case failedCoolingDown
}

enum OwnedGraphicsResetSendError: Error, Equatable {
    case ackTimeout(OwnedSurfaceUpdateId)
    case staleChannel(OwnedSurfaceUpdateId)
}

final class OwnedGraphicsAckWaiter: @unchecked Sendable {
    private struct Waiter {
        let updateId: OwnedSurfaceUpdateId
        let continuation: CheckedContinuation<Bool, Never>
    }

    private let lock = NSLock()
    private var latestAck: OwnedSurfaceUpdateId?
    private var waiters: [UUID: Waiter] = [:]

    func wait(for updateId: OwnedSurfaceUpdateId, timeoutMs: Int) async -> Bool {
        let id = UUID()
        let shouldScheduleTimeout = lock.withLock {
            if let latestAck, latestAck >= updateId {
                return false
            }
            return true
        }
        if !shouldScheduleTimeout {
            return true
        }
        return await withCheckedContinuation { continuation in
            let shouldResumeNow = lock.withLock {
                if let latestAck, latestAck >= updateId {
                    return true
                }
                waiters[id] = Waiter(updateId: updateId, continuation: continuation)
                return false
            }
            if shouldResumeNow {
                continuation.resume(returning: true)
                return
            }
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(max(1, timeoutMs)) * 1_000_000)
                self?.finishWaiter(id: id, result: false)
            }
        }
    }

    func noteAck(_ ack: OwnedGraphicsFrameAck) {
        let completed = lock.withLock {
            if latestAck.map({ ack.updateId.isStrictlyNewer(than: $0) }) ?? true {
                latestAck = ack.updateId
            }
            let covered = waiters.filter { _, waiter in
                ack.updateId >= waiter.updateId
            }
            for id in covered.keys {
                waiters.removeValue(forKey: id)
            }
            return Array(covered.values)
        }
        for waiter in completed {
            waiter.continuation.resume(returning: true)
        }
    }

    func reset() {
        let pending = lock.withLock {
            latestAck = nil
            let pending = Array(waiters.values)
            waiters.removeAll()
            return pending
        }
        for waiter in pending {
            waiter.continuation.resume(returning: false)
        }
    }

    private func finishWaiter(id: UUID, result: Bool) {
        let waiter = lock.withLock {
            waiters.removeValue(forKey: id)
        }
        waiter?.continuation.resume(returning: result)
    }
}

// ADR-0021: single-channel backpressure. The producer holds at most
// `maxUnacked` graphics frames in flight (sent but not yet acked). In flight is
// the gap between the highest sent frameId and the highest acked frameId. Acks
// can arrive out of order or be dropped, so both watermarks only advance, never
// retreat. When at the cap the pump stalls and the mailbox coalesces dirtyRects
// into the next frame.
struct GraphicsBackpressure {
    let maxUnacked: Int
    // A2: in-flight byte ceiling. Defaults to .max so a caller that passes no byte
    // budget gets the pure frame-count behavior (and every existing count-only test
    // keeps its semantics).
    let maxUnackedBytes: Int
    // FIFO of in-flight frames in send order, carrying each frame's wire size. A
    // forward ack pops the oldest (acks are ~1:1 and monotonic, see noteAck), which
    // keeps the in-flight COUNT and in-flight BYTES exactly consistent without
    // relying on a frameId-keyed lookup that the reconnect-climbing frameId would
    // corrupt (B2).
    private var inFlightFrames: [(id: UInt64, bytes: Int)] = []
    private var inFlightBytes = 0
    private var lastAckedFrameId: UInt64 = 0

    init(maxUnacked: Int, maxUnackedBytes: Int = .max) {
        self.maxUnacked = max(maxUnacked, 1)
        self.maxUnackedBytes = max(maxUnackedBytes, 1)
    }

    var inFlight: Int { inFlightFrames.count }
    var bytesInFlight: Int { inFlightBytes }

    // Admit when nothing is in flight (never block the first frame, so a single
    // oversized frame is never permanently stalled), else gate on BOTH the frame
    // count and the in-flight byte ceiling. The byte ceiling is the lever that keeps
    // the reliable send buffer shallow during fast scroll, where one frame can be
    // 100KB+; the count guard still bounds a flood of tiny frames.
    func canProduce() -> Bool {
        if inFlightFrames.isEmpty { return true }
        return inFlightFrames.count < maxUnacked && inFlightBytes < maxUnackedBytes
    }

    mutating func noteSent(frameId: UInt64, bytes: Int = 0) {
        let b = max(0, bytes)
        inFlightFrames.append((frameId, b))
        inFlightBytes += b
    }

    // Acks carry the highest applied frameId and arrive about 1:1 with sends.
    // Count only forward progress so a duplicate or stale ack cannot double
    // decrement. Pop the OLDEST in-flight frame (send order) and release its bytes,
    // so count and bytes drain together. B2: in-flight is a true list of sent
    // frames cleared on reset, not a lastSent-minus-lastAcked frameId delta. The
    // frameId counter keeps climbing across reconnects while reset() empties the
    // list, so a post-reset send reports an in-flight of 1, not the (large) frameId.
    mutating func noteAck(frameId: UInt64) {
        guard frameId > lastAckedFrameId else { return }
        lastAckedFrameId = frameId
        guard !inFlightFrames.isEmpty else { return }
        let done = inFlightFrames.removeFirst()
        inFlightBytes = max(0, inFlightBytes - done.bytes)
    }

    // A new connection or a surface reset abandons every prior in-flight frame:
    // it will never be acked. Drop the list to empty so the cap starts clean.
    // The frameId watermark is intentionally left alone (it never resets) so the
    // monotonic ack guard above stays valid across the reconnect.
    mutating func reset() {
        inFlightFrames.removeAll()
        inFlightBytes = 0
    }
}

// A1: token-bucket pacer that keeps the average wire send-rate near a byte budget.
// The reliable graphics channel is ~2Mbps; fast scroll produces 100KB+ exposed-strip
// frames that, ungated, sum to ~4x the link and saturate the send buffer until a
// client-requested reset stripe's ack times out (the freeze cascade). The bucket
// refills at the link budget and is debited by each frame's wire size, so a big
// frame forces a longer wait before the next produce while small frames flow freely.
// Cadence tracks the actual link instead of the unacked-frame count, which the
// client drains too fast to ever signal real link saturation.
struct GraphicsSendPacer {
    let bytesPerSecond: Double
    let burstBytes: Double
    private var tokens: Double
    private var lastAdvanceNs: UInt64?

    init(bytesPerSecond: Double, burstBytes: Double) {
        self.bytesPerSecond = max(1, bytesPerSecond)
        self.burstBytes = max(0, burstBytes)
        self.tokens = self.burstBytes
    }

    // Non-mutating peek of the balance at nowNs: the stored balance plus the budget
    // accrued since the last consume. It does not advance the clock, so it is safe to
    // call repeatedly (and from a Testing #expect autoclosure) without changing state.
    func availableTokens(nowNs: UInt64) -> Double {
        guard let last = lastAdvanceNs, nowNs > last else { return tokens }
        let secs = Double(nowNs - last) / 1_000_000_000
        return min(burstBytes, tokens + secs * bytesPerSecond)
    }

    // True when any positive budget remains. The frame's size is unknown before it
    // is built, so admission only requires a positive balance; consume() then debits
    // the real wire size, letting tokens go negative so the overshoot is repaid as a
    // longer wait before the next admission.
    func canSend(nowNs: UInt64) -> Bool { availableTokens(nowNs: nowNs) > 0 }

    mutating func consume(bytes: Int, nowNs: UInt64) {
        tokens = availableTokens(nowNs: nowNs)
        lastAdvanceNs = nowNs
        tokens -= Double(max(0, bytes))
        // Bound the debt so one oversized frame cannot stall the pump for many
        // seconds; recovery after any frame is at most burstBytes / bytesPerSecond.
        if tokens < -burstBytes { tokens = -burstBytes }
    }
}

struct InputChannelEvent: Codable, Equatable {
    let type: String
    let event: NormalizedInput

    enum CodingKeys: String, CodingKey {
        case type = "t"
        case event = "ev"
    }

    init(event: NormalizedInput) {
        self.type = "input-event"
        self.event = event
    }
}

struct InputChannelClose: Codable, Equatable {
    let type: String
    let reason: String

    enum CodingKeys: String, CodingKey {
        case type = "t"
        case reason = "r"
    }

    init(reason: String) {
        self.type = "input-close"
        self.reason = reason
    }
}

// R11 DesktopState. Pushed host -> client over the session input stream,
// distinct from the client -> host InputChannelEvent path. The client
// uses it to render the dots band (one dot per user Space on the
// active display; the active one is filled). Field set is the v0
// minimum needed for that render; v1's per-agent carousel will extend
// DisplayMetadata with name / isMain / nativePixelSize.
//
// Space `id` is WindowServer's monotonic uint64 (CGS `id64`), not the
// "Desktop N" ordinal Mission Control displays. `index` is the 0-based
// ordinal position among user (type=0) Spaces on the owning display;
// it is nil for non-user (fullscreen) Spaces. The two together let the
// client reconstruct the dot layout deterministically.

struct DisplayMetadata: Codable, Equatable {
    let id: String
    // ADR-0009 cursor-driven viewport pan. Display dimensions in points,
    // matching CGDisplayBounds / what InputDispatcher clamps cursor
    // positions against. The client uses these to clamp its predicted
    // cursor model and to map source-display coords into the iPhone's
    // sinkView for edge-follow viewport math.
    let widthPoints: Float
    let heightPoints: Float

    enum CodingKeys: String, CodingKey {
        case id = "i"
        case widthPoints = "w"
        case heightPoints = "h"
    }
}

struct SpaceMetadata: Codable, Equatable {
    let id: UInt64
    let displayId: String
    let index: Int?
    let type: Int

    enum CodingKeys: String, CodingKey {
        case id = "i"
        case displayId = "d"
        case index = "x"
        case type = "t"
    }
}

struct DesktopState: Codable, Equatable {
    let displays: [DisplayMetadata]
    let spaces: [SpaceMetadata]
    let activeDisplayId: String?
    let activeSpaceId: UInt64?
    // ADR-0009: current Mac cursor position in logical display points at
    // the moment the push was built. Nil when unavailable. The client
    // uses this to seed cursorSourcePos on connect and display change,
    // eliminating the systematic drift that occurs when the real cursor
    // is not at display center.
    let cursorX: Float?
    let cursorY: Float?

    enum CodingKeys: String, CodingKey {
        case displays = "d"
        case spaces = "s"
        case activeDisplayId = "ad"
        case activeSpaceId = "as"
        case cursorX = "cx"
        case cursorY = "cy"
    }

    // Convenience init that keeps cursor fields optional so call sites
    // that don't supply them (tests, older callers) don't need updating.
    init(
        displays: [DisplayMetadata],
        spaces: [SpaceMetadata],
        activeDisplayId: String?,
        activeSpaceId: UInt64?,
        cursorX: Float? = nil,
        cursorY: Float? = nil
    ) {
        self.displays = displays
        self.spaces = spaces
        self.activeDisplayId = activeDisplayId
        self.activeSpaceId = activeSpaceId
        self.cursorX = cursorX
        self.cursorY = cursorY
    }
}

struct DesktopStatePush: Codable, Equatable {
    let type: String
    let state: DesktopState

    enum CodingKeys: String, CodingKey {
        case type = "t"
        case state = "s"
    }

    init(state: DesktopState) {
        self.type = "desktop-state"
        self.state = state
    }
}

// ADR-0006 thumbnail wire shapes. `ThumbnailsPush` is host -> client on
// the session input stream, on the SpaceThumbnailProvider's own cadence
// (3 s timer + Space change + on-demand). `ClientConfig` is client ->
// host, lets the client opt in / out of thumbnail capture and ask for
// a force-refresh of a single Space.
//
// The thumbnails dict uses string-keyed UInt64 Space IDs because JSON
// has no native UInt64 dict-key encoding and Swift's JSONEncoder would
// otherwise serialize a [UInt64: T] as an alternating key-value array.
// Each value is a base64-encoded JPEG (q=0.5 at 128 x 80) per ADR-0006.

// Per-Space dominant-window metadata. Captured by SpaceThumbnailProvider
// on the same cadence as the JPEGs and shipped alongside them so both
// the macOS host and iOS client can label a tile with the actual app /
// project (e.g. "agent-desk", "Slack") instead of "Desktop N".
struct SpaceTopWindow: Codable, Equatable, Sendable {
    let title: String
    let appName: String?

    enum CodingKeys: String, CodingKey {
        case title = "t"
        case appName = "a"
    }
}

struct ThumbnailsPush: Codable, Equatable {
    let type: String
    let thumbnails: [String: String]
    let topWindows: [String: SpaceTopWindow]?

    enum CodingKeys: String, CodingKey {
        case type = "t"
        case thumbnails = "tn"
        case topWindows = "tw"
    }

    init(thumbnails: [String: String], topWindows: [String: SpaceTopWindow]? = nil) {
        self.type = "thumbnails-push"
        self.thumbnails = thumbnails
        self.topWindows = topWindows
    }
}

struct AgentSayPush: Codable, Equatable {
    let type: String
    let id: String
    let phase: String
    let sequence: Int?
    let text: String?

    enum CodingKeys: String, CodingKey {
        case type = "t"
        case id
        case phase = "p"
        case sequence = "q"
        case text = "x"
    }

    init(id: String, phase: String, sequence: Int? = nil, text: String? = nil) {
        self.type = "agent-say"
        self.id = id
        self.phase = phase
        self.sequence = sequence
        self.text = text
    }
}

// Host -> client cursor-image mirror. Pushed on the session input stream whenever
// NSCursor.currentSystem changes shape (arrow, I-beam, pointing-hand,
// resize, busy, custom app cursors), plus once on attach. The client
// caches the PNG by `hash` and renders it at the locally predicted
// position, so the glyph identity is host-driven while position stays
// zero-latency. `png` is the base64 PNG; it may be nil in a later phase
// once the client is known to already hold `hash`. `hotspotXFrac` /
// `hotspotYFrac` are the cursor hotspot as a fraction of the image
// (top-left origin) so the client can anchor any cursor, not just the
// tip-at-origin arrow.
struct CursorImagePush: Codable, Equatable {
    let type: String
    let hash: String
    let png: String?
    let hotspotXFrac: Float
    let hotspotYFrac: Float
    let widthPoints: Float
    let heightPoints: Float
    let hidden: Bool

    enum CodingKeys: String, CodingKey {
        case type = "t"
        case hash = "h"
        case png = "p"
        case hotspotXFrac = "hx"
        case hotspotYFrac = "hy"
        case widthPoints = "iw"
        case heightPoints = "ih"
        case hidden = "hd"
    }

    init(
        hash: String,
        png: String?,
        hotspotXFrac: Float,
        hotspotYFrac: Float,
        widthPoints: Float,
        heightPoints: Float,
        hidden: Bool
    ) {
        self.type = "cursor"
        self.hash = hash
        self.png = png
        self.hotspotXFrac = hotspotXFrac
        self.hotspotYFrac = hotspotYFrac
        self.widthPoints = widthPoints
        self.heightPoints = heightPoints
        self.hidden = hidden
    }
}

struct ClientConfig: Codable, Equatable {
    let type: String
    let thumbnailsEnabled: Bool
    let thumbnailRefresh: UInt64?

    enum CodingKeys: String, CodingKey {
        case type = "t"
        case thumbnailsEnabled = "te"
        case thumbnailRefresh = "tr"
    }

    init(thumbnailsEnabled: Bool, thumbnailRefresh: UInt64? = nil) {
        self.type = "client-config"
        self.thumbnailsEnabled = thumbnailsEnabled
        self.thumbnailRefresh = thumbnailRefresh
    }
}
