import Foundation

public enum VoiceLaneCodec {
    public static let protocolIdentifier = "voice-lane-v2"
    public static let maximumFrameBytes = 256 * 1024
    public static let maximumJSONBytes = 192 * 1024

    public static func encode<T: Encodable>(_ value: T) throws -> Data {
        let data = try JSONEncoder().encode(value)
        guard data.count <= maximumFrameBytes else {
            throw VoiceLaneError.payloadTooLarge
        }
        return data
    }

    public static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        guard data.count <= maximumFrameBytes else {
            throw VoiceLaneError.payloadTooLarge
        }
        return try JSONDecoder().decode(type, from: data)
    }

    public static func validateJSON(_ json: String) throws {
        guard json.utf8.count <= maximumJSONBytes else {
            throw VoiceLaneError.payloadTooLarge
        }
        guard let data = json.data(using: .utf8),
              (try? JSONSerialization.jsonObject(with: data)) != nil
        else {
            throw VoiceLaneError.invalidJSON
        }
    }
}

public enum VoiceLaneError: Error, Equatable {
    case payloadTooLarge
    case invalidJSON
    case invalidSequence
    case unsupportedVersion
}

public struct VoiceLaneHello: Codable, Equatable, Sendable {
    public let protocolIdentifier: String

    public init(protocolIdentifier: String = VoiceLaneCodec.protocolIdentifier) {
        self.protocolIdentifier = protocolIdentifier
    }

    enum CodingKeys: String, CodingKey {
        case protocolIdentifier = "v"
    }
}

public enum VoiceRESTMethod: String, Codable, Equatable, Sendable {
    case get = "GET"
    case post = "POST"
    case delete = "DELETE"
}

public struct VoiceRESTRequest: Codable, Equatable, Sendable {
    public let requestID: String
    public let method: VoiceRESTMethod
    public let path: String
    public let body: Data?

    public init(requestID: String, method: VoiceRESTMethod, path: String, body: Data? = nil) {
        self.requestID = requestID
        self.method = method
        self.path = path
        self.body = body
    }
}

public struct VoiceRESTResponse: Codable, Equatable, Sendable {
    public let requestID: String
    public let status: Int
    public let contentType: String?
    public let sequence: Int
    public let isFinal: Bool
    public let body: Data

    public init(
        requestID: String,
        status: Int,
        contentType: String?,
        sequence: Int = 0,
        isFinal: Bool = true,
        body: Data
    ) {
        self.requestID = requestID
        self.status = status
        self.contentType = contentType
        self.sequence = sequence
        self.isFinal = isFinal
        self.body = body
    }
}

public enum VoiceLaneErrorCode: String, Codable, Equatable, Sendable {
    case invalidRequest
    case invalidSequence
    case payloadTooLarge
    case sidecarUnavailable
    case unsupportedVersion
    case transportLost
}

public enum VoiceLaneClientMessage: Codable, Equatable, Sendable {
    case socketOpen(requestID: String, recordingSessionID: String)
    case socketMessage(recordingSessionID: String, json: String)
    case socketClose(recordingSessionID: String)
    case rest(VoiceRESTRequest)

    private enum CodingKeys: String, CodingKey {
        case type = "t"
        case requestID = "rid"
        case recordingSessionID = "sid"
        case json = "j"
        case rest = "r"
    }

    private enum MessageType: String {
        case socketOpen
        case socketMessage
        case socketClose
        case rest
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let rawType = try container.decode(String.self, forKey: .type)
        guard let type = MessageType(rawValue: rawType) else {
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "unknown voice client message \(rawType)"
            )
        }
        switch type {
        case .socketOpen:
            self = .socketOpen(
                requestID: try container.decode(String.self, forKey: .requestID),
                recordingSessionID: try container.decode(
                    String.self,
                    forKey: .recordingSessionID
                )
            )
        case .socketMessage:
            let json = try container.decode(String.self, forKey: .json)
            try VoiceLaneCodec.validateJSON(json)
            self = .socketMessage(
                recordingSessionID: try container.decode(
                    String.self,
                    forKey: .recordingSessionID
                ),
                json: json
            )
        case .socketClose:
            self = .socketClose(
                recordingSessionID: try container.decode(
                    String.self,
                    forKey: .recordingSessionID
                )
            )
        case .rest:
            self = .rest(try container.decode(VoiceRESTRequest.self, forKey: .rest))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .socketOpen(let requestID, let recordingSessionID):
            try container.encode(MessageType.socketOpen.rawValue, forKey: .type)
            try container.encode(requestID, forKey: .requestID)
            try container.encode(recordingSessionID, forKey: .recordingSessionID)
        case .socketMessage(let recordingSessionID, let json):
            try VoiceLaneCodec.validateJSON(json)
            try container.encode(MessageType.socketMessage.rawValue, forKey: .type)
            try container.encode(recordingSessionID, forKey: .recordingSessionID)
            try container.encode(json, forKey: .json)
        case .socketClose(let recordingSessionID):
            try container.encode(MessageType.socketClose.rawValue, forKey: .type)
            try container.encode(recordingSessionID, forKey: .recordingSessionID)
        case .rest(let request):
            try container.encode(MessageType.rest.rawValue, forKey: .type)
            try container.encode(request, forKey: .rest)
        }
    }
}

