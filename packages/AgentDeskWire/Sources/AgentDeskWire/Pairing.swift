// Pairing wire types (ADR-0050). Moved verbatim from the former per-app
// SharedTypes.swift; single source of truth for host and client.

import Foundation

// ADR-0002 fixes the P-256 pairing wire shapes mirrored by host and client.
public struct PairingPayload: Codable, Equatable, Sendable {
    public let hostFingerprint: String
    public let hostPublicKey: Data
    public let tailnetFQDN: String
    public let tailnetIPv4: String
    public let oneTimeNonce: Data
    public let expiresAt: Int
    // The host's bound signaling port (tier-dependent: stable and dev hosts bind
    // different ports so they can run concurrently). The client dials this exact
    // port instead of assuming a default, so neither side hardcodes the other's port.
    public let signalingPort: UInt16

    public enum CodingKeys: String, CodingKey {
        case hostFingerprint = "h"
        case hostPublicKey = "k"
        case tailnetFQDN = "d"
        case tailnetIPv4 = "i"
        case oneTimeNonce = "n"
        case expiresAt = "e"
        case signalingPort = "sp"
    }

    public init(
        hostFingerprint: String,
        hostPublicKey: Data,
        tailnetFQDN: String,
        tailnetIPv4: String,
        oneTimeNonce: Data,
        expiresAt: Int,
        signalingPort: UInt16
    ) {
        self.hostFingerprint = hostFingerprint
        self.hostPublicKey = hostPublicKey
        self.tailnetFQDN = tailnetFQDN
        self.tailnetIPv4 = tailnetIPv4
        self.oneTimeNonce = oneTimeNonce
        self.expiresAt = expiresAt
        self.signalingPort = signalingPort
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        hostFingerprint = try container.decode(String.self, forKey: .hostFingerprint)
        hostPublicKey = try Data(base64URLEncoded: container.decode(String.self, forKey: .hostPublicKey))
        tailnetFQDN = try container.decode(String.self, forKey: .tailnetFQDN)
        tailnetIPv4 = try container.decode(String.self, forKey: .tailnetIPv4)
        oneTimeNonce = try Data(base64URLEncoded: container.decode(String.self, forKey: .oneTimeNonce))
        expiresAt = try container.decode(Int.self, forKey: .expiresAt)
        signalingPort = try container.decode(UInt16.self, forKey: .signalingPort)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(hostFingerprint, forKey: .hostFingerprint)
        try container.encode(hostPublicKey.base64URLEncodedString(), forKey: .hostPublicKey)
        try container.encode(tailnetFQDN, forKey: .tailnetFQDN)
        try container.encode(tailnetIPv4, forKey: .tailnetIPv4)
        try container.encode(oneTimeNonce.base64URLEncodedString(), forKey: .oneTimeNonce)
        try container.encode(expiresAt, forKey: .expiresAt)
        try container.encode(signalingPort, forKey: .signalingPort)
    }

