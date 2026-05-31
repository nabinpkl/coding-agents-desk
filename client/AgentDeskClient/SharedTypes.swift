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

struct SessionReady: Codable, Equatable {
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
        self.type = "session-ready"
        self.sessionId = sessionId
        self.inputCapability = inputCapability
        self.inputCapabilityExpiresAt = inputCapabilityExpiresAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        sessionId = try container.decode(String.self, forKey: .sessionId)
        inputCapability = try container.decode(String.self, forKey: .inputCapability)
        inputCapabilityExpiresAt = try container.decode(Int.self, forKey: .inputCapabilityExpiresAt)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)
        try container.encode(sessionId, forKey: .sessionId)
        try container.encode(inputCapability, forKey: .inputCapability)
        try container.encode(inputCapabilityExpiresAt, forKey: .inputCapabilityExpiresAt)
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

    enum CodingKeys: String, CodingKey {
        case displays = "d"
        case spaces = "s"
        case activeDisplayId = "ad"
        case activeSpaceId = "as"
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