public enum VoiceLaneHostMessage: Codable, Equatable, Sendable {
    case ready
    case socketOpened(requestID: String, recordingSessionID: String)
    case socketMessage(recordingSessionID: String, json: String)
    case socketClosed(recordingSessionID: String, reason: String?)
    case rest(VoiceRESTResponse)
    case error(
        requestID: String?,
        recordingSessionID: String?,
        code: VoiceLaneErrorCode,
        message: String
    )

    private enum CodingKeys: String, CodingKey {
        case type = "t"
        case requestID = "rid"
        case recordingSessionID = "sid"
        case json = "j"
        case reason = "z"
        case rest = "r"
        case code = "c"
        case message = "m"
    }

    private enum MessageType: String {
        case ready
        case socketOpened
        case socketMessage
        case socketClosed
        case rest
        case error
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let rawType = try container.decode(String.self, forKey: .type)
        guard let type = MessageType(rawValue: rawType) else {
            throw DecodingError.dataCorruptedError(
                forKey: .type,
                in: container,
                debugDescription: "unknown voice host message \(rawType)"
            )
        }
        switch type {
        case .ready:
            self = .ready
        case .socketOpened:
            self = .socketOpened(
                requestID: try container.decode(String.self, forKey: .requestID),
                recordingSessionID: try container.decode(
                    String.self,
                    forKey: .recordingSessionID
                )
            )
        case .socketMessage:
            let json = try container.decode(String.self, forKey: .json)
            try VoiceLaneCodec.validateJSON(json)
            self = .socketMessage(
                recordingSessionID: try container.decode(
                    String.self,
                    forKey: .recordingSessionID
                ),
                json: json
            )
        case .socketClosed:
            self = .socketClosed(
                recordingSessionID: try container.decode(
                    String.self,
                    forKey: .recordingSessionID
                ),
                reason: try container.decodeIfPresent(String.self, forKey: .reason)
            )
        case .rest:
            self = .rest(try container.decode(VoiceRESTResponse.self, forKey: .rest))
        case .error:
            self = .error(
                requestID: try container.decodeIfPresent(String.self, forKey: .requestID),
                recordingSessionID: try container.decodeIfPresent(
                    String.self,
                    forKey: .recordingSessionID
                ),
                code: try container.decode(VoiceLaneErrorCode.self, forKey: .code),
                message: try container.decode(String.self, forKey: .message)
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .ready:
            try container.encode(MessageType.ready.rawValue, forKey: .type)
        case .socketOpened(let requestID, let recordingSessionID):
            try container.encode(MessageType.socketOpened.rawValue, forKey: .type)
            try container.encode(requestID, forKey: .requestID)
            try container.encode(recordingSessionID, forKey: .recordingSessionID)
        case .socketMessage(let recordingSessionID, let json):
            try VoiceLaneCodec.validateJSON(json)
            try container.encode(MessageType.socketMessage.rawValue, forKey: .type)
            try container.encode(recordingSessionID, forKey: .recordingSessionID)
            try container.encode(json, forKey: .json)
        case .socketClosed(let recordingSessionID, let reason):
            try container.encode(MessageType.socketClosed.rawValue, forKey: .type)
            try container.encode(recordingSessionID, forKey: .recordingSessionID)
            try container.encodeIfPresent(reason, forKey: .reason)
        case .rest(let response):
            try container.encode(MessageType.rest.rawValue, forKey: .type)
            try container.encode(response, forKey: .rest)
        case .error(let requestID, let recordingSessionID, let code, let message):
            try container.encode(MessageType.error.rawValue, forKey: .type)
            try container.encodeIfPresent(requestID, forKey: .requestID)
            try container.encodeIfPresent(recordingSessionID, forKey: .recordingSessionID)
            try container.encode(code, forKey: .code)
            try container.encode(message, forKey: .message)
        }
    }
}
