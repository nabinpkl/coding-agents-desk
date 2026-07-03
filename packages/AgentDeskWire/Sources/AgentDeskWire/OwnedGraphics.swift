// OwnedGraphics wire types (ADR-0050). Single source of truth for host and client.

import Foundation

private struct OwnedGraphicsFrameMetadata: Codable, Equatable {
    let header: OwnedGraphicsFrameHeader
    let commands: [OwnedGraphicsCommand]

    enum CodingKeys: String, CodingKey {
        case header = "h"
        case commands = "c"
    }
}

public struct OwnedGraphicsFrameHeader: Codable, Equatable, Sendable {
    public let surfaceGeneration: UInt32
    public let frameId: UInt64
    public let capturedAtUptimeNs: UInt64
    public let commandCount: Int
    public let payloadLength: Int

    public var updateId: OwnedSurfaceUpdateId {
        OwnedSurfaceUpdateId(surfaceGeneration: surfaceGeneration, frameId: frameId)
    }

    public enum CodingKeys: String, CodingKey, Sendable {
        case surfaceGeneration = "sg"
        case frameId = "id"
        case capturedAtUptimeNs = "cu"
        case commandCount = "cc"
        case payloadLength = "pl"
    }

    public init(surfaceGeneration: UInt32, frameId: UInt64, capturedAtUptimeNs: UInt64, commandCount: Int, payloadLength: Int) {
        self.surfaceGeneration = surfaceGeneration
        self.frameId = frameId
        self.capturedAtUptimeNs = capturedAtUptimeNs
        self.commandCount = commandCount
        self.payloadLength = payloadLength
    }
}
public struct OwnedGraphicsFrameEnvelope: Equatable, Sendable {
    public static let magic = [UInt8]("ADGC".utf8)
    public static let version: UInt8 = 1
    public static let fixedHeaderByteCount = 13

    public let header: OwnedGraphicsFrameHeader
    public let commands: [OwnedGraphicsCommand]
    public let payload: Data

    public init(
        header: OwnedGraphicsFrameHeader,
        commands: [OwnedGraphicsCommand],
        payload: Data
    ) {
        self.header = header
        self.commands = commands
        self.payload = payload
    }

