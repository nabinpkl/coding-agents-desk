import Foundation

/// The lane that carries the voice models from the Mac to the phone.
///
/// These assets are ~220MB, two thirds of what the client bundle used to be,
/// and they change far less often than the app around them. Bundling them made
/// every install pay for them again: a wireless dev install spent nine minutes
/// moving bytes the phone already had. They live on the Mac now and the phone
/// fetches them once, on first use of the Voice surface, then reads its own
/// cache forever after.
///
/// The Mac is the natural host for them. It already generates and hash-verifies
/// them (`just voice-phone-model`, `just voice-zipa-model`), it already holds an
/// authenticated session with this phone, and unlike App Store hosting it serves
/// a locally installed development build exactly the same way it serves a
/// TestFlight one.
public enum VoiceAssetCodec {
    /// Chunks are bounded well under the 4MB frame ceiling so one asset's
    /// transfer cannot monopolise a frame slot, and so a dropped chunk costs
    /// little to re-request.
    public static let chunkBytes = 512 * 1024
    public static let maximumFrameBytes = 1 * 1024 * 1024
}

/// One downloadable voice asset file.
///
/// The unit is a single file, and `path` is both its identity and where it
/// lands relative to the cache root. Core ML compiles to a `.mlmodelc`
/// *directory*, but that directory holds five files, so sending them
/// individually costs one extra round trip each and avoids archiving: no
/// archive framework on either side, no derived artifact for the Mac to cache
/// and invalidate, and an interrupted transfer resumes per file rather than
/// restarting the whole model.
///
/// `sha256` is the contract, not a nicety: the phone keeps this cache across
/// launches and app updates, so it has to be able to tell a complete, current
/// file from a truncated or stale one without asking the Mac to send it again.
public struct VoiceAssetDescriptor: Codable, Equatable, Sendable {
    /// Relative path from the asset root, e.g.
    /// `VoicePhoneModel.mlmodelc/weights/weight.bin`.
    public let path: String
    public let byteCount: UInt64
    public let sha256: String

    public enum CodingKeys: String, CodingKey, Sendable {
        case path = "p"
        case byteCount = "b"
        case sha256 = "h"
    }

    public init(path: String, byteCount: UInt64, sha256: String) {
        self.path = path
        self.byteCount = byteCount
        self.sha256 = sha256
    }
}

public struct VoiceAssetManifest: Codable, Equatable, Sendable {
    public let assets: [VoiceAssetDescriptor]

    public enum CodingKeys: String, CodingKey, Sendable {
        case assets = "a"
    }

    public init(assets: [VoiceAssetDescriptor]) {
        self.assets = assets
    }
}

public enum VoiceAssetLaneRequest: Codable, Equatable, Sendable {
    /// Ask what the Mac has. The phone compares this against its cache and
    /// fetches only what is missing or stale.
    case manifest
    /// Fetch one asset from `offset`, so an interrupted transfer resumes instead
    /// of restarting. At this size, restarting a 152MB asset because a session
    /// blipped is the difference between a pause and a failure.
    case fetch(path: String, offset: UInt64)

    private enum CodingKeys: String, CodingKey {
        case type = "t"
        case path = "p"
        case offset = "o"
    }

    private enum MessageType: String {
        case manifest
        case fetch
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let rawType = try container.decode(String.self, forKey: .type)
        guard let type = MessageType(rawValue: rawType) else {
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "unknown voice asset request: \(rawType)"
            )
        }
        switch type {
        case .manifest:
            self = .manifest
        case .fetch:
            self = .fetch(
                path: try container.decode(String.self, forKey: .path),
                offset: try container.decodeIfPresent(UInt64.self, forKey: .offset) ?? 0
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .manifest:
            try container.encode(MessageType.manifest.rawValue, forKey: .type)
        case .fetch(let path, let offset):
            try container.encode(MessageType.fetch.rawValue, forKey: .type)
            try container.encode(path, forKey: .path)
            try container.encode(offset, forKey: .offset)
        }
    }
}

public enum VoiceAssetLaneResponse: Codable, Equatable, Sendable {
    case manifest(VoiceAssetManifest)
    /// One chunk of `id` starting at `offset`. `isLast` ends the transfer; the
    /// receiver verifies the whole asset against its descriptor hash before
    /// promoting it into the cache.
    case chunk(path: String, offset: UInt64, bytes: Data, isLast: Bool)
    case failure(path: String?, message: String)

    private enum CodingKeys: String, CodingKey {
        case type = "t"
        case manifest = "m"
        case path = "p"
        case offset = "o"
        case bytes = "b"
        case isLast = "l"
        case message = "e"
    }

    private enum MessageType: String {
        case manifest
        case chunk
        case failure
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let rawType = try container.decode(String.self, forKey: .type)
        guard let type = MessageType(rawValue: rawType) else {
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "unknown voice asset response: \(rawType)"
            )
        }
        switch type {
        case .manifest:
            self = .manifest(try container.decode(VoiceAssetManifest.self, forKey: .manifest))
        case .chunk:
            self = .chunk(
                path: try container.decode(String.self, forKey: .path),
                offset: try container.decode(UInt64.self, forKey: .offset),
                bytes: try container.decode(Data.self, forKey: .bytes),
                isLast: try container.decodeIfPresent(Bool.self, forKey: .isLast) ?? false
            )
        case .failure:
            self = .failure(
                path: try container.decodeIfPresent(String.self, forKey: .path),
                message: try container.decode(String.self, forKey: .message)
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .manifest(let manifest):
            try container.encode(MessageType.manifest.rawValue, forKey: .type)
            try container.encode(manifest, forKey: .manifest)
        case .chunk(let path, let offset, let bytes, let isLast):
            try container.encode(MessageType.chunk.rawValue, forKey: .type)
            try container.encode(path, forKey: .path)
            try container.encode(offset, forKey: .offset)
            try container.encode(bytes, forKey: .bytes)
            try container.encode(isLast, forKey: .isLast)
        case .failure(let path, let message):
            try container.encode(MessageType.failure.rawValue, forKey: .type)
            try container.encodeIfPresent(path, forKey: .path)
            try container.encode(message, forKey: .message)
        }
    }
}