    public func compactJSONData() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(self)
    }

    public func pairingURL() throws -> URL {
        let encodedPayload = try compactJSONData().base64URLEncodedString()
        guard let url = URL(string: "agentdesk://pair?p=\(encodedPayload)") else {
            throw PairingPayloadError.invalidURL
        }
        return url
    }

    public static func decode(fromPairingURL url: URL) throws -> PairingPayload {
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
public enum PairingPayloadError: Error, Sendable {
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
public enum OfferPortFrame: Sendable {
    public static let fixedHeaderByteCount = 4
    public static let maxPayloadByteCount = 64 * 1024

    public static func encode(_ body: Data) throws -> Data {
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
public struct OfferPortFrameParser: Sendable {
    private var buffer = Data()

    public init() {}

    public mutating func append(_ chunk: Data) throws -> [Data] {
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
public struct DeviceIdentityRequest: Codable, Equatable, Sendable {
    public let type: String

    public enum CodingKeys: String, CodingKey {
        case type = "t"
    }

    public init() {
        self.type = "whois"
    }
}
public struct DeviceIdentity: Codable, Equatable, Sendable {
    public let type: String
    public let displayName: String

    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case displayName = "n"
    }

    public init(displayName: String) {
        self.type = "id"
        self.displayName = displayName
    }
}
public struct DiagnosticsRequest: Codable, Equatable, Sendable {
    public let type: String
    public let requestId: String
    public let sinceRunId: String?
    public let includePreviousRuns: Bool
    public let maxBytes: Int?

    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case requestId = "rid"
        case sinceRunId = "sr"
        case includePreviousRuns = "pr"
        case maxBytes = "mb"
    }

    public init(
        requestId: String,
        sinceRunId: String? = nil,
        includePreviousRuns: Bool = true,
        maxBytes: Int? = nil
    ) {
        self.type = "diagnostics-request"
        self.requestId = requestId
        self.sinceRunId = sinceRunId
        self.includePreviousRuns = includePreviousRuns
        self.maxBytes = maxBytes
    }
}
public struct DiagnosticsRunSummary: Codable, Equatable, Sendable {
    public let runId: String
    public let startedAt: Int
    public let endedAt: Int?
    public let cleanShutdown: Bool
    public let byteCount: Int
    public let eventCount: Int

    public enum CodingKeys: String, CodingKey {
        case runId = "rid"
        case startedAt = "sa"
        case endedAt = "ea"
        case cleanShutdown = "cs"
        case byteCount = "bc"
        case eventCount = "ec"
    }

    public init(runId: String, startedAt: Int, endedAt: Int? = nil, cleanShutdown: Bool, byteCount: Int, eventCount: Int) {
        self.runId = runId
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.cleanShutdown = cleanShutdown
        self.byteCount = byteCount
        self.eventCount = eventCount
    }
}
public struct DiagnosticsSummary: Codable, Equatable, Sendable {
    public let type: String
    public let requestId: String
    public let runs: [DiagnosticsRunSummary]
    public let droppedEvents: Int
    public let droppedBytes: Int
    public let latestMetricKitPayloadAt: Int?

    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case requestId = "rid"
        case runs = "r"
        case droppedEvents = "de"
        case droppedBytes = "db"
        case latestMetricKitPayloadAt = "mk"
    }

    public init(
        requestId: String,
        runs: [DiagnosticsRunSummary],
        droppedEvents: Int,
        droppedBytes: Int,
        latestMetricKitPayloadAt: Int?
    ) {
        self.type = "diagnostics-summary"
        self.requestId = requestId
        self.runs = runs
        self.droppedEvents = droppedEvents
        self.droppedBytes = droppedBytes
        self.latestMetricKitPayloadAt = latestMetricKitPayloadAt
    }
}
public struct DiagnosticsChunk: Codable, Equatable, Sendable {
    public let type: String
    public let requestId: String
    public let sequence: Int
    public let isFinal: Bool
    public let runId: String
    public let uncompressedBytes: Int
    public let payloadBase64: String

    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case requestId = "rid"
        case sequence = "s"
        case isFinal = "f"
        case runId = "run"
        case uncompressedBytes = "ub"
        case payloadBase64 = "p"
    }

    public init(
        requestId: String,
        sequence: Int,
        isFinal: Bool,
        runId: String,
        uncompressedBytes: Int,
        payloadBase64: String
    ) {
        self.type = "diagnostics-chunk"
        self.requestId = requestId
        self.sequence = sequence
        self.isFinal = isFinal
        self.runId = runId
        self.uncompressedBytes = uncompressedBytes
        self.payloadBase64 = payloadBase64
    }
}
public struct DiagnosticsError: Codable, Equatable, Error, Sendable {
    public let type: String
    public let requestId: String
    public let reason: String

    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case requestId = "rid"
        case reason = "r"
    }

    public init(requestId: String, reason: String) {
        self.type = "diagnostics-error"
        self.requestId = requestId
        self.reason = reason
    }
}

public enum ClientRuntimeScenePhase: String, Codable, Equatable, Sendable {
    case foreground
    case background
}

public enum ClientRuntimePairingState: String, Codable, Equatable, Sendable {
    case unpaired
    case pairedDisconnected = "paired-disconnected"
    case connecting
    case connected
    case failed
}

public enum ClientRuntimeSurface: String, Codable, Equatable, Sendable {
    case control
    case agent
    case terminal
    case browser
    case workspace
    case voice
}

public enum ClientRuntimeMediaState: String, Codable, Equatable, Sendable {
    case idle
    case scheduled
    case started
    case stopped
    case failed
}

public enum ClientRuntimeVideoMilestone: String, Codable, Equatable, Sendable {
    case none
    case frameCompleted = "frame-completed"
    case decoderEnqueued = "decoder-enqueued"
    case presentationAttempted = "presentation-attempted"
}

/// Bounded, content-free client state sent over the authenticated input lane.
/// This reports presentation checkpoints the host cannot infer from media ACKs.
public struct ClientRuntimeCheckpoint: Codable, Equatable, Sendable {
    public static let currentSchemaVersion = 1

    public let type: String
    public let schemaVersion: Int
    public let clientRunId: String
    public let sequence: UInt64
    public let timestamp: Int
    public let marketingVersion: String
    public let buildNumber: String
    public let gitSHA: String
    public let scenePhase: ClientRuntimeScenePhase
    public let pairingState: ClientRuntimePairingState
    public let activeSurface: ClientRuntimeSurface
    public let railConfigured: Bool
    public let railHidden: Bool
    public let railLayoutReady: Bool
    public let hostSurfaceCount: Int
    public let mediaState: ClientRuntimeMediaState
    public let videoMilestone: ClientRuntimeVideoMilestone

    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case schemaVersion = "v"
        case clientRunId = "rid"
        case sequence = "s"
        case timestamp = "ts"
        case marketingVersion = "mv"
        case buildNumber = "bn"
        case gitSHA = "sha"
        case scenePhase = "sp"
        case pairingState = "ps"
        case activeSurface = "as"
        case railConfigured = "rc"
        case railHidden = "rh"
        case railLayoutReady = "rl"
        case hostSurfaceCount = "hc"
        case mediaState = "ms"
        case videoMilestone = "vm"
    }

    public init(
        clientRunId: String,
        sequence: UInt64,
        timestamp: Int,
        marketingVersion: String,
        buildNumber: String,
        gitSHA: String,
        scenePhase: ClientRuntimeScenePhase,
        pairingState: ClientRuntimePairingState,
        activeSurface: ClientRuntimeSurface,
        railConfigured: Bool,
        railHidden: Bool,
        railLayoutReady: Bool,
        hostSurfaceCount: Int,
        mediaState: ClientRuntimeMediaState,
        videoMilestone: ClientRuntimeVideoMilestone
    ) {
        self.type = "client-runtime-checkpoint"
        self.schemaVersion = Self.currentSchemaVersion
        self.clientRunId = clientRunId
        self.sequence = sequence
        self.timestamp = timestamp
        self.marketingVersion = marketingVersion
        self.buildNumber = buildNumber
        self.gitSHA = gitSHA
        self.scenePhase = scenePhase
        self.pairingState = pairingState
        self.activeSurface = activeSurface
        self.railConfigured = railConfigured
        self.railHidden = railHidden
        self.railLayoutReady = railLayoutReady
        self.hostSurfaceCount = hostSurfaceCount
        self.mediaState = mediaState
        self.videoMilestone = videoMilestone
    }
}

