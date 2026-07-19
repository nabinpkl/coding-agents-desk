import Foundation

public struct WorkspaceTerminalOpen: Codable, Equatable, Sendable {
    public let type: String
    public let requestID: String
    public let workspaceID: String
    public let preferredSessionName: String?
    public let columns: UInt32
    public let rows: UInt32

    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
        case requestID = "rid"
        case workspaceID = "wid"
        case preferredSessionName = "psn"
        case columns = "co"
        case rows = "ro"
    }

    public init(
        requestID: String,
        workspaceID: String,
        preferredSessionName: String? = nil,
        columns: UInt32,
        rows: UInt32
    ) {
        self.type = "workspace-terminal-open"
        self.requestID = requestID
        self.workspaceID = workspaceID
        self.preferredSessionName = preferredSessionName
        self.columns = columns
        self.rows = rows
    }
}

public struct WorkspaceTerminalReady: Codable, Equatable, Sendable {
    public let type: String
    public let requestID: String
    public let workspaceID: String
    public let ptySessionName: String

    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
        case requestID = "rid"
        case workspaceID = "wid"
        case ptySessionName = "psn"
    }

    public init(requestID: String, workspaceID: String, ptySessionName: String) {
        self.type = "workspace-terminal-ready"
        self.requestID = requestID
        self.workspaceID = workspaceID
        self.ptySessionName = ptySessionName
    }
}

public struct WorkspaceTerminalAttachedAck: Codable, Equatable, Sendable {
    public let type: String
    public let requestID: String
    public let workspaceID: String
    public let ptySessionName: String

    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
        case requestID = "rid"
        case workspaceID = "wid"
        case ptySessionName = "psn"
    }

    public init(requestID: String, workspaceID: String, ptySessionName: String) {
        self.type = "workspace-terminal-attached"
        self.requestID = requestID
        self.workspaceID = workspaceID
        self.ptySessionName = ptySessionName
    }
}

public struct WorkspaceTerminalCancel: Codable, Equatable, Sendable {
    public let type: String
    public let requestID: String
    public let workspaceID: String
    public let ptySessionName: String?

    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
        case requestID = "rid"
        case workspaceID = "wid"
        case ptySessionName = "psn"
    }

    public init(requestID: String, workspaceID: String, ptySessionName: String? = nil) {
        self.type = "workspace-terminal-cancel"
        self.requestID = requestID
        self.workspaceID = workspaceID
        self.ptySessionName = ptySessionName
    }
}

public enum WorkspaceTerminalErrorCode: String, Codable, CaseIterable, Equatable, Sendable {
    case workspaceUnavailable
    case invalidSession
    case launchFailed
    case handoffTimedOut
    case sessionEnded
}

public struct WorkspaceTerminalError: Codable, Equatable, Sendable {
    public let type: String
    public let requestID: String
    public let workspaceID: String
    public let ptySessionName: String?
    public let code: WorkspaceTerminalErrorCode

    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
        case requestID = "rid"
        case workspaceID = "wid"
        case ptySessionName = "psn"
        case code = "c"
    }

    public init(
        requestID: String,
        workspaceID: String,
        ptySessionName: String? = nil,
        code: WorkspaceTerminalErrorCode
    ) {
        self.type = "workspace-terminal-error"
        self.requestID = requestID
        self.workspaceID = workspaceID
        self.ptySessionName = ptySessionName
        self.code = code
    }
}

public enum WorkspaceTerminalClientMessage: Codable, Equatable, Sendable {
    case open(WorkspaceTerminalOpen)
    case attached(WorkspaceTerminalAttachedAck)
    case cancel(WorkspaceTerminalCancel)

    public init(from decoder: Decoder) throws {
        switch try WorkspaceTerminalMessageHeader(from: decoder).type {
        case "workspace-terminal-open":
            self = .open(try WorkspaceTerminalOpen(from: decoder))
        case "workspace-terminal-attached":
            self = .attached(try WorkspaceTerminalAttachedAck(from: decoder))
        case "workspace-terminal-cancel":
            self = .cancel(try WorkspaceTerminalCancel(from: decoder))
        default:
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "Unknown workspace terminal client message")
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .open(let message): try message.encode(to: encoder)
        case .attached(let message): try message.encode(to: encoder)
        case .cancel(let message): try message.encode(to: encoder)
        }
    }

    public var requestID: String {
        switch self {
        case .open(let message): message.requestID
        case .attached(let message): message.requestID
        case .cancel(let message): message.requestID
        }
    }

    public var workspaceID: String {
        switch self {
        case .open(let message): message.workspaceID
        case .attached(let message): message.workspaceID
        case .cancel(let message): message.workspaceID
        }
    }
}

public enum WorkspaceTerminalHostMessage: Codable, Equatable, Sendable {
    case ready(WorkspaceTerminalReady)
    case error(WorkspaceTerminalError)

    public init(from decoder: Decoder) throws {
        switch try WorkspaceTerminalMessageHeader(from: decoder).type {
        case "workspace-terminal-ready":
            self = .ready(try WorkspaceTerminalReady(from: decoder))
        case "workspace-terminal-error":
            self = .error(try WorkspaceTerminalError(from: decoder))
        default:
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "Unknown workspace terminal host message")
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .ready(let message): try message.encode(to: encoder)
        case .error(let message): try message.encode(to: encoder)
        }
    }

    public var requestID: String {
        switch self {
        case .ready(let message): message.requestID
        case .error(let message): message.requestID
        }
    }

    public var workspaceID: String {
        switch self {
        case .ready(let message): message.workspaceID
        case .error(let message): message.workspaceID
        }
    }
}

private struct WorkspaceTerminalMessageHeader: Decodable {
    let type: String

    enum CodingKeys: String, CodingKey {
        case type = "t"
    }
}