    public func encode() throws -> Data {
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

    public var wireByteCount: Int {
        let metadata = OwnedGraphicsFrameMetadata(header: header, commands: commands)
        let metadataByteCount = (try? JSONEncoder().encode(metadata).count) ?? 0
        return Self.fixedHeaderByteCount + metadataByteCount + payload.count
    }

    public static func decode(_ data: Data) throws -> OwnedGraphicsFrameEnvelope {
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
public struct OwnedGraphicsStreamFrameParser: Sendable {
    public static let maxFrameByteCount = 8 * 1024 * 1024
    private var buffer = Data()

    public init() {}

    public mutating func append(_ chunk: Data) throws -> [OwnedGraphicsFrameEnvelope] {
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
public enum OwnedGraphicsControlStreamFrame: Sendable {
    public static let fixedHeaderByteCount = 4
    public static let maxPayloadByteCount = 64 * 1024

    public static func encode<T: Encodable>(_ message: T) throws -> Data {
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
public struct OwnedGraphicsControlStreamFrameParser: Sendable {
    private var buffer = Data()

    public init() {}

    public mutating func append(_ chunk: Data) throws -> [Data] {
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
public enum OwnedGraphicsPixelFormat: String, Codable, Equatable, Sendable {
    case bgra
}
public enum OwnedGraphicsTileCompression: String, Codable, Equatable, Sendable {
    case lzfse
    // Lossy JPEG for the fullframe fallback. A whole-screen change (video, a
    // page load, or a fast scroll) is multi-MB as raw LZFSE and saturated the
    // single reliable graphics channel, freezing the
    // screen. JPEG cuts it ~10x. Small text changes stay .lzfse (lossless); the
    // lossy path is reserved for large motion the way RDP mixes codecs by region.
    case jpeg
}
public struct OwnedGraphicsByteRange: Codable, Equatable, Sendable {
    public let offset: Int
    public let length: Int

    public enum CodingKeys: String, CodingKey, Sendable {
        case offset = "o"
        case length = "l"
    }

    public init(offset: Int, length: Int) {
        self.offset = offset
        self.length = length
    }
}
// ADR-0022: one QUIC session is two connections/streams. Each opens with a 1-byte
// role tag as its first byte so the host can route an inbound connection (graphics
// frames vs interactive control) regardless of arrival order.
public enum OwnedGraphicsStreamRole: UInt8, Sendable {
    case graphics = 0x47      // 'G'
    case interactive = 0x49   // 'I'
}
public enum OwnedGraphicsCommand: Equatable, Sendable {
    case resetSurface(surfaceGeneration: UInt32, width: Int, height: Int, pixelFormat: OwnedGraphicsPixelFormat)
    case bitmapTile(x: Int, y: Int, width: Int, height: Int, compression: OwnedGraphicsTileCompression, byteRange: OwnedGraphicsByteRange)
    case cacheTile(slot: UInt16, x: Int, y: Int, width: Int, height: Int, compression: OwnedGraphicsTileCompression, byteRange: OwnedGraphicsByteRange)
    case drawCachedTile(slot: UInt16, x: Int, y: Int, width: Int, height: Int)
    // ADR-0034 crisp-repair: clear a region of the surface layer to transparent so
    // the live video floor shows through it. Sent when a previously-settled tile
    // starts changing again (eager revert), so stale crisp never covers live pixels.
    case revertTileToVideo(x: Int, y: Int, width: Int, height: Int)

    public enum Kind: String, Codable, Sendable {
        case resetSurface
        case bitmapTile
        case cacheTile
        case drawCachedTile
        case revertTileToVideo
    }

    public enum CodingKeys: String, CodingKey, Sendable {
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

    public var kindIsBitmapTile: Bool {
        if case .bitmapTile = self { return true }
        return false
    }

    public var kindIsReset: Bool {
        if case .resetSurface = self { return true }
        return false
    }

    public func validateForCurrentScope(payloadLength: Int = Int.max) throws {
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
        case let .revertTileToVideo(x, y, width, height):
            guard x >= 0, y >= 0, width > 0, height > 0 else { throw SessionRejected(reason: .malformed) }
        }
    }
}
public struct OwnedGraphicsFrameAck: Codable, Equatable, Sendable {
    public let type: String
    public let surfaceGeneration: UInt32
    public let frameId: UInt64
    public let compositorMs: Double
    public let queueDepthBytes: Int
    public let queuedFrames: Int
    public let totalGraphicsFramesApplied: UInt64
    public let staleDiscardCount: Int

    public var updateId: OwnedSurfaceUpdateId {
        OwnedSurfaceUpdateId(surfaceGeneration: surfaceGeneration, frameId: frameId)
    }

    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
        case surfaceGeneration = "sg"
        case frameId = "id"
        case compositorMs = "cm"
        case queueDepthBytes = "qb"
        case queuedFrames = "qf"
        case totalGraphicsFramesApplied = "tg"
        case staleDiscardCount = "sd"
    }

    public init(
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

    public init(from decoder: Decoder) throws {
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

    public func encode(to encoder: Encoder) throws {
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
public struct OwnedGraphicsResetRequest: Codable, Equatable, Sendable {
    public let type: String
    public let reason: String
    public let lastCommittedSurfaceGeneration: UInt32
    public let lastCommittedFrameId: UInt64

    public var lastCommittedUpdateId: OwnedSurfaceUpdateId {
        OwnedSurfaceUpdateId(
            surfaceGeneration: lastCommittedSurfaceGeneration,
            frameId: lastCommittedFrameId
        )
    }

    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
        case reason = "r"
        case lastCommittedSurfaceGeneration = "sg"
        case lastCommittedFrameId = "id"
    }

    public init(reason: String, lastCommittedSurfaceGeneration: UInt32, lastCommittedFrameId: UInt64) {
        self.type = "graphics-reset-request"
        self.reason = reason
        self.lastCommittedSurfaceGeneration = lastCommittedSurfaceGeneration
        self.lastCommittedFrameId = lastCommittedFrameId
    }
}

extension OwnedGraphicsCommand: Codable {
    public init(from decoder: Decoder) throws {
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
        case .revertTileToVideo:
            self = .revertTileToVideo(
                x: try container.decode(Int.self, forKey: .x),
                y: try container.decode(Int.self, forKey: .y),
                width: try container.decode(Int.self, forKey: .width),
                height: try container.decode(Int.self, forKey: .height)
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
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
        case let .revertTileToVideo(x, y, width, height):
            try container.encode(Kind.revertTileToVideo, forKey: .kind)
            try container.encode(x, forKey: .x)
            try container.encode(y, forKey: .y)
            try container.encode(width, forKey: .width)
            try container.encode(height, forKey: .height)
        }
    }
}
