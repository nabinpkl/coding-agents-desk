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

// ADR-0003 session-establishment wire shapes. Sent over the existing TLS
// WebSocket on the /session path; first-frame `type` field dispatches between
// pairing and session handlers.

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
    let inputCapability: String
    let inputCapabilityExpiresAt: Int
    let mediaCapability: String
    let mediaCapabilityExpiresAt: Int

    enum CodingKeys: String, CodingKey {
        case type = "t"
        case sessionId = "sid"
        case inputCapability = "ic"
        case inputCapabilityExpiresAt = "ie"
        case mediaCapability = "mc"
        case mediaCapabilityExpiresAt = "me"
    }

    init(
        sessionId: String,
        inputCapability: String,
        inputCapabilityExpiresAt: Int,
        mediaCapability: String = "",
        mediaCapabilityExpiresAt: Int = 0
    ) {
        self.type = "session-ready"
        self.sessionId = sessionId
        self.inputCapability = inputCapability
        self.inputCapabilityExpiresAt = inputCapabilityExpiresAt
        self.mediaCapability = mediaCapability
        self.mediaCapabilityExpiresAt = mediaCapabilityExpiresAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        sessionId = try container.decode(String.self, forKey: .sessionId)
        inputCapability = try container.decode(String.self, forKey: .inputCapability)
        inputCapabilityExpiresAt = try container.decode(Int.self, forKey: .inputCapabilityExpiresAt)
        mediaCapability = try container.decodeIfPresent(String.self, forKey: .mediaCapability) ?? ""
        mediaCapabilityExpiresAt = try container.decodeIfPresent(Int.self, forKey: .mediaCapabilityExpiresAt) ?? 0
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)
        try container.encode(sessionId, forKey: .sessionId)
        try container.encode(inputCapability, forKey: .inputCapability)
        try container.encode(inputCapabilityExpiresAt, forKey: .inputCapabilityExpiresAt)
        try container.encode(mediaCapability, forKey: .mediaCapability)
        try container.encode(mediaCapabilityExpiresAt, forKey: .mediaCapabilityExpiresAt)
    }
}

struct MediaCapabilityGrant: Codable, Equatable {
    let type: String
    let sessionId: String
    let mediaCapability: String
    let mediaCapabilityExpiresAt: Int

    enum CodingKeys: String, CodingKey {
        case type = "t"
        case sessionId = "sid"
        case mediaCapability = "mc"
        case mediaCapabilityExpiresAt = "me"
    }

    init(sessionId: String, mediaCapability: String, mediaCapabilityExpiresAt: Int) {
        self.type = "media-capability-grant"
        self.sessionId = sessionId
        self.mediaCapability = mediaCapability
        self.mediaCapabilityExpiresAt = mediaCapabilityExpiresAt
    }
}

struct MediaCapabilityRefreshRequest: Codable, Equatable {
    let type: String
    let deviceFingerprint: DeviceFingerprint
    let sessionId: String

    enum CodingKeys: String, CodingKey {
        case type = "t"
        case deviceFingerprint = "d"
        case sessionId = "sid"
    }

    init(deviceFingerprint: DeviceFingerprint, sessionId: String) {
        self.type = "media-capability-refresh"
        self.deviceFingerprint = deviceFingerprint
        self.sessionId = sessionId
    }
}

struct InputCapabilityRefreshRequest: Codable, Equatable {
    let type: String
    let deviceFingerprint: DeviceFingerprint
    let sessionId: String

    enum CodingKeys: String, CodingKey {
        case type = "t"
        case deviceFingerprint = "d"
        case sessionId = "sid"
    }

    init(deviceFingerprint: DeviceFingerprint, sessionId: String) {
        self.type = "input-capability-refresh"
        self.deviceFingerprint = deviceFingerprint
        self.sessionId = sessionId
    }
}

struct InputCapabilityGrant: Codable, Equatable {
    let type: String
    let sessionId: String
    let inputCapability: String
    let inputCapabilityExpiresAt: Int

    enum CodingKeys: String, CodingKey {
        case type = "t"
        case sessionId = "sid"
        case inputCapability = "ic"
        case inputCapabilityExpiresAt = "ie"
    }

    init(sessionId: String, inputCapability: String, inputCapabilityExpiresAt: Int) {
        self.type = "input-capability-grant"
        self.sessionId = sessionId
        self.inputCapability = inputCapability
        self.inputCapabilityExpiresAt = inputCapabilityExpiresAt
    }
}

enum SessionRejectionReason: String, Codable, Equatable, Error {
    case revoked
    case unknownDevice = "unknown-device"
    case replay
    case badSignature = "bad-signature"
    case malformed
    case unauthorized
    case expiredInputCapability = "expired-input-capability"
    case staleInputCapability = "stale-input-capability"
    case expiredMediaCapability = "expired-media-capability"
    case staleMediaCapability = "stale-media-capability"
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

    static func fromEncodedFrame(
        frameId: UInt64,
        isKeyframe: Bool,
        requestedKeyframeReason: OwnedMediaKeyframeReason?,
        expectedKeyframeReason: OwnedMediaKeyframeReason?
    ) -> OwnedMediaRefreshReason {
        if frameId == 1 {
            return .initial
        }
        guard isKeyframe else {
            return .rest
        }
        if requestedKeyframeReason == .clientRequest || expectedKeyframeReason == .clientRequest {
            return .reset
        }
        return .rest
    }
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

// ADR-0005 input-channel wire shapes. Sent over a dedicated WebSocket
// Secure connection on the existing signaling port 41888, distinct
// from the media channel that carries video. First frame on a
// new connection MUST be `InputChannelHello`; anything else closes the
// connection. The host replies with `InputChannelReady` after accepting
// the hello and before it hands the socket to InputChannelServer.
// Subsequent frames are `InputChannelEvent`, one `NormalizedInput` per
// WebSocket text frame. `InputChannelClose` is optional, server-initiated,
// for clean teardown with reason.

struct InputChannelHello: Codable, Equatable {
    let type: String
    let deviceFingerprint: DeviceFingerprint
    let sessionId: String
    let inputCapability: String

    enum CodingKeys: String, CodingKey {
        case type = "t"
        case deviceFingerprint = "d"
        case sessionId = "sid"
        case inputCapability = "ic"
    }

    init(deviceFingerprint: DeviceFingerprint, sessionId: String, inputCapability: String) {
        self.type = "input-hello"
        self.deviceFingerprint = deviceFingerprint
        self.sessionId = sessionId
        self.inputCapability = inputCapability
    }
}

struct InputChannelReady: Codable, Equatable {
    let type: String
    let sessionId: String

    enum CodingKeys: String, CodingKey {
        case type = "t"
        case sessionId = "sid"
    }

    init(sessionId: String) {
        self.type = "input-ready"
        self.sessionId = sessionId
    }
}

struct MediaChannelHello: Codable, Equatable {
    let type: String
    let deviceFingerprint: DeviceFingerprint
    let sessionId: String
    let mediaCapability: String
    let clientNonce: Data