public struct SignedDiagnosticsRequest: Codable, Equatable, Sendable {
    public let type: String
    public let requestId: String
    public let sinceRunId: String?
    public let includePreviousRuns: Bool
    public let maxBytes: Int?
    public let hostFingerprint: String
    public let issuedAt: Int
    public let nonce: Data
    public let hostSignature: Data

    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case requestId = "rid"
        case sinceRunId = "sr"
        case includePreviousRuns = "pr"
        case maxBytes = "mb"
        case hostFingerprint = "hf"
        case issuedAt = "ts"
        case nonce = "n"
        case hostSignature = "hs"
    }

    public init(
        requestId: String,
        sinceRunId: String? = nil,
        includePreviousRuns: Bool = true,
        maxBytes: Int? = nil,
        hostFingerprint: String,
        issuedAt: Int,
        nonce: Data,
        hostSignature: Data
    ) {
        self.type = "diagnostics-request"
        self.requestId = requestId
        self.sinceRunId = sinceRunId
        self.includePreviousRuns = includePreviousRuns
        self.maxBytes = maxBytes
        self.hostFingerprint = hostFingerprint
        self.issuedAt = issuedAt
        self.nonce = nonce
        self.hostSignature = hostSignature
    }

    public var request: DiagnosticsRequest {
        DiagnosticsRequest(
            requestId: requestId,
            sinceRunId: sinceRunId,
            includePreviousRuns: includePreviousRuns,
            maxBytes: maxBytes
        )
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        requestId = try container.decode(String.self, forKey: .requestId)
        sinceRunId = try container.decodeIfPresent(String.self, forKey: .sinceRunId)
        includePreviousRuns = try container.decodeIfPresent(Bool.self, forKey: .includePreviousRuns) ?? true
        maxBytes = try container.decodeIfPresent(Int.self, forKey: .maxBytes)
        hostFingerprint = try container.decode(String.self, forKey: .hostFingerprint)
        issuedAt = try container.decode(Int.self, forKey: .issuedAt)
        nonce = try Data(base64URLEncoded: container.decode(String.self, forKey: .nonce))
        hostSignature = try Data(base64URLEncoded: container.decode(String.self, forKey: .hostSignature))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)
        try container.encode(requestId, forKey: .requestId)
        try container.encodeIfPresent(sinceRunId, forKey: .sinceRunId)
        try container.encode(includePreviousRuns, forKey: .includePreviousRuns)
        try container.encodeIfPresent(maxBytes, forKey: .maxBytes)
        try container.encode(hostFingerprint, forKey: .hostFingerprint)
        try container.encode(issuedAt, forKey: .issuedAt)
        try container.encode(nonce.base64URLEncodedString(), forKey: .nonce)
        try container.encode(hostSignature.base64URLEncodedString(), forKey: .hostSignature)
    }
}
public enum DiagnosticsRequestSignature: Sendable {
    private struct SigningEnvelope: Encodable {
        let request: DiagnosticsRequest
        let hostFingerprint: String
        let issuedAt: Int
        let nonce: String
    }

