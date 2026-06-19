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

    enum CodingKeys: String, CodingKey {
        case type = "t"
        case deviceFingerprint = "d"
        case sessionToken = "s"
        case clientNonce = "n"
    }

    init(deviceFingerprint: DeviceFingerprint, sessionToken: SessionToken, clientNonce: Data) {
        self.type = "session-init"
        self.deviceFingerprint = deviceFingerprint
        self.sessionToken = sessionToken
        self.clientNonce = clientNonce
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        deviceFingerprint = try container.decode(DeviceFingerprint.self, forKey: .deviceFingerprint)
        sessionToken = try container.decode(SessionToken.self, forKey: .sessionToken)
        clientNonce = try Data(base64URLEncoded: container.decode(String.self, forKey: .clientNonce))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)
        try container.encode(deviceFingerprint, forKey: .deviceFingerprint)
        try container.encode(sessionToken, forKey: .sessionToken)
        try container.encode(clientNonce.base64URLEncodedString(), forKey: .clientNonce)
    }
}

struct SessionChallenge: Codable, Equatable {
    let type: String
    let hostNonce: Data
    let hostSignature: Data

    enum CodingKeys: String, CodingKey {
        case type = "t"
        case hostNonce = "n"
        case hostSignature = "s"
    }

    init(hostNonce: Data, hostSignature: Data) {
        self.type = "session-challenge"
        self.hostNonce = hostNonce
        self.hostSignature = hostSignature
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        hostNonce = try Data(base64URLEncoded: container.decode(String.self, forKey: .hostNonce))
        hostSignature = try Data(base64URLEncoded: container.decode(String.self, forKey: .hostSignature))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)
        try container.encode(hostNonce.base64URLEncodedString(), forKey: .hostNonce)
        try container.encode(hostSignature.base64URLEncodedString(), forKey: .hostSignature)
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

enum MediaMode: String, Codable, Equatable {
    case webrtc
    case owned
}

struct SessionReady: Codable, Equatable {
    let type: String
    let sessionId: String
    let inputCapability: String
    let inputCapabilityExpiresAt: Int
    let mediaMode: MediaMode
    let mediaCapability: String
    let mediaCapabilityExpiresAt: Int
    let mediaPlanes: [MediaPlane]

    enum CodingKeys: String, CodingKey {
        case type = "t"
        case sessionId = "sid"
        case inputCapability = "ic"
        case inputCapabilityExpiresAt = "ie"
        case mediaMode = "mm"
        case mediaCapability = "mc"
        case mediaCapabilityExpiresAt = "me"
        case mediaPlanes = "mp"
    }

    init(
        sessionId: String,
        inputCapability: String,
        inputCapabilityExpiresAt: Int,
        mediaMode: MediaMode = .webrtc,
        mediaCapability: String = "",
        mediaCapabilityExpiresAt: Int = 0,
        mediaPlanes: [MediaPlane] = MediaPlane.allCases
    ) {
        self.type = "session-ready"
        self.sessionId = sessionId
        self.inputCapability = inputCapability
        self.inputCapabilityExpiresAt = inputCapabilityExpiresAt
        self.mediaMode = mediaMode
        self.mediaCapability = mediaCapability
        self.mediaCapabilityExpiresAt = mediaCapabilityExpiresAt
        self.mediaPlanes = mediaPlanes
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        sessionId = try container.decode(String.self, forKey: .sessionId)
        inputCapability = try container.decode(String.self, forKey: .inputCapability)
        inputCapabilityExpiresAt = try container.decode(Int.self, forKey: .inputCapabilityExpiresAt)
        mediaMode = try container.decodeIfPresent(MediaMode.self, forKey: .mediaMode) ?? .webrtc
        mediaCapability = try container.decodeIfPresent(String.self, forKey: .mediaCapability) ?? ""
        mediaCapabilityExpiresAt = try container.decodeIfPresent(Int.self, forKey: .mediaCapabilityExpiresAt) ?? 0
        mediaPlanes = try container.decodeIfPresent([MediaPlane].self, forKey: .mediaPlanes) ?? MediaPlane.allCases
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)
        try container.encode(sessionId, forKey: .sessionId)
        try container.encode(inputCapability, forKey: .inputCapability)
        try container.encode(inputCapabilityExpiresAt, forKey: .inputCapabilityExpiresAt)
        try container.encode(mediaMode, forKey: .mediaMode)
        try container.encode(mediaCapability, forKey: .mediaCapability)
        try container.encode(mediaCapabilityExpiresAt, forKey: .mediaCapabilityExpiresAt)
        try container.encode(mediaPlanes, forKey: .mediaPlanes)
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

enum OwnedMediaCodec: String, Codable, Equatable {
    case hevc
    case h264
}

enum OwnedMediaPayloadFormat: String, Codable, Equatable {
    case lengthPrefixedNal = "length-prefixed-nal"
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
    let frameId: UInt64
    let plane: MediaPlane
    let codec: OwnedMediaCodec
    let width: Int
    let height: Int
    let capturedAtUptimeNs: UInt64
    let presentationTimeNs: UInt64
    let isKeyframe: Bool
    let parameterSets: OwnedMediaParameterSets?
    let payloadFormat: OwnedMediaPayloadFormat

