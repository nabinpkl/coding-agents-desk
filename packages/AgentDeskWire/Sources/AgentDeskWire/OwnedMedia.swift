// OwnedMedia wire types (ADR-0050). Single source of truth for host and client.

import CryptoKit
import Foundation

public struct OwnedSurfaceUpdateId: Codable, Equatable, Hashable, Comparable, Sendable {
    public let surfaceGeneration: UInt32
    public let frameId: UInt64

    public enum CodingKeys: String, CodingKey, Sendable {
        case surfaceGeneration = "sg"
        case frameId = "id"
    }

    public static func < (lhs: OwnedSurfaceUpdateId, rhs: OwnedSurfaceUpdateId) -> Bool {
        if lhs.surfaceGeneration != rhs.surfaceGeneration {
            return lhs.surfaceGeneration < rhs.surfaceGeneration
        }
        return lhs.frameId < rhs.frameId
    }

    public func isStrictlyNewer(than committed: OwnedSurfaceUpdateId) -> Bool {
        self > committed
    }

    public static func canAcceptReset(surfaceGeneration: UInt32, committedSurfaceGeneration: UInt32) -> Bool {
        surfaceGeneration > committedSurfaceGeneration
    }

    public static func acceptedResetBaseline(
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

    public init(surfaceGeneration: UInt32, frameId: UInt64) {
        self.surfaceGeneration = surfaceGeneration
        self.frameId = frameId
    }
}
public enum OwnedMediaCodec: String, Codable, Equatable, Sendable {
    case hevc
    case h264
}
public enum OwnedMediaPayloadFormat: String, Codable, Equatable, Sendable {
    case lengthPrefixedNal = "length-prefixed-nal"
}
public enum OwnedMediaRefreshReason: String, Codable, Equatable, Sendable {
    case initial
    case rest
    case scrollCorrectness = "scroll-correctness"
    case reset
}
public struct OwnedMediaParameterSets: Codable, Equatable, Sendable {
    public let vps: Data?
    public let sps: Data
    public let pps: Data

    public init(vps: Data? = nil, sps: Data, pps: Data) {
        self.vps = vps
        self.sps = sps
        self.pps = pps
    }
}
public struct OwnedMediaFrameHeader: Codable, Equatable, Sendable {
    public let surfaceGeneration: UInt32
    public let frameId: UInt64
    public let codec: OwnedMediaCodec
    public let width: Int
    public let height: Int
    public let capturedAtUptimeNs: UInt64
    public let presentationTimeNs: UInt64
    public let isKeyframe: Bool
    public let parameterSets: OwnedMediaParameterSets?
    public let payloadFormat: OwnedMediaPayloadFormat
    public let refreshReason: OwnedMediaRefreshReason
    /// ADR-0090: present when this frame is a long-term reference the encoder can later encode
    /// against, instead of sending a full keyframe to resync.
    ///
    /// The client echoes it back once the frame is actually decoded, not merely received --
    /// the encoder may only reference frames the client provably holds, and a frame that
    /// arrived but failed to decode is not one of them.
    public let ltrToken: UInt64?

    public var updateId: OwnedSurfaceUpdateId {
        OwnedSurfaceUpdateId(surfaceGeneration: surfaceGeneration, frameId: frameId)
    }

    public enum CodingKeys: String, CodingKey, Sendable {
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
        // Not "lt": the control message already uses that for linkTelemetry, and the two wire
        // types have drifted before when abbreviations were reused across them.
        case ltrToken = "lr"
    }

    public init(
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
        refreshReason: OwnedMediaRefreshReason,
        ltrToken: UInt64? = nil
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
        self.ltrToken = ltrToken
    }
}
public struct OwnedMediaFrameEnvelope: Equatable, Sendable {
    public static let magic = [UInt8]("ADMF".utf8)
    public static let version: UInt8 = 1
    public static let fixedHeaderByteCount = 9

    public let header: OwnedMediaFrameHeader
    public let payload: Data

    public init(header: OwnedMediaFrameHeader, payload: Data) {
        self.header = header
        self.payload = payload
    }

    public func encode() throws -> Data {
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

    public static func decode(_ data: Data) throws -> OwnedMediaFrameEnvelope {
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
public enum OwnedMediaControlKind: String, Codable, Equatable, Sendable {
    case keyframeRequest = "keyframe-request"
    case packetResendRequest = "packet-resend-request"
    case frameAck = "frame-ack"
    case graphicsResetRequest = "graphics-reset-request"
    case keepalive = "keepalive"
    // ADR-0027: client->host link-health report carrying the window's completed and
    // expired (lost) frame counts, which drive the host adaptive bitrate controller.
    case linkHealth = "link-health"
}
public struct OwnedMediaControlMessage: Codable, Equatable, Sendable {
    public let type: String
    public let kind: OwnedMediaControlKind
    public let frameId: UInt64
    public let packetIndexes: [UInt16]
    public let totalFramesDecoded: UInt64?
    public let renderGapMs: Double?
    public let frameAgeMs: Double?
    public let clientBacklogFrames: Int?
    public let clientBacklogBytes: Int?
    public let graphicsSurfaceGeneration: UInt32?
    public let reason: String?
    // ADR-0027 link-health: frames completed and frames expired (lost past repair)
    // in the report window. Present only on a .linkHealth message.
    public let linkHealthCompletedFrames: Int?
    public let linkHealthExpiredFrames: Int?
    // ADR-0088: the client's view of the link (path, radio, receive-loop liveness) for the
    // same window the frame counts describe. Present only on a .linkHealth message.
    public let linkTelemetry: OwnedMediaLinkTelemetry?
    /// ADR-0090: long-term reference tokens the client has decoded and can still be encoded
    /// against. Rides the frame ack because that is already the "I have this frame" signal.
    public let acknowledgedLtrTokens: [UInt64]?

    public enum CodingKeys: String, CodingKey, Sendable {
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
        case linkTelemetry = "lt"
        case acknowledgedLtrTokens = "la"
    }

    public init(
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
        linkHealthExpiredFrames: Int? = nil,
        linkTelemetry: OwnedMediaLinkTelemetry? = nil,
        acknowledgedLtrTokens: [UInt64]? = nil
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
        self.linkTelemetry = linkTelemetry
        self.acknowledgedLtrTokens = acknowledgedLtrTokens
    }

    public init(from decoder: Decoder) throws {
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
        linkTelemetry = try container.decodeIfPresent(OwnedMediaLinkTelemetry.self, forKey: .linkTelemetry)
        acknowledgedLtrTokens = try container.decodeIfPresent([UInt64].self, forKey: .acknowledgedLtrTokens)
    }

    public func encode(to encoder: Encoder) throws {
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
        try container.encodeIfPresent(linkTelemetry, forKey: .linkTelemetry)
        try container.encodeIfPresent(acknowledgedLtrTokens, forKey: .acknowledgedLtrTokens)
    }
}
public enum MediaTimingMath: Sendable {
    public static func millisecondsBetween(currentNs: UInt64, previousNs: UInt64?) -> Double? {
        guard let previousNs, currentNs >= previousNs else { return nil }
        return Double(currentNs - previousNs) / 1_000_000.0
    }

    public static func millisecondsPerUnit(
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

    public static func formatMilliseconds(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "?" }
        return String(format: "%.2f", value)
    }
}
