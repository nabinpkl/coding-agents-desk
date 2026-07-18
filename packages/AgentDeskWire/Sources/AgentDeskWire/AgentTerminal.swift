import Foundation

public struct AgentResumeTerminalContext: Codable, Equatable, Sendable {
    public let projectPath: String
    public let source: String
    public let harnessSessionID: String

    public enum CodingKeys: String, CodingKey, Sendable {
        case projectPath = "pp"
        case source = "src"
        case harnessSessionID = "sid"
    }

    public init(projectPath: String, source: String, harnessSessionID: String) {
        self.projectPath = projectPath
        self.source = source
        self.harnessSessionID = harnessSessionID
    }
}

public struct AgentTerminalOpen: Codable, Equatable, Sendable {
    public let type: String
    public let requestID: String
    public let context: AgentResumeTerminalContext

    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
        case requestID = "rid"
        case context = "ctx"
    }

    public init(requestID: String, context: AgentResumeTerminalContext) {
        self.type = "agent-terminal-open"
        self.requestID = requestID
        self.context = context
    }
}

public struct AgentTerminalReady: Codable, Equatable, Sendable {
    public let type: String
    public let requestID: String
    public let context: AgentResumeTerminalContext
    public let ptySessionName: String

    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
        case requestID = "rid"
        case context = "ctx"
        case ptySessionName = "psn"
    }

    public init(requestID: String, context: AgentResumeTerminalContext, ptySessionName: String) {
        self.type = "agent-terminal-ready"
        self.requestID = requestID
        self.context = context
        self.ptySessionName = ptySessionName
    }
}

public struct AgentTerminalAttachedAck: Codable, Equatable, Sendable {
    public let type: String
    public let requestID: String
    public let context: AgentResumeTerminalContext
    public let ptySessionName: String

    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
        case requestID = "rid"
        case context = "ctx"
        case ptySessionName = "psn"
    }

    public init(requestID: String, context: AgentResumeTerminalContext, ptySessionName: String) {
        self.type = "agent-terminal-attached"
        self.requestID = requestID
        self.context = context
        self.ptySessionName = ptySessionName
    }
}

public struct AgentTerminalClose: Codable, Equatable, Sendable {
    public let type: String
    public let requestID: String
    public let context: AgentResumeTerminalContext
    public let ptySessionName: String?
    public let reason: String

    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
        case requestID = "rid"
        case context = "ctx"
        case ptySessionName = "psn"
        case reason = "r"
    }

    public init(
        requestID: String,
        context: AgentResumeTerminalContext,
        ptySessionName: String? = nil,
        reason: String
    ) {
        self.type = "agent-terminal-close"
        self.requestID = requestID
        self.context = context
        self.ptySessionName = ptySessionName
        self.reason = reason
    }
}

public struct AgentTerminalEnded: Codable, Equatable, Sendable {
    public let type: String
    public let requestID: String
    public let context: AgentResumeTerminalContext
    public let ptySessionName: String
    public let exitStatus: Int32?

    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
        case requestID = "rid"
        case context = "ctx"
        case ptySessionName = "psn"
        case exitStatus = "xs"
    }

    public init(
        requestID: String,
        context: AgentResumeTerminalContext,
        ptySessionName: String,
        exitStatus: Int32? = nil
    ) {
        self.type = "agent-terminal-ended"
        self.requestID = requestID
        self.context = context
        self.ptySessionName = ptySessionName
        self.exitStatus = exitStatus
    }
}

public enum AgentTerminalErrorCode: String, Codable, CaseIterable, Equatable, Sendable {
    case invalidContext
    case activeElsewhere
    case launchFailed
    case handoffTimedOut
    case sessionEnded
}

public struct AgentTerminalError: Codable, Equatable, Sendable {
    public let type: String
    public let requestID: String
    public let context: AgentResumeTerminalContext
    public let ptySessionName: String?
    public let code: AgentTerminalErrorCode

    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
        case requestID = "rid"
        case context = "ctx"
        case ptySessionName = "psn"
        case code = "c"
    }

    public init(
        requestID: String,
        context: AgentResumeTerminalContext,
        ptySessionName: String? = nil,
        code: AgentTerminalErrorCode
    ) {
        self.type = "agent-terminal-error"
        self.requestID = requestID
        self.context = context
        self.ptySessionName = ptySessionName
        self.code = code
    }
}

public enum AgentTerminalClientMessage: Codable, Equatable, Sendable {
    case open(AgentTerminalOpen)
    case attached(AgentTerminalAttachedAck)
    case close(AgentTerminalClose)

    public init(from decoder: Decoder) throws {
        switch try AgentTerminalMessageHeader(from: decoder).type {
        case "agent-terminal-open":
            self = .open(try AgentTerminalOpen(from: decoder))
        case "agent-terminal-attached":
            self = .attached(try AgentTerminalAttachedAck(from: decoder))
        case "agent-terminal-close":
            self = .close(try AgentTerminalClose(from: decoder))
        default:
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "Unknown agent terminal client message")
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .open(let message): try message.encode(to: encoder)
        case .attached(let message): try message.encode(to: encoder)
        case .close(let message): try message.encode(to: encoder)
        }
    }

    public var requestID: String {
        switch self {
        case .open(let message): message.requestID
        case .attached(let message): message.requestID
        case .close(let message): message.requestID
        }
    }

    public var context: AgentResumeTerminalContext {
        switch self {
        case .open(let message): message.context
        case .attached(let message): message.context
        case .close(let message): message.context
        }
    }
}

public enum AgentTerminalHostMessage: Codable, Equatable, Sendable {
    case ready(AgentTerminalReady)
    case ended(AgentTerminalEnded)
    case error(AgentTerminalError)

    public init(from decoder: Decoder) throws {
        switch try AgentTerminalMessageHeader(from: decoder).type {
        case "agent-terminal-ready":
            self = .ready(try AgentTerminalReady(from: decoder))
        case "agent-terminal-ended":
            self = .ended(try AgentTerminalEnded(from: decoder))
        case "agent-terminal-error":
            self = .error(try AgentTerminalError(from: decoder))
        default:
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "Unknown agent terminal host message")
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .ready(let message): try message.encode(to: encoder)
        case .ended(let message): try message.encode(to: encoder)
        case .error(let message): try message.encode(to: encoder)
        }
    }

    public var requestID: String {
        switch self {
        case .ready(let message): message.requestID
        case .ended(let message): message.requestID
        case .error(let message): message.requestID
        }
    }

    public var context: AgentResumeTerminalContext {
        switch self {
        case .ready(let message): message.context
        case .ended(let message): message.context
        case .error(let message): message.context
        }
    }
}

private struct AgentTerminalMessageHeader: Decodable {
    let type: String

    enum CodingKeys: String, CodingKey {
        case type = "t"
    }
}