    enum CodingKeys: String, CodingKey {
        case frameId = "id"
        case plane = "pl"
        case codec = "c"
        case width = "w"
        case height = "h"
        case capturedAtUptimeNs = "cu"
        case presentationTimeNs = "pt"
        case isKeyframe = "k"
        case parameterSets = "ps"
        case payloadFormat = "pf"
    }

    init(
        frameId: UInt64,
        plane: MediaPlane,
        codec: OwnedMediaCodec,
        width: Int,
        height: Int,
        capturedAtUptimeNs: UInt64,
        presentationTimeNs: UInt64,
        isKeyframe: Bool,
        parameterSets: OwnedMediaParameterSets?,
        payloadFormat: OwnedMediaPayloadFormat = .lengthPrefixedNal
    ) {
        self.frameId = frameId
        self.plane = plane
        self.codec = codec
        self.width = width
        self.height = height
        self.capturedAtUptimeNs = capturedAtUptimeNs
        self.presentationTimeNs = presentationTimeNs
        self.isKeyframe = isKeyframe
        self.parameterSets = parameterSets
        self.payloadFormat = payloadFormat
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

// ADR-0004 post-SessionReady signaling frames. Mirror of host's definition.

enum WebRTCSignalingFrame: Codable, Equatable {
    case offer(sdp: String)
    case answer(sdp: String)
    case ice(sdp: String, sdpMid: String?, sdpMLineIndex: Int32)

    private enum CodingKeys: String, CodingKey {
        case type = "t"
        case sdp = "s"
        case sdpMid = "m"
        case sdpMLineIndex = "i"
    }

    private enum FrameType: String {
        case offer = "webrtc-offer"
        case answer = "webrtc-answer"
        case ice = "webrtc-ice"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let typeString = try container.decode(String.self, forKey: .type)
        guard let frameType = FrameType(rawValue: typeString) else {
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "unknown webrtc frame type: \(typeString)"
            )
        }
        switch frameType {
        case .offer:
            self = .offer(sdp: try container.decode(String.self, forKey: .sdp))
        case .answer:
            self = .answer(sdp: try container.decode(String.self, forKey: .sdp))
        case .ice:
            self = .ice(
                sdp: try container.decode(String.self, forKey: .sdp),
                sdpMid: try container.decodeIfPresent(String.self, forKey: .sdpMid),
                sdpMLineIndex: try container.decode(Int32.self, forKey: .sdpMLineIndex)
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .offer(let sdp):
            try container.encode(FrameType.offer.rawValue, forKey: .type)
            try container.encode(sdp, forKey: .sdp)
        case .answer(let sdp):
            try container.encode(FrameType.answer.rawValue, forKey: .type)
            try container.encode(sdp, forKey: .sdp)
        case .ice(let sdp, let sdpMid, let sdpMLineIndex):
            try container.encode(FrameType.ice.rawValue, forKey: .type)
            try container.encode(sdp, forKey: .sdp)
            try container.encodeIfPresent(sdpMid, forKey: .sdpMid)
            try container.encode(sdpMLineIndex, forKey: .sdpMLineIndex)
        }
    }

    static let frameTypeValues: Set<String> = [
        FrameType.offer.rawValue,
        FrameType.answer.rawValue,
        FrameType.ice.rawValue
    ]
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

struct NegotiatedVideoCodec: Equatable {
    let payloadType: String
    let name: String
    let fmtp: String?

    var h264ProfileLevelId: String? {
        guard name.uppercased() == "H264", let fmtp else { return nil }
        return fmtp
            .split(separator: ";")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { $0.lowercased().hasPrefix("profile-level-id=") }
            .flatMap { $0.split(separator: "=", maxSplits: 1).last.map(String.init) }
    }

    var logSummary: String {
        if let h264ProfileLevelId {
            return "\(name) pt=\(payloadType) profile-level-id=\(h264ProfileLevelId)"
        }
        if let fmtp, !fmtp.isEmpty {
            return "\(name) pt=\(payloadType) fmtp=\(fmtp)"
        }
        return "\(name) pt=\(payloadType)"
    }
}

enum SdpVideoCodecInspector {
    static func firstNegotiatedVideoCodec(in sdp: String) -> NegotiatedVideoCodec? {
        let lines = sdp
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .split(separator: "\n")
            .map(String.init)
        guard let mediaLine = lines.first(where: { $0.hasPrefix("m=video ") }) else {
            return nil
        }
        let payloadTypes = mediaLine.split(separator: " ").dropFirst(3).map(String.init)
        guard !payloadTypes.isEmpty else { return nil }

        var namesByPayload: [String: String] = [:]
        var fmtpByPayload: [String: String] = [:]
        for line in lines {
            if line.hasPrefix("a=rtpmap:") {
                let rest = String(line.dropFirst("a=rtpmap:".count))
                let parts = rest.split(separator: " ", maxSplits: 1).map(String.init)
                guard parts.count == 2 else { continue }
                let codecName = parts[1].split(separator: "/", maxSplits: 1).first.map(String.init) ?? parts[1]
                namesByPayload[parts[0]] = codecName.uppercased()
            } else if line.hasPrefix("a=fmtp:") {
                let rest = String(line.dropFirst("a=fmtp:".count))
                let parts = rest.split(separator: " ", maxSplits: 1).map(String.init)
                guard parts.count == 2 else { continue }
                fmtpByPayload[parts[0]] = parts[1]
            }
        }

        for payloadType in payloadTypes {
            guard let name = namesByPayload[payloadType] else { continue }
            if name == "RTX" || name == "RED" || name == "ULPFEC" {
                continue
            }
            return NegotiatedVideoCodec(
                payloadType: payloadType,
                name: name,
                fmtp: fmtpByPayload[payloadType]
            )
        }
        return nil
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

// ADR-0005 input-channel wire shapes. Mirror of host's definition.

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

// R11 DesktopState. Mirror of host's definition. Pushed host -> client
// over the input WSS; drives the dots band rendering.

struct DisplayMetadata: Codable, Equatable {
    let id: String
    // ADR-0009: see host SharedTypes.swift.
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
    // ADR-0009: mirror of host field. See host SharedTypes.swift.
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

// ADR-0006. Mirror of the host's thumbnail wire shapes.

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

// Host -> client cursor-image mirror. Mirror of the host definition. The
// client caches the base64 PNG by `hash` and renders it on the local
// cursor overlay at the predicted position; hotspot fractions (top-left
// origin) let it anchor any cursor shape, not just the tip-at-origin
// arrow. `png` may be nil in a later phase once the client holds `hash`.
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

// Client -> host interaction hint. Mirror of the host definition. Sent on
// scroll-strip touch-down (before motion) and on settle so the host can
// drop video quality for smooth scrolling and restore it afterward.
struct InteractionHint: Codable, Equatable {
    let type: String
    let kind: String
    let active: Bool

    enum CodingKeys: String, CodingKey {
        case type = "t"
        case kind = "k"
        case active = "a"
    }

    init(kind: String, active: Bool) {
        self.type = "interaction-hint"
        self.kind = kind
        self.active = active
    }
}