    enum CodingKeys: String, CodingKey {
        case type = "t"
        case deviceFingerprint = "d"
        case sessionId = "sid"
        case mediaCapability = "mc"
        case clientNonce = "cn"
    }

    init(deviceFingerprint: DeviceFingerprint, sessionId: String, mediaCapability: String, clientNonce: Data = Data()) {
        self.type = "media-hello"
        self.deviceFingerprint = deviceFingerprint
        self.sessionId = sessionId
        self.mediaCapability = mediaCapability
        self.clientNonce = clientNonce
    }
}

struct MediaChannelReady: Codable, Equatable {
    let type: String
    let sessionId: String
    let serverNonce: Data

    enum CodingKeys: String, CodingKey {
        case type = "t"
        case sessionId = "sid"
        case serverNonce = "sn"
    }

    init(sessionId: String, serverNonce: Data = Data()) {
        self.type = "media-ready"
        self.sessionId = sessionId
        self.serverNonce = serverNonce
    }
}

struct GraphicsChannelHello: Codable, Equatable {
    let type: String
    let deviceFingerprint: DeviceFingerprint
    let sessionId: String
    let graphicsCapability: String
    let clientNonce: Data

    enum CodingKeys: String, CodingKey {
        case type = "t"
        case deviceFingerprint = "d"
        case sessionId = "sid"
        case graphicsCapability = "gc"
        case clientNonce = "cn"
    }

    init(deviceFingerprint: DeviceFingerprint, sessionId: String, graphicsCapability: String, clientNonce: Data = Data()) {
        self.type = "graphics-hello"
        self.deviceFingerprint = deviceFingerprint
        self.sessionId = sessionId
        self.graphicsCapability = graphicsCapability
        self.clientNonce = clientNonce
    }
}

struct GraphicsChannelReady: Codable, Equatable {
    let type: String
    let sessionId: String
    let serverNonce: Data

    enum CodingKeys: String, CodingKey {
        case type = "t"
        case sessionId = "sid"
        case serverNonce = "sn"
    }

