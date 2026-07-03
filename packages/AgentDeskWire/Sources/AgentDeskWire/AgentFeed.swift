// AgentFeed wire types (ADR-0050). Single source of truth for host and client.

import Foundation

public struct ActivityBlock: Codable, Equatable, Sendable {
    public let kind: String
    public let text: String?
    public let tool: String?
    public let summary: String?
    public let preview: String?
    public let callId: String?

    public enum CodingKeys: String, CodingKey, Sendable {
        case kind = "k"
        case text = "tx"
        case tool = "tl"
        case summary = "sm"
        case preview = "pv"
        case callId = "ci"
    }

    public init(kind: String, text: String? = nil, tool: String? = nil, summary: String? = nil, preview: String? = nil, callId: String? = nil) {
        self.kind = kind
        self.text = text
        self.tool = tool
        self.summary = summary
        self.preview = preview
        self.callId = callId
    }
}
public struct ActivityEvent: Codable, Equatable, Sendable {
    public let index: Int
    public let ts: Double
    public let type: String
    public let blocks: [ActivityBlock]

    public enum CodingKeys: String, CodingKey, Sendable {
        case index = "i"
        case ts = "ts"
        case type = "tp"
        case blocks = "b"
    }

    public init(index: Int, ts: Double, type: String, blocks: [ActivityBlock]) {
        self.index = index
        self.ts = ts
        self.type = type
        self.blocks = blocks
    }
}
public struct AgentSessionSummary: Codable, Equatable, Sendable {
    public let sessionId: String
    public let source: String
    public let title: String?
    public let lastEventAt: Double
    public let isLive: Bool

    public enum CodingKeys: String, CodingKey, Sendable {
        case sessionId = "sid"
        case source = "src"
        case title = "ttl"
        case lastEventAt = "lea"
        case isLive = "lv"
    }

    public init(sessionId: String, source: String, title: String? = nil, lastEventAt: Double, isLive: Bool) {
        self.sessionId = sessionId
        self.source = source
        self.title = title
        self.lastEventAt = lastEventAt
        self.isLive = isLive
    }
}
public struct ProjectDigest: Codable, Equatable, Sendable {
    public let projectPath: String
    public let displayName: String?
    public let sessions: [AgentSessionSummary]

    public enum CodingKeys: String, CodingKey, Sendable {
        case projectPath = "pp"
        case displayName = "dn"
        case sessions = "ss"
    }

    public init(projectPath: String, displayName: String? = nil, sessions: [AgentSessionSummary]) {
        self.projectPath = projectPath
        self.displayName = displayName
        self.sessions = sessions
    }
}
public struct AgentProjectsSubscribe: Codable, Equatable, Sendable {
    public let type: String

    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
    }

    public init() {
        self.type = "agent-projects-sub"
    }
}
// Client -> host on the input lane: the phone is revoking the pairing. The host
// removes its paired-device record (same path as the menubar "Revoke" button).
// Additive, type-only frame; mirrors AgentProjectsSubscribe.
public struct SessionRevoke: Codable, Equatable, Sendable {
    public let type: String

    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
    }

    public init() {
        self.type = "revoke"
    }
}
public struct AgentThreadSubscribe: Codable, Equatable, Sendable {
    public let type: String
    // Optional: the phone bridge subscribes by sessionId alone (it has no
    // projectPath at drill-in time). handleThreadSubscribe falls back to
    // projectPath only when sessionId is absent, so a sid-only request must
    // decode without `pp` present.
    public let projectPath: String?
    public let source: String?
    public let sessionId: String?

    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
        case projectPath = "pp"
        case source = "src"
        case sessionId = "sid"
    }

    public init(projectPath: String? = nil, source: String? = nil, sessionId: String? = nil) {
        self.type = "agent-thread-sub"
        self.projectPath = projectPath
        self.source = source
        self.sessionId = sessionId
    }
}
public struct AgentThreadLoadOlder: Codable, Equatable, Sendable {
    public let type: String
    public let sessionId: String
    public let beforeIndex: Int
    public let limit: Int

    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
        case sessionId = "sid"
        case beforeIndex = "bi"
        case limit = "lim"
    }

    public init(sessionId: String, beforeIndex: Int, limit: Int) {
        self.type = "agent-thread-older"
        self.sessionId = sessionId
        self.beforeIndex = beforeIndex
        self.limit = limit
    }
}
public struct AgentThreadUnsubscribe: Codable, Equatable, Sendable {
    public let type: String
    public let sessionId: String

    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
        case sessionId = "sid"
    }

    public init(sessionId: String) {
        self.type = "agent-thread-unsub"
        self.sessionId = sessionId
    }
}
public struct AgentProjectsPush: Codable, Equatable, Sendable {
    public let type: String
    public let projects: [ProjectDigest]

    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
        case projects = "p"
    }

    public init(projects: [ProjectDigest]) {
        self.type = "agent-projects"
        self.projects = projects
    }
}
public struct AgentThreadChunk: Codable, Equatable, Sendable {
    public let type: String
    public let sessionId: String
    public let events: [ActivityEvent]
    public let windowStart: Int
    public let total: Int
    public let isLive: Bool

    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
        case sessionId = "sid"
        case events = "ev"
        case windowStart = "ws"
        case total = "tot"
        case isLive = "lv"
    }

    public init(sessionId: String, events: [ActivityEvent], windowStart: Int, total: Int, isLive: Bool) {
        self.type = "agent-thread-chunk"
        self.sessionId = sessionId
        self.events = events
        self.windowStart = windowStart
        self.total = total
        self.isLive = isLive
    }
}
public struct AgentThreadError: Codable, Equatable, Sendable {
    public let type: String
    public let sessionId: String
    public let reason: String

    public enum CodingKeys: String, CodingKey, Sendable {
        case type = "t"
        case sessionId = "sid"
        case reason = "r"
    }

    public init(sessionId: String, reason: String) {
        self.type = "agent-thread-error"
        self.sessionId = sessionId
        self.reason = reason
    }
}
