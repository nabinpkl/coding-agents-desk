import Foundation

public struct ClientScreenshotRequest: Codable, Equatable, Sendable {
    public let type: String
    public let requestId: String
    public let maxPixelDimension: Int?
    public let maxBytes: Int?

    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case requestId = "rid"
        case maxPixelDimension = "mp"
        case maxBytes = "mb"
    }

    public init(requestId: String, maxPixelDimension: Int? = nil, maxBytes: Int? = nil) {
        self.type = "client-screenshot-request"
        self.requestId = requestId
        self.maxPixelDimension = maxPixelDimension
        self.maxBytes = maxBytes
    }
}

public struct ClientScreenshotManifest: Codable, Equatable, Sendable {
    public let type: String
    public let requestId: String
    public let capturedAt: Int
    public let clientBuildSHA: String
    public let surfaceName: String
    public let pixelWidth: Int
    public let pixelHeight: Int
    public let scale: Double
    public let orientation: String
    public let mimeType: String
    public let totalBytes: Int
    public let sha256: String
    public let omittedLayers: [String]

    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case requestId = "rid"
        case capturedAt = "ca"
        case clientBuildSHA = "sha"
        case surfaceName = "sn"
        case pixelWidth = "pw"
        case pixelHeight = "ph"
        case scale = "sc"
        case orientation = "o"
        case mimeType = "mt"
        case totalBytes = "tb"
        case sha256 = "h"
        case omittedLayers = "ol"
    }

    public init(
        requestId: String,
        capturedAt: Int,
        clientBuildSHA: String,
        surfaceName: String,
        pixelWidth: Int,
        pixelHeight: Int,
        scale: Double,
        orientation: String,
        mimeType: String,
        totalBytes: Int,
        sha256: String,
        omittedLayers: [String]
    ) {
        self.type = "client-screenshot-manifest"
        self.requestId = requestId
        self.capturedAt = capturedAt
        self.clientBuildSHA = clientBuildSHA
        self.surfaceName = surfaceName
        self.pixelWidth = pixelWidth
        self.pixelHeight = pixelHeight
        self.scale = scale
        self.orientation = orientation
        self.mimeType = mimeType
        self.totalBytes = totalBytes
        self.sha256 = sha256
        self.omittedLayers = omittedLayers
    }
}

public struct ClientScreenshotChunk: Codable, Equatable, Sendable {
    public let type: String
    public let requestId: String
    public let sequence: Int
    public let isFinal: Bool
    public let payloadBase64: String

    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case requestId = "rid"
        case sequence = "s"
        case isFinal = "f"
        case payloadBase64 = "p"
    }

    public init(requestId: String, sequence: Int, isFinal: Bool, payloadBase64: String) {
        self.type = "client-screenshot-chunk"
        self.requestId = requestId
        self.sequence = sequence
        self.isFinal = isFinal
        self.payloadBase64 = payloadBase64
    }
}

public struct ClientScreenshotError: Codable, Equatable, Error, Sendable {
    public let type: String
    public let requestId: String
    public let reason: String

    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case requestId = "rid"
        case reason = "r"
    }

    public init(requestId: String, reason: String) {
        self.type = "client-screenshot-error"
        self.requestId = requestId
        self.reason = reason
    }
}

public struct SignedClientScreenshotRequest: Codable, Equatable, Sendable {
    public let type: String
    public let requestId: String
    public let maxPixelDimension: Int?
    public let maxBytes: Int?
    public let hostFingerprint: String
    public let issuedAt: Int
    public let nonce: Data
    public let hostSignature: Data

    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case requestId = "rid"
        case maxPixelDimension = "mp"
        case maxBytes = "mb"
        case hostFingerprint = "hf"
        case issuedAt = "ts"
        case nonce = "n"
        case hostSignature = "hs"
    }

    public init(
        requestId: String,
        maxPixelDimension: Int? = nil,
        maxBytes: Int? = nil,
        hostFingerprint: String,
        issuedAt: Int,
        nonce: Data,
        hostSignature: Data
    ) {
        self.type = "client-screenshot-request"
        self.requestId = requestId
        self.maxPixelDimension = maxPixelDimension
        self.maxBytes = maxBytes
        self.hostFingerprint = hostFingerprint
        self.issuedAt = issuedAt
        self.nonce = nonce
        self.hostSignature = hostSignature
    }

    public var request: ClientScreenshotRequest {
        ClientScreenshotRequest(
            requestId: requestId,
            maxPixelDimension: maxPixelDimension,
            maxBytes: maxBytes
        )
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decode(String.self, forKey: .type)
        requestId = try container.decode(String.self, forKey: .requestId)
        maxPixelDimension = try container.decodeIfPresent(Int.self, forKey: .maxPixelDimension)
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
        try container.encodeIfPresent(maxPixelDimension, forKey: .maxPixelDimension)
        try container.encodeIfPresent(maxBytes, forKey: .maxBytes)
        try container.encode(hostFingerprint, forKey: .hostFingerprint)
        try container.encode(issuedAt, forKey: .issuedAt)
        try container.encode(nonce.base64URLEncodedString(), forKey: .nonce)
        try container.encode(hostSignature.base64URLEncodedString(), forKey: .hostSignature)
    }
}

public enum ClientScreenshotRequestSignature: Sendable {
    private struct SigningEnvelope: Encodable {
        let request: ClientScreenshotRequest
        let hostFingerprint: String
        let issuedAt: Int
        let nonce: String
    }

    public static func signingData(
        request: ClientScreenshotRequest,
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