    init(sessionId: String, serverNonce: Data = Data()) {
        self.type = "graphics-ready"
        self.sessionId = sessionId
        self.serverNonce = serverNonce
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
    // page load, or a scroll that could not be copyRect'd) is multi-MB as raw
    // LZFSE and saturated the single reliable graphics channel, freezing the
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

enum OwnedGraphicsCommand: Equatable {
    case resetSurface(surfaceGeneration: UInt32, width: Int, height: Int, pixelFormat: OwnedGraphicsPixelFormat)
    case copyRect(srcX: Int, srcY: Int, dstX: Int, dstY: Int, width: Int, height: Int)
    case bitmapTile(x: Int, y: Int, width: Int, height: Int, compression: OwnedGraphicsTileCompression, byteRange: OwnedGraphicsByteRange)
    case cacheTile(slot: UInt16, x: Int, y: Int, width: Int, height: Int, compression: OwnedGraphicsTileCompression, byteRange: OwnedGraphicsByteRange)
    case drawCachedTile(slot: UInt16, x: Int, y: Int, width: Int, height: Int)

    enum Kind: String, Codable {
        case resetSurface
        case copyRect
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
        case srcX = "sx"
        case srcY = "sy"
        case dstX = "dx"
        case dstY = "dy"
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
        case let .copyRect(srcX, srcY, dstX, dstY, width, height):
            guard srcX >= 0, srcY >= 0, dstX >= 0, dstY >= 0, width > 0, height > 0 else {
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
        case .copyRect:
            self = .copyRect(
                srcX: try container.decode(Int.self, forKey: .srcX),
                srcY: try container.decode(Int.self, forKey: .srcY),
                dstX: try container.decode(Int.self, forKey: .dstX),
                dstY: try container.decode(Int.self, forKey: .dstY),
                width: try container.decode(Int.self, forKey: .width),
                height: try container.decode(Int.self, forKey: .height)
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
        case let .copyRect(srcX, srcY, dstX, dstY, width, height):
            try container.encode(Kind.copyRect, forKey: .kind)
            try container.encode(srcX, forKey: .srcX)
            try container.encode(srcY, forKey: .srcY)
            try container.encode(dstX, forKey: .dstX)
            try container.encode(dstY, forKey: .dstY)
            try container.encode(width, forKey: .width)
            try container.encode(height, forKey: .height)
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

enum OwnedMediaControlKind: String, Codable, Equatable {
    case keyframeRequest = "keyframe-request"
    case packetResendRequest = "packet-resend-request"
    case frameAck = "frame-ack"
    case graphicsResetRequest = "graphics-reset-request"
    case keepalive = "keepalive"
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
        reason: String? = nil
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
    }
}

struct OwnedMediaSentFrame: Equatable {
    let bytes: Int
    let capturedAtUptimeNs: UInt64
}

struct OwnedMediaSendFreshness: Equatable {
    private(set) var latestAckedFrameId: UInt64 = 0
    private(set) var inFlightFrames: [UInt64: OwnedMediaSentFrame] = [:]
    private(set) var latestClientRenderGapMs: Double = 0
    private(set) var latestClientFrameAgeMs: Double = 0
    private(set) var latestClientBacklogFrames: Int = 0
    private(set) var latestClientBacklogBytes: Int = 0

    var inFlightBytes: Int {
        inFlightFrames.values.reduce(0) { $0 + $1.bytes }
    }

    mutating func noteSent(frameId: UInt64, bytes: Int, capturedAtUptimeNs: UInt64) {
        inFlightFrames[frameId] = OwnedMediaSentFrame(
            bytes: bytes,
            capturedAtUptimeNs: capturedAtUptimeNs
        )
    }

    @discardableResult
    mutating func noteAck(
        frameId: UInt64,
        renderGapMs: Double?,
        clientBacklogFrames: Int?,
        clientBacklogBytes: Int?,
        nowUptimeNs: UInt64
    ) -> Double? {
        latestAckedFrameId = max(latestAckedFrameId, frameId)
        var computedFrameAgeMs: Double?
        if let acknowledged = inFlightFrames[frameId],
           nowUptimeNs >= acknowledged.capturedAtUptimeNs {
            computedFrameAgeMs = Double(nowUptimeNs - acknowledged.capturedAtUptimeNs) / 1_000_000.0
            latestClientFrameAgeMs = computedFrameAgeMs ?? latestClientFrameAgeMs
        }
        inFlightFrames = inFlightFrames.filter { $0.key > latestAckedFrameId }
        latestClientRenderGapMs = max(0, renderGapMs ?? 0)
        latestClientBacklogFrames = max(0, clientBacklogFrames ?? 0)
        latestClientBacklogBytes = max(0, clientBacklogBytes ?? 0)
        return computedFrameAgeMs
    }

    func isClientBehind(backpressure: OwnedMediaBackpressureConfig) -> Bool {
        latestAckedFrameId > 0 && (
            inFlightFrames.count > backpressure.maxInflightFrames ||
            inFlightBytes > backpressure.maxInflightBytes ||
            latestClientFrameAgeMs > backpressure.frameAgeMs ||
            latestClientBacklogFrames > 0
        )
    }
}

struct OwnedMediaBackpressureConfig: Equatable {
    let frameAgeMs: Double
    let severeFrameAgeMs: Double
    let maxInflightFrames: Int
    let maxInflightBytes: Int
    let expectedFrameRate: Int
    let behindEncodeIntervalMs: Int
    let severeEncodeIntervalMs: Int
    let drainTimeoutMs: Int
    let keyframeCooldownMs: Int
    let normalMaxUnackedFrames: Int
    let behindMaxUnackedFrames: Int
    let staleUnackedMs: Int

    init(
        frameAgeMs: Double,
        severeFrameAgeMs: Double,
        maxInflightFrames: Int,
        maxInflightBytes: Int,
        expectedFrameRate: Int,
        behindEncodeIntervalMs: Int,
        severeEncodeIntervalMs: Int,
        drainTimeoutMs: Int,
        keyframeCooldownMs: Int,
        normalMaxUnackedFrames: Int,
        behindMaxUnackedFrames: Int,
        staleUnackedMs: Int
    ) {
        self.frameAgeMs = frameAgeMs
        self.severeFrameAgeMs = severeFrameAgeMs
        self.maxInflightFrames = maxInflightFrames
        self.maxInflightBytes = maxInflightBytes
        self.expectedFrameRate = expectedFrameRate
        self.behindEncodeIntervalMs = behindEncodeIntervalMs
        self.severeEncodeIntervalMs = severeEncodeIntervalMs
        self.drainTimeoutMs = drainTimeoutMs
        self.keyframeCooldownMs = keyframeCooldownMs
        self.normalMaxUnackedFrames = normalMaxUnackedFrames
        self.behindMaxUnackedFrames = behindMaxUnackedFrames
        self.staleUnackedMs = staleUnackedMs
    }

    var normalEncodeIntervalMs: Int {
        max(1, Int((1_000.0 / Double(max(expectedFrameRate, 1))).rounded(.up)))
    }
}

enum OwnedMediaCadenceMode: Equatable {
    case normal
    case behind
    case draining
}

enum OwnedMediaEncodeBudgetMode: String, Equatable, Sendable {
    case rest
    case motion
}

struct OwnedMediaEncodeBudget: Equatable, Sendable {
    let mode: OwnedMediaEncodeBudgetMode
    let bitrateKbps: Int
    let expectedFrameRate: Int
    private let requestedScaleDown: Double

    var scaleDown: Double {
        max(requestedScaleDown, 1.0)
    }

    init(
        mode: OwnedMediaEncodeBudgetMode,
        bitrateKbps: Int,
        expectedFrameRate: Int,
        scaleDown: Double = 1.0
    ) {
        self.mode = mode
        self.bitrateKbps = bitrateKbps
        self.expectedFrameRate = expectedFrameRate
        self.requestedScaleDown = scaleDown
    }
}

struct OwnedHybridHEVCScalePolicy {
    static func encodeScaleDown(requestedScaleDown: Double, retainedGraphicsAvailable: Bool) -> Double {
        retainedGraphicsAvailable ? 1.0 : max(requestedScaleDown, 1.0)
    }
}

enum HybridScrollHEVCDecision: Equatable {
    case allow
    case suppress
    case rateLimited
}

struct HybridScrollHEVCAdmission: Equatable {
    private(set) var lastAcceptedScrollAtUptimeNs: UInt64?
    private(set) var lastScrollHevcRefreshAtUptimeNs: UInt64?
    private(set) var lastScrollSignalAtUptimeNs: UInt64?
    private(set) var pendingIdleRefresh = false

    // Record a live scroll input signal. Used to hold a hysteresis window open
    // across a flick and its momentum tail, independent of whether any frame was
    // accepted as a copyRect, so the HEVC fallback stays rate-limited even when
    // fast frames cannot be copyRect'd and the input hint has expired.
    mutating func noteScrollSignal(nowUptimeNs: UInt64) {
        lastScrollSignalAtUptimeNs = nowUptimeNs
    }

    func withinScrollHysteresis(nowUptimeNs: UInt64, windowMs: Int) -> Bool {
        guard let lastScrollSignalAtUptimeNs else { return false }
        return nowUptimeNs &- lastScrollSignalAtUptimeNs < UInt64(max(0, windowMs)) * 1_000_000
    }

    mutating func noteAcceptedScroll(nowUptimeNs: UInt64) {
        lastAcceptedScrollAtUptimeNs = nowUptimeNs
        pendingIdleRefresh = true
    }

    mutating func noteActiveScroll(nowUptimeNs: UInt64) {
        guard pendingIdleRefresh else { return }
        lastAcceptedScrollAtUptimeNs = nowUptimeNs
    }

    mutating func idleRefreshDue(nowUptimeNs: UInt64, idleRefreshMs: Int) -> Bool {
        guard pendingIdleRefresh,
              let lastAcceptedScrollAtUptimeNs,
              nowUptimeNs &- lastAcceptedScrollAtUptimeNs >= UInt64(idleRefreshMs) * 1_000_000 else {
            return false
        }
        pendingIdleRefresh = false
        return true
    }

    func idleRefreshEligible(nowUptimeNs: UInt64, idleRefreshMs: Int) -> Bool {
        guard pendingIdleRefresh,
              let lastAcceptedScrollAtUptimeNs else {
            return false
        }
        return nowUptimeNs &- lastAcceptedScrollAtUptimeNs >= UInt64(idleRefreshMs) * 1_000_000
    }

    mutating func decisionAfterAcceptedScroll(nowUptimeNs: UInt64, scrollHEVCFps: Int) -> HybridScrollHEVCDecision {
        guard scrollHEVCFps > 0 else { return .suppress }
        let minRefreshIntervalNs = 1_000_000_000 / UInt64(scrollHEVCFps)
        if let lastScrollHevcRefreshAtUptimeNs,
           nowUptimeNs &- lastScrollHevcRefreshAtUptimeNs < minRefreshIntervalNs {
            return .rateLimited
        }
        lastScrollHevcRefreshAtUptimeNs = nowUptimeNs
        return .allow
    }

    // Liveness floor for active scroll. The copyRect stream carries motion when it
    // accepts, but the frames it cannot copy (new content on a fast flick, momentum
    // redraws) must still refresh the screen or it freezes for the whole scroll.
    // The prior design hard-suppressed HEVC for idleRefreshMs after every accepted
    // copyRect, so during continuous scrolling HEVC was off almost permanently and
    // any frame copyRect could not carry was dropped, freezing the screen (R74:
    // 7.3s gaps with only ~6 surface updates). This admits a full HEVC frame only
    // when copyRect has NOT updated the screen within the floor interval, and caps
    // it at floorFps so it never floods the client while copyRect is keeping up.
    // copyRect updates therefore suppress the floor (copyRect IS the floor when it
    // is accepting); HEVC fills only the gaps. Returns true if this floor frame may
    // send. floorFps == 0 disables the floor (full suppression).
    mutating func admitScrollFloorHEVC(nowUptimeNs: UInt64, floorFps: Int) -> Bool {
        guard floorFps > 0 else { return false }
        let floorIntervalNs = 1_000_000_000 / UInt64(floorFps)
        if let lastAcceptedScrollAtUptimeNs,
           nowUptimeNs &- lastAcceptedScrollAtUptimeNs < floorIntervalNs {
            return false
        }
        if let lastScrollHevcRefreshAtUptimeNs,
           nowUptimeNs &- lastScrollHevcRefreshAtUptimeNs < floorIntervalNs {
            return false
        }
        lastScrollHevcRefreshAtUptimeNs = nowUptimeNs
        return true
    }

    func allowsHintTimeoutFallback(nowUptimeNs: UInt64, fallbackGraceMs: Int) -> Bool {
        guard let lastAcceptedScrollAtUptimeNs else { return true }
        return nowUptimeNs &- lastAcceptedScrollAtUptimeNs >= UInt64(max(0, fallbackGraceMs)) * 1_000_000
    }

    // True when the graphics path accepted a scroll update within the window, i.e.
    // graphics is actively carrying motion. Used to decide whether suppressing the
    // HEVC full-frame path during scroll is safe.
    func recentlyAcceptedScroll(nowUptimeNs: UInt64, windowMs: Int) -> Bool {
        guard let lastAcceptedScrollAtUptimeNs else { return false }
        return nowUptimeNs &- lastAcceptedScrollAtUptimeNs < UInt64(max(0, windowMs)) * 1_000_000
    }
}

enum OwnedHybridHEVCFallbackReason: String, Equatable, Sendable {
    case scrollTimeout = "scroll-timeout"
    case graphicsDisconnected = "graphics-disconnected"
    case graphicsReset = "graphics-reset"
    case graphicsSendFailed = "graphics-send-failed"
    case graphicsResetSendFailed = "graphics-reset-send-failed"
    case rejectedMotion = "rejected-motion"
    case scrollRegionBeforeLock = "scroll-region-before-lock"

    var requestsKeyframe: Bool {
        false
    }
}

enum HybridGraphicsRecoveryState: String, Equatable, Sendable {
    case idle
    case resetting
    case reconnecting
    case failedCoolingDown
}

enum HybridGraphicsRecoveryHEVCDecision: Equatable {
    case allow
    case suppress(reason: String)
}

enum HybridHEVCVisualDecision: Equatable {
    case allow
    case suppress(reason: String)
}

enum HybridHEVCBaselineDecision: Equatable {
    case realign
    case visualOnly(reason: String)
}

struct HybridHEVCFallbackPolicyContext: Equatable, Sendable {
    let fallbackReason: OwnedHybridHEVCFallbackReason?
    let inputScrollActive: Bool
    let ownershipActive: Bool
    let regionLockPending: Bool
    let stableViewportActive: Bool
    let graphicsRecoveryState: HybridGraphicsRecoveryState
    let isIdleCorrectnessRefresh: Bool
    // True only while the graphics path is actually emitting accepted scroll
    // updates. HEVC full frames are suppressed during scroll to avoid overwriting
    // a graphics-owned retained surface; that suppression is only safe while
    // graphics is producing. When graphics is silent, HEVC must carry the motion
    // or the screen freezes for the scroll duration.
    let graphicsRecentlyProducing: Bool
}

struct HybridHEVCFallbackPolicyDecision: Equatable {
    let visualDecision: HybridHEVCVisualDecision
    let baselineDecision: HybridHEVCBaselineDecision
}

struct HybridHEVCFallbackPolicy {
    static func evaluate(_ context: HybridHEVCFallbackPolicyContext) -> HybridHEVCFallbackPolicyDecision {
        let baselineDecision = baselineDecision(for: context)
        return HybridHEVCFallbackPolicyDecision(
            visualDecision: visualDecision(for: context, baselineDecision: baselineDecision),
            baselineDecision: baselineDecision
        )
    }

    private static func visualDecision(
        for context: HybridHEVCFallbackPolicyContext,
        baselineDecision: HybridHEVCBaselineDecision
    ) -> HybridHEVCVisualDecision {
        if case .visualOnly = baselineDecision {
            return .suppress(reason: "baseline-not-realigned")
        }
        guard context.stableViewportActive,
              let fallbackReason = context.fallbackReason,
              suppressesVisualHEVCForStableViewport(fallbackReason) else {
            return .allow
        }
        return .suppress(reason: "stable-viewport-suppressed-hevc")
    }

    private static func baselineDecision(for context: HybridHEVCFallbackPolicyContext) -> HybridHEVCBaselineDecision {
        if context.isIdleCorrectnessRefresh, !context.inputScrollActive, context.graphicsRecoveryState == .idle {
            return .realign
        }
        if context.graphicsRecoveryState != .idle {
            return .realign
        }
        // Suppress HEVC (visual-only) during scroll only while graphics is
        // actually producing accepted updates. If graphics is silent, fall
        // through to .realign so HEVC carries the motion instead of freezing.
        if context.inputScrollActive, context.graphicsRecentlyProducing {
            return .visualOnly(reason: "active-scroll")
        }
        if context.ownershipActive, context.graphicsRecentlyProducing {
            return .visualOnly(reason: "scroll-ownership")
        }
        if context.regionLockPending, context.graphicsRecentlyProducing {
            return .visualOnly(reason: "region-lock-pending")
        }
        if context.stableViewportActive {
            return .visualOnly(reason: "stable-viewport")
        }
        return .realign
    }

    private static func suppressesVisualHEVCForStableViewport(_ reason: OwnedHybridHEVCFallbackReason) -> Bool {
        switch reason {
        case .scrollTimeout,
             .scrollRegionBeforeLock,
             .rejectedMotion,
             .graphicsReset,
             .graphicsSendFailed,
             .graphicsResetSendFailed:
            return true
        case .graphicsDisconnected:
            return false
        }
    }
}

struct HybridGraphicsRecoveryHEVCGate: Equatable {
    private(set) var lastFallbackAtUptimeNs: UInt64?

    mutating func decision(
        reason: OwnedHybridHEVCFallbackReason?,
        recoveryState: HybridGraphicsRecoveryState,
        nowUptimeNs: UInt64,
        minIntervalMs: Int
    ) -> HybridGraphicsRecoveryHEVCDecision {
        guard let reason, Self.isGraphicsRecoveryReason(reason) else {
            return .allow
        }
        switch recoveryState {
        case .idle:
            return .allow
        case .resetting:
            return .suppress(reason: "graphics-recovery-resetting")
        case .reconnecting, .failedCoolingDown:
            let minIntervalNs = UInt64(max(0, minIntervalMs)) * 1_000_000
            if let lastFallbackAtUptimeNs,
               nowUptimeNs &- lastFallbackAtUptimeNs < minIntervalNs {
                return .suppress(reason: "graphics-recovery-rate-limited")
            }
            lastFallbackAtUptimeNs = nowUptimeNs
            return .allow
        }
    }

    private static func isGraphicsRecoveryReason(_ reason: OwnedHybridHEVCFallbackReason) -> Bool {
        switch reason {
        case .graphicsDisconnected, .graphicsReset, .graphicsSendFailed, .graphicsResetSendFailed:
            return true
        case .scrollTimeout, .rejectedMotion, .scrollRegionBeforeLock:
            return false
        }
    }
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
// into the next frame. This replaces the admission/floor/hysteresis/severe-mode
// layer (the OwnedGraphicsAdmission types are deleted in a later task).
struct GraphicsBackpressure {
    let maxUnacked: Int
    private var inFlightCount = 0
    private var lastAckedFrameId: UInt64 = 0

    init(maxUnacked: Int) {
        self.maxUnacked = max(maxUnacked, 1)
    }

    var inFlight: Int { inFlightCount }
    func canProduce() -> Bool { inFlightCount < maxUnacked }
    mutating func noteSent(frameId: UInt64) { inFlightCount += 1 }

    // Acks carry the highest applied frameId and arrive about 1:1 with sends.
    // Count only forward progress so a duplicate or stale ack cannot double
    // decrement, and clamp at zero so a late ack arriving after a reset cannot
    // drive the count negative. B2: this is a plain in-flight COUNT, not a
    // lastSent-minus-lastAcked frameId delta. The frameId counter keeps climbing
    // across reconnects while reset() zeroed the watermarks, so the old delta
    // spiked inFlight to the full frameId value (about 141 on the device run)
    // right after a reconnect and stalled or thrashed the cap. A count is immune
    // to the frameId numbering.
    mutating func noteAck(frameId: UInt64) {
        guard frameId > lastAckedFrameId else { return }
        lastAckedFrameId = frameId
        inFlightCount = max(0, inFlightCount - 1)
    }

    // A new connection or a surface reset abandons every prior in-flight frame:
    // it will never be acked. Drop the count to zero so the cap starts clean.
    // The frameId watermark is intentionally left alone (it never resets) so the
    // monotonic ack guard above stays valid across the reconnect.
    mutating func reset() {
        inFlightCount = 0
    }
}

enum OwnedGraphicsAdmissionMode: Equatable {
    case normal
    case behind
    case severe
}

struct OwnedGraphicsAdmissionConfig: Equatable, Sendable {
    let normalMaxUnackedFrames: Int
    let behindMaxUnackedFrames: Int
    let maxUnackedBytes: Int
    let behindQueuedFrames: Int
    let severeQueuedFrames: Int
    let behindQueueDepthBytes: Int
    let severeQueueDepthBytes: Int
    let behindCompositorMs: Double
    let severeCompositorMs: Double

    init(
        normalMaxUnackedFrames: Int,
        behindMaxUnackedFrames: Int,
        maxUnackedBytes: Int,
        behindQueuedFrames: Int,
        severeQueuedFrames: Int,
        behindQueueDepthBytes: Int,
        severeQueueDepthBytes: Int,
        behindCompositorMs: Double,
        severeCompositorMs: Double
    ) {
        self.normalMaxUnackedFrames = max(normalMaxUnackedFrames, 1)
        self.behindMaxUnackedFrames = max(behindMaxUnackedFrames, 1)
        self.maxUnackedBytes = max(maxUnackedBytes, 1)
        self.behindQueuedFrames = max(behindQueuedFrames, 1)
        self.severeQueuedFrames = max(severeQueuedFrames, self.behindQueuedFrames + 1)
        self.behindQueueDepthBytes = max(behindQueueDepthBytes, 1)
        self.severeQueueDepthBytes = max(severeQueueDepthBytes, self.behindQueueDepthBytes + 1)
        self.behindCompositorMs = max(behindCompositorMs, 0)
        self.severeCompositorMs = max(severeCompositorMs, self.behindCompositorMs)
    }
}

struct OwnedGraphicsAdmissionDecision: Equatable {
    let shouldBuildCommands: Bool
    let mode: OwnedGraphicsAdmissionMode
    let reason: String?
    let unackedFrames: Int
    let unackedBytes: Int
}

struct OwnedGraphicsAdmission: Equatable {
    private var unackedFrames: [OwnedSurfaceUpdateId: Int] = [:]
    private(set) var latestAck: OwnedGraphicsFrameAck?
    private(set) var mode: OwnedGraphicsAdmissionMode = .normal

    var unackedFrameCount: Int { unackedFrames.count }
    var unackedByteCount: Int { unackedFrames.values.reduce(0, +) }

    mutating func noteSent(updateId: OwnedSurfaceUpdateId, encodedBytes: Int, config: OwnedGraphicsAdmissionConfig) {
        unackedFrames[updateId] = max(encodedBytes, 0)
        refreshMode(config: config)
    }

    mutating func noteAck(_ ack: OwnedGraphicsFrameAck, config: OwnedGraphicsAdmissionConfig) {
        latestAck = ack
        unackedFrames = unackedFrames.filter { updateId, _ in
            updateId.isStrictlyNewer(than: ack.updateId)
        }
        refreshMode(config: config)
    }

    mutating func reset(config: OwnedGraphicsAdmissionConfig) {
        unackedFrames.removeAll()
        latestAck = nil
        refreshMode(config: config)
    }

    mutating func decision(
        allowsReset: Bool,
        config: OwnedGraphicsAdmissionConfig
    ) -> OwnedGraphicsAdmissionDecision {
        refreshMode(config: config)
        if allowsReset {
            return OwnedGraphicsAdmissionDecision(
                shouldBuildCommands: true,
                mode: mode,
                reason: nil,
                unackedFrames: unackedFrameCount,
                unackedBytes: unackedByteCount
            )
        }
        let maxFrames = mode == .normal ? config.normalMaxUnackedFrames : config.behindMaxUnackedFrames
        if mode == .severe {
            return hold(reason: "graphics-severe")
        }
        if unackedFrameCount >= maxFrames {
            return hold(reason: "graphics-unacked-frames")
        }
        if unackedByteCount >= config.maxUnackedBytes {
            return hold(reason: "graphics-unacked-bytes")
        }
        return OwnedGraphicsAdmissionDecision(
            shouldBuildCommands: true,
            mode: mode,
            reason: nil,
            unackedFrames: unackedFrameCount,
            unackedBytes: unackedByteCount
        )
    }

    private mutating func refreshMode(config: OwnedGraphicsAdmissionConfig) {
        let ackQueuedFrames = latestAck?.queuedFrames ?? 0
        let ackQueueDepthBytes = latestAck?.queueDepthBytes ?? 0
        let ackCompositorMs = latestAck?.compositorMs ?? 0
        if unackedByteCount >= config.maxUnackedBytes * 2
            || ackQueuedFrames >= config.severeQueuedFrames
            || ackQueueDepthBytes >= config.severeQueueDepthBytes {
            mode = .severe
        } else if unackedFrameCount >= config.normalMaxUnackedFrames
            || unackedByteCount >= config.maxUnackedBytes
            || ackQueuedFrames >= config.behindQueuedFrames
            || ackQueueDepthBytes >= config.behindQueueDepthBytes
            || ackCompositorMs >= config.behindCompositorMs {
            mode = .behind
        } else {
            mode = .normal
        }
    }

    private func hold(reason: String) -> OwnedGraphicsAdmissionDecision {
        OwnedGraphicsAdmissionDecision(
            shouldBuildCommands: false,
            mode: mode,
            reason: reason,
            unackedFrames: unackedFrameCount,
            unackedBytes: unackedByteCount
        )
    }
}

struct OwnedMediaEncodeCadencePolicy: Equatable, Sendable {
    static func intervalMs(
        admissionIntervalMs: Int,
        budget: OwnedMediaEncodeBudget
    ) -> Int {
        max(admissionIntervalMs, budgetIntervalMs(budget))
    }

    private static func budgetIntervalMs(_ budget: OwnedMediaEncodeBudget) -> Int {
        max(1, Int((1_000.0 / Double(max(budget.expectedFrameRate, 1))).rounded(.up)))
    }
}

struct OwnedMediaMotionBudgetPolicy: Equatable, Sendable {
    let enabled: Bool
    let restBitrateKbps: Int
    let restFps: Int
    let restScaleDown: Double
    let motionBitrateKbps: Int
    let motionFps: Int
    let motionScaleDown: Double
    let motionFrameAgeMs: Double
    let motionBacklogFrames: Int
    let motionInflightBytes: Int
    let restBudgetHoldMs: Int

    var restBudget: OwnedMediaEncodeBudget {
        OwnedMediaEncodeBudget(
            mode: .rest,
            bitrateKbps: restBitrateKbps,
            expectedFrameRate: restFps,
            scaleDown: restScaleDown
        )
    }

    var motionBudget: OwnedMediaEncodeBudget {
        OwnedMediaEncodeBudget(
            mode: .motion,
            bitrateKbps: motionBitrateKbps,
            expectedFrameRate: motionFps,
            scaleDown: motionScaleDown
        )
    }

    func choose(
        mode: OwnedMediaCadenceMode,
        frameAgeMs: Double,
        backlogFrames: Int,
        unacknowledgedBytes: Int,
        lastMotionBudgetAtUptimeNs: UInt64?,
        nowUptimeNs: UInt64
    ) -> OwnedMediaEncodeBudget {
        guard enabled else { return restBudget }
        if hasMotionPressure(
            mode: mode,
            frameAgeMs: frameAgeMs,
            backlogFrames: backlogFrames,
            unacknowledgedBytes: unacknowledgedBytes
        ) {
            return motionBudget
        }
        guard let lastMotionBudgetAtUptimeNs else { return restBudget }
        let holdNs = UInt64(max(restBudgetHoldMs, 0)) * 1_000_000
        if nowUptimeNs >= lastMotionBudgetAtUptimeNs &&
            nowUptimeNs - lastMotionBudgetAtUptimeNs < holdNs {
            return motionBudget
        }
        return restBudget
    }

    func hasMotionPressure(
        mode: OwnedMediaCadenceMode,
        frameAgeMs: Double,
        backlogFrames: Int,
        unacknowledgedBytes: Int
    ) -> Bool {
        guard enabled else { return false }
        return mode == .behind || mode == .draining ||
            frameAgeMs >= motionFrameAgeMs ||
            backlogFrames >= motionBacklogFrames ||
            unacknowledgedBytes >= motionInflightBytes
    }
}

struct OwnedMediaMotionBudgetState: Equatable {
    private(set) var lastMotionBudgetAtUptimeNs: UInt64?

    mutating func choose(
        policy: OwnedMediaMotionBudgetPolicy,
        mode: OwnedMediaCadenceMode,
        frameAgeMs: Double,
        backlogFrames: Int,
        unacknowledgedBytes: Int,
        nowUptimeNs: UInt64
    ) -> OwnedMediaEncodeBudget {
        let budget = policy.choose(
            mode: mode,
            frameAgeMs: frameAgeMs,
            backlogFrames: backlogFrames,
            unacknowledgedBytes: unacknowledgedBytes,
            lastMotionBudgetAtUptimeNs: lastMotionBudgetAtUptimeNs,
            nowUptimeNs: nowUptimeNs
        )
        if policy.hasMotionPressure(
            mode: mode,
            frameAgeMs: frameAgeMs,
            backlogFrames: backlogFrames,
            unacknowledgedBytes: unacknowledgedBytes
        ) {
            lastMotionBudgetAtUptimeNs = nowUptimeNs
        }
        return budget
    }
}

struct OwnedMediaAppliedEncodeBudget: Equatable {
    private(set) var budget: OwnedMediaEncodeBudget?

    func shouldApply(_ next: OwnedMediaEncodeBudget) -> Bool {
        budget != next
    }

    mutating func noteApplied(_ next: OwnedMediaEncodeBudget) {
        budget = next
    }

    mutating func reset() {
        budget = nil
    }
}

enum OwnedMediaKeyframeReason: String, Equatable, Sendable {
    case initial
    case periodic
    case clientRequest = "client-request"
}

struct OwnedMediaAdmissionDecision: Equatable {
    let shouldEncode: Bool
    let forceKeyframe: Bool
    let allowPeriodicKeyframe: Bool
    let mode: OwnedMediaCadenceMode
    let holdReason: String?
    let keyframeReason: OwnedMediaKeyframeReason?
    let abandonedStaleUnackedCount: Int
    let abandonedStaleUnackedBytes: Int
    let abandonedStaleUnackedOldestFrameId: UInt64?

    init(
        shouldEncode: Bool,
        forceKeyframe: Bool,
        allowPeriodicKeyframe: Bool,
        mode: OwnedMediaCadenceMode,
        holdReason: String?,
        keyframeReason: OwnedMediaKeyframeReason?,
        abandonedStaleUnackedCount: Int = 0,
        abandonedStaleUnackedBytes: Int = 0,
        abandonedStaleUnackedOldestFrameId: UInt64? = nil
    ) {
        self.shouldEncode = shouldEncode
        self.forceKeyframe = forceKeyframe
        self.allowPeriodicKeyframe = allowPeriodicKeyframe
        self.mode = mode
        self.holdReason = holdReason
        self.keyframeReason = keyframeReason
        self.abandonedStaleUnackedCount = abandonedStaleUnackedCount
        self.abandonedStaleUnackedBytes = abandonedStaleUnackedBytes
        self.abandonedStaleUnackedOldestFrameId = abandonedStaleUnackedOldestFrameId
    }
}

struct OwnedMediaAdmissionAckEvents: Equatable {
    let enteredDrain: Bool
    let exitedDrain: Bool
    let mode: OwnedMediaCadenceMode
}

struct OwnedMediaEncodeAdmission: Equatable {
    private(set) var latestAckedFrameId: UInt64 = 0
    private(set) var latestClientFrameAgeMs: Double = 0
    private(set) var latestClientRenderGapMs: Double = 0
    private(set) var latestClientBacklogFrames: Int = 0
    private(set) var latestClientBacklogBytes: Int = 0
    private(set) var unacknowledgedFrames: [UInt64: OwnedMediaSentFrame] = [:]
    private(set) var pendingKeyframeRequest = false
    private(set) var keyframeInFlightFrameId: UInt64?
    private(set) var lastKeyframeSentAtUptimeNs: UInt64?
    private(set) var drainEnteredAtUptimeNs: UInt64?
    private(set) var mode: OwnedMediaCadenceMode = .normal

    var unacknowledgedFrameCount: Int {
        unacknowledgedFrames.count
    }

    var unacknowledgedBytes: Int {
        unacknowledgedFrames.values.reduce(0) { $0 + $1.bytes }
    }

    mutating func noteSent(
        frameId: UInt64,
        bytes: Int,
        capturedAtUptimeNs: UInt64,
        isKeyframe: Bool,
        nowUptimeNs: UInt64,
        config: OwnedMediaBackpressureConfig
    ) {
        unacknowledgedFrames[frameId] = OwnedMediaSentFrame(
            bytes: bytes,
            capturedAtUptimeNs: capturedAtUptimeNs
        )
        if isKeyframe {
            pendingKeyframeRequest = false
            keyframeInFlightFrameId = frameId
            lastKeyframeSentAtUptimeNs = nowUptimeNs
        }
        refreshMode(config: config, nowUptimeNs: nowUptimeNs)
    }

    mutating func noteAck(
        frameId: UInt64,
        renderGapMs: Double?,
        frameAgeMs: Double?,
        clientBacklogFrames: Int?,
        clientBacklogBytes: Int?,
        nowUptimeNs: UInt64,
        config: OwnedMediaBackpressureConfig
    ) -> OwnedMediaAdmissionAckEvents {
        let previousMode = mode
        latestAckedFrameId = max(latestAckedFrameId, frameId)
        latestClientRenderGapMs = max(0, renderGapMs ?? 0)
        latestClientFrameAgeMs = max(0, frameAgeMs ?? 0)
        latestClientBacklogFrames = max(0, clientBacklogFrames ?? 0)
        latestClientBacklogBytes = max(0, clientBacklogBytes ?? 0)
        unacknowledgedFrames = unacknowledgedFrames.filter { $0.key > latestAckedFrameId }
        if let keyframeInFlightFrameId,
           keyframeInFlightFrameId <= latestAckedFrameId {
            self.keyframeInFlightFrameId = nil
        }

        refreshMode(config: config, nowUptimeNs: nowUptimeNs)
        return OwnedMediaAdmissionAckEvents(
            enteredDrain: previousMode != .draining && mode == .draining,
            exitedDrain: previousMode == .draining && mode != .draining,
            mode: mode
        )
    }

    mutating func noteKeyframeRequested() {
        pendingKeyframeRequest = true
    }

    mutating func decision(
        nowUptimeNs: UInt64,
        config: OwnedMediaBackpressureConfig
    ) -> OwnedMediaAdmissionDecision {
        refreshMode(config: config, nowUptimeNs: nowUptimeNs)
        if let staleHold = staleUnackedAdmissionHoldDecision(nowUptimeNs: nowUptimeNs, config: config) {
            return staleHold
        }
        let forceKeyframe = pendingKeyframeRequest && canSendKeyframe(nowUptimeNs: nowUptimeNs, config: config)
        let forcedKeyframeReason: OwnedMediaKeyframeReason = .clientRequest
        let allowPeriodic = mode == .normal
        if pendingKeyframeRequest {
            guard forceKeyframe else {
                return OwnedMediaAdmissionDecision(
                    shouldEncode: false,
                    forceKeyframe: false,
                    allowPeriodicKeyframe: false,
                    mode: mode,
                    holdReason: keyframeInFlightFrameId == nil ? "keyframe-cooldown" : "keyframe-inflight",
                    keyframeReason: nil
                )
            }
            return OwnedMediaAdmissionDecision(
                shouldEncode: true,
                forceKeyframe: true,
                allowPeriodicKeyframe: false,
                mode: mode,
                holdReason: nil,
                keyframeReason: forcedKeyframeReason
            )
        }

        switch mode {
        case .normal:
            if unacknowledgedFrameCount >= config.normalMaxUnackedFrames {
                return OwnedMediaAdmissionDecision(
                    shouldEncode: false,
                    forceKeyframe: false,
                    allowPeriodicKeyframe: false,
                    mode: mode,
                    holdReason: "unacked-normal",
                    keyframeReason: nil
                )
            }
            return OwnedMediaAdmissionDecision(
                shouldEncode: true,
                forceKeyframe: forceKeyframe,
                allowPeriodicKeyframe: allowPeriodic,
                mode: mode,
                holdReason: nil,
                keyframeReason: forceKeyframe ? forcedKeyframeReason : nil
            )
        case .behind:
            if unacknowledgedFrameCount >= config.behindMaxUnackedFrames {
                return OwnedMediaAdmissionDecision(
                    shouldEncode: false,
                    forceKeyframe: false,
                    allowPeriodicKeyframe: false,
                    mode: mode,
                    holdReason: "unacked-behind",
                    keyframeReason: nil
                )
            }
            return OwnedMediaAdmissionDecision(
                shouldEncode: true,
                forceKeyframe: forceKeyframe,
                allowPeriodicKeyframe: allowPeriodic,
                mode: mode,
                holdReason: nil,
                keyframeReason: forceKeyframe ? forcedKeyframeReason : nil
            )
        case .draining:
            guard drainTimedOut(nowUptimeNs: nowUptimeNs, config: config) else {
                return OwnedMediaAdmissionDecision(
                    shouldEncode: false,
                    forceKeyframe: false,
                    allowPeriodicKeyframe: false,
                    mode: mode,
                    holdReason: "draining",
                    keyframeReason: nil
                )
            }
            return OwnedMediaAdmissionDecision(
                shouldEncode: true,
                forceKeyframe: false,
                allowPeriodicKeyframe: false,
                mode: mode,
                holdReason: nil,
                keyframeReason: nil
            )
        }
    }

    func encodeIntervalMs(config: OwnedMediaBackpressureConfig) -> Int {
        switch mode {
        case .normal:
            return config.normalEncodeIntervalMs
        case .behind:
            return max(config.behindEncodeIntervalMs, config.normalEncodeIntervalMs)
        case .draining:
            return max(config.severeEncodeIntervalMs, config.behindEncodeIntervalMs)
        }
    }

    private mutating func refreshMode(config: OwnedMediaBackpressureConfig, nowUptimeNs: UInt64) {
        let previousMode = mode
        if shouldDrain(config: config) {
            mode = .draining
            if previousMode != .draining {
                drainEnteredAtUptimeNs = nowUptimeNs
            }
            return
        }
        if mode == .draining {
            drainEnteredAtUptimeNs = nil
        }
        if latestAckedFrameId > 0 &&
            (latestClientFrameAgeMs > config.frameAgeMs || latestClientBacklogFrames > 0) {
            mode = .behind
        } else {
            mode = .normal
        }
    }

    private func shouldDrain(config: OwnedMediaBackpressureConfig) -> Bool {
        (latestAckedFrameId > 0 && latestClientFrameAgeMs >= config.severeFrameAgeMs) ||
            unacknowledgedFrameCount > max(config.normalMaxUnackedFrames, config.maxInflightFrames) ||
            unacknowledgedBytes > config.maxInflightBytes
    }

    private mutating func staleUnackedAdmissionHoldDecision(
        nowUptimeNs: UInt64,
        config: OwnedMediaBackpressureConfig
    ) -> OwnedMediaAdmissionDecision? {
        guard mode == .behind || mode == .draining,
              !unacknowledgedFrames.isEmpty
        else {
            return nil
        }
        let staleNs = UInt64(config.staleUnackedMs) * 1_000_000
        let staleFrames = unacknowledgedFrames
            .filter { _, sent in
                nowUptimeNs >= sent.capturedAtUptimeNs &&
                    nowUptimeNs - sent.capturedAtUptimeNs >= staleNs
            }
            .sorted { $0.key < $1.key }
        guard !staleFrames.isEmpty else {
            return nil
        }

        let staleIds = Set(staleFrames.map(\.key))
        let abandonedBytes = staleFrames.reduce(0) { $0 + $1.value.bytes }
        let oldestFrameId = staleFrames.first?.key
        let abandonedInflightKeyframe = keyframeInFlightFrameId.map { staleIds.contains($0) } ?? false
        unacknowledgedFrames = unacknowledgedFrames.filter { !staleIds.contains($0.key) }
        if abandonedInflightKeyframe {
            keyframeInFlightFrameId = nil
        }
        refreshMode(config: config, nowUptimeNs: nowUptimeNs)

        return OwnedMediaAdmissionDecision(
            shouldEncode: false,
            forceKeyframe: false,
            allowPeriodicKeyframe: false,
            mode: mode,
            holdReason: "stale-unacked",
            keyframeReason: nil,
            abandonedStaleUnackedCount: staleFrames.count,
            abandonedStaleUnackedBytes: abandonedBytes,
            abandonedStaleUnackedOldestFrameId: oldestFrameId
        )
    }

    private func drainTimedOut(nowUptimeNs: UInt64, config: OwnedMediaBackpressureConfig) -> Bool {
        guard let drainEnteredAtUptimeNs else { return false }
        let timeoutNs = UInt64(config.drainTimeoutMs) * 1_000_000
        return nowUptimeNs >= drainEnteredAtUptimeNs &&
            nowUptimeNs - drainEnteredAtUptimeNs >= timeoutNs
    }

    private func canSendKeyframe(nowUptimeNs: UInt64, config: OwnedMediaBackpressureConfig) -> Bool {
        guard keyframeInFlightFrameId == nil else { return false }
        guard let lastKeyframeSentAtUptimeNs else { return true }
        let cooldownNs = UInt64(config.keyframeCooldownMs) * 1_000_000
        return nowUptimeNs >= lastKeyframeSentAtUptimeNs &&
            nowUptimeNs - lastKeyframeSentAtUptimeNs >= cooldownNs
    }
}

struct OwnedMediaCadenceScheduler: Equatable {
    private(set) var lastAdmissionStartedAtUptimeNs: UInt64?

    mutating func noteAdmissionStarted(atUptimeNs nowUptimeNs: UInt64) {
        lastAdmissionStartedAtUptimeNs = nowUptimeNs
    }

    func delayBeforeNextAdmission(nowUptimeNs: UInt64, intervalMs: Int) -> UInt64 {
        guard let lastAdmissionStartedAtUptimeNs else { return 0 }
        let intervalNs = UInt64(max(intervalMs, 1)) * 1_000_000
        let nextAdmissionNs = lastAdmissionStartedAtUptimeNs &+ intervalNs
        guard nextAdmissionNs > nowUptimeNs else { return 0 }
        return nextAdmissionNs - nowUptimeNs
    }
}

struct OwnedMediaDatagramPacing: Equatable, Sendable {
    let burstPacketCount: Int
    let burstPauseUs: Int

    static func choose(
        isBackpressured: Bool,
        normal: OwnedMediaDatagramPacing,
        backpressure: OwnedMediaDatagramPacing
    ) -> OwnedMediaDatagramPacing {
        isBackpressured ? backpressure : normal
    }
}

enum OwnedMediaDatagramPacingReason: String, Equatable, Sendable {
    case normal
    case largeFrame = "large-frame"
    case jumboFrame = "jumbo-frame"
    case backpressure
}

struct OwnedMediaDatagramPacingChoice: Equatable, Sendable {
    let pacing: OwnedMediaDatagramPacing
    let reason: OwnedMediaDatagramPacingReason
}

struct OwnedMediaDatagramPacingPolicy: Equatable, Sendable {
    let largeFramePacketThreshold: Int
    let jumboFramePacketThreshold: Int
    let largeFramePacing: OwnedMediaDatagramPacing
    let jumboFramePacing: OwnedMediaDatagramPacing

    func choose(
        packetCount: Int,
        isKeyframe: Bool,
        isBackpressured: Bool,
        normal: OwnedMediaDatagramPacing,
        backpressure: OwnedMediaDatagramPacing
    ) -> OwnedMediaDatagramPacingChoice {
        if isBackpressured {
            return OwnedMediaDatagramPacingChoice(pacing: backpressure, reason: .backpressure)
        }
        if !isKeyframe && packetCount >= max(jumboFramePacketThreshold, largeFramePacketThreshold) {
            return OwnedMediaDatagramPacingChoice(pacing: jumboFramePacing, reason: .jumboFrame)
        }
        if !isKeyframe && packetCount >= largeFramePacketThreshold {
            return OwnedMediaDatagramPacingChoice(pacing: largeFramePacing, reason: .largeFrame)
        }
        return OwnedMediaDatagramPacingChoice(pacing: normal, reason: .normal)
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

// R11 DesktopState. Pushed host -> client over the same input WSS,
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
// the existing input WSS, on the SpaceThumbnailProvider's own cadence
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

// Host -> client cursor-image mirror. Pushed on the input WSS whenever
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