    public static func signingData(
        request: DiagnosticsRequest,
        hostFingerprint: String,
        issuedAt: Int,
        nonce: Data
    ) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(SigningEnvelope(
            request: request,
            hostFingerprint: hostFingerprint,
            issuedAt: issuedAt,
            nonce: nonce.base64URLEncodedString()
        ))
    }
}
// Routes a decoded offer-port body. A pairing offer (PairingPayload) carries no
// "t" tag; whois and identity replies do.
public enum OfferPortMessage: Sendable {
    case offer(PairingPayload)
    case whois
    case identity(DeviceIdentity)
    case diagnosticsRequest(SignedDiagnosticsRequest)
    case diagnosticsSummary(DiagnosticsSummary)
    case diagnosticsChunk(DiagnosticsChunk)
    case diagnosticsError(DiagnosticsError)
    case screenshotRequest(SignedClientScreenshotRequest)
    case screenshotManifest(ClientScreenshotManifest)
    case screenshotChunk(ClientScreenshotChunk)
    case screenshotError(ClientScreenshotError)
    case unknown

    private struct TypeTag: Decodable {
        let t: String?
    }

    public static func classify(_ body: Data) -> OfferPortMessage {
        let tag = (try? JSONDecoder().decode(TypeTag.self, from: body))?.t
        switch tag {
        case "whois":
            return .whois
        case "id":
            if let identity = try? JSONDecoder().decode(DeviceIdentity.self, from: body) {
                return .identity(identity)
            }
            return .unknown
        case "diagnostics-request":
            if let request = try? JSONDecoder().decode(SignedDiagnosticsRequest.self, from: body) {
                return .diagnosticsRequest(request)
            }
            return .unknown
        case "diagnostics-summary":
            if let summary = try? JSONDecoder().decode(DiagnosticsSummary.self, from: body) {
                return .diagnosticsSummary(summary)
            }
            return .unknown
        case "diagnostics-chunk":
            if let chunk = try? JSONDecoder().decode(DiagnosticsChunk.self, from: body) {
                return .diagnosticsChunk(chunk)
            }
            return .unknown
        case "diagnostics-error":
            if let error = try? JSONDecoder().decode(DiagnosticsError.self, from: body) {
                return .diagnosticsError(error)
            }
            return .unknown
        case "client-screenshot-request":
            if let request = try? JSONDecoder().decode(SignedClientScreenshotRequest.self, from: body) {
                return .screenshotRequest(request)
            }
            return .unknown
        case "client-screenshot-manifest":
            if let manifest = try? JSONDecoder().decode(ClientScreenshotManifest.self, from: body) {
                return .screenshotManifest(manifest)
            }
            return .unknown
        case "client-screenshot-chunk":
            if let chunk = try? JSONDecoder().decode(ClientScreenshotChunk.self, from: body) {
                return .screenshotChunk(chunk)
            }
            return .unknown
        case "client-screenshot-error":
            if let error = try? JSONDecoder().decode(ClientScreenshotError.self, from: body) {
                return .screenshotError(error)
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
