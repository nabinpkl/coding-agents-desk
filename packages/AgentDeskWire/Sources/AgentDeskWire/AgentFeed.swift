import Foundation

public struct ActivityBlock: Codable, Equatable, Sendable {
    public let kind: String
    public let label: String?
    public let text: String?
    public let tool: String?
    public let summary: String?
    public let preview: String?
    public let callId: String?

    public enum CodingKeys: String, CodingKey {
        case kind = "k"
        case label = "lb"
        case text = "tx"
        case tool = "tl"
        case summary = "sm"
        case preview = "pv"
        case callId = "ci"
    }

    public init(kind: String, label: String? = nil, text: String? = nil, tool: String? = nil, summary: String? = nil, preview: String? = nil, callId: String? = nil) {
        self.kind = kind
        self.label = label
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

    public enum CodingKeys: String, CodingKey {
        case index = "i"
        case ts
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

public struct AgentProjectSourceCounts: Codable, Equatable, Sendable {
    public let claude: Int
    public let codex: Int

    public enum CodingKeys: String, CodingKey {
        case claude = "cl"
        case codex = "co"
    }

    public init(claude: Int, codex: Int) {
        self.claude = claude
        self.codex = codex
    }
}

public struct AgentProjectSummary: Codable, Equatable, Sendable {
    public let projectPath: String
    public let displayName: String
    public let sourceCounts: AgentProjectSourceCounts
    public let sessionCount: Int
    public let lastEventAt: Double

    public enum CodingKeys: String, CodingKey {
        case projectPath = "pp"
        case displayName = "dn"
        case sourceCounts = "sc"
        case sessionCount = "sn"
        case lastEventAt = "lea"
    }

    public init(projectPath: String, displayName: String, sourceCounts: AgentProjectSourceCounts, sessionCount: Int, lastEventAt: Double) {
        self.projectPath = projectPath
        self.displayName = displayName
        self.sourceCounts = sourceCounts
        self.sessionCount = sessionCount
        self.lastEventAt = lastEventAt
    }
}

public struct AgentSessionSummary: Codable, Equatable, Sendable {
    public let sessionId: String
    public let source: String
    public let title: String
    public let lastEventAt: Double
    public let activity: String

    public enum CodingKeys: String, CodingKey {
        case sessionId = "sid"
        case source = "src"
        case title = "ttl"
        case lastEventAt = "lea"
        case activity = "ac"
    }

    public init(sessionId: String, source: String, title: String, lastEventAt: Double, activity: String) {
        self.sessionId = sessionId
        self.source = source
        self.title = title
        self.lastEventAt = lastEventAt
        self.activity = activity
    }
}

public struct AgentProjectsWatch: Codable, Equatable, Sendable {
    public let type = "agent-projects-watch"
    public let subscriptionId: String
    public enum CodingKeys: String, CodingKey { case type = "t"; case subscriptionId = "sub" }
    public init(subscriptionId: String) { self.subscriptionId = subscriptionId }
}

public struct AgentProjectsUnwatch: Codable, Equatable, Sendable {
    public let type = "agent-projects-unwatch"
    public let subscriptionId: String
    public enum CodingKeys: String, CodingKey { case type = "t"; case subscriptionId = "sub" }
    public init(subscriptionId: String) { self.subscriptionId = subscriptionId }
}

public struct AgentProjectsPush: Codable, Equatable, Sendable {
    public let type = "agent-projects"
    public let subscriptionId: String
    public let projects: [AgentProjectSummary]
    public enum CodingKeys: String, CodingKey { case type = "t"; case subscriptionId = "sub"; case projects = "p" }
    public init(subscriptionId: String, projects: [AgentProjectSummary]) {
        self.subscriptionId = subscriptionId
        self.projects = projects
    }
}

public struct AgentProjectsError: Codable, Equatable, Sendable {
    public let type = "agent-projects-error"
    public let subscriptionId: String
    public let reason: String
    public enum CodingKeys: String, CodingKey { case type = "t"; case subscriptionId = "sub"; case reason = "r" }
    public init(subscriptionId: String, reason: String) {
        self.subscriptionId = subscriptionId
        self.reason = reason
    }
}

public struct AgentProjectSessionsWatch: Codable, Equatable, Sendable {
    public let type = "agent-project-sessions-watch"
    public let subscriptionId: String
    public let projectPath: String
    public enum CodingKeys: String, CodingKey { case type = "t"; case subscriptionId = "sub"; case projectPath = "pp" }
    public init(subscriptionId: String, projectPath: String) {
        self.subscriptionId = subscriptionId
        self.projectPath = projectPath
    }
}

public struct AgentProjectSessionsUnwatch: Codable, Equatable, Sendable {
    public let type = "agent-project-sessions-unwatch"
    public let subscriptionId: String
    public enum CodingKeys: String, CodingKey { case type = "t"; case subscriptionId = "sub" }
    public init(subscriptionId: String) { self.subscriptionId = subscriptionId }
}

public struct AgentProjectSessionsPush: Codable, Equatable, Sendable {
    public let type = "agent-project-sessions"
    public let subscriptionId: String
    public let projectPath: String
    public let sessions: [AgentSessionSummary]
    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case subscriptionId = "sub"
        case projectPath = "pp"
        case sessions = "ss"
    }
    public init(subscriptionId: String, projectPath: String, sessions: [AgentSessionSummary]) {
        self.subscriptionId = subscriptionId
        self.projectPath = projectPath
        self.sessions = sessions
    }
}

public struct AgentProjectSessionsError: Codable, Equatable, Sendable {
    public let type = "agent-project-sessions-error"
    public let subscriptionId: String
    public let projectPath: String
    public let reason: String
    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case subscriptionId = "sub"
        case projectPath = "pp"
        case reason = "r"
    }
    public init(subscriptionId: String, projectPath: String, reason: String) {
        self.subscriptionId = subscriptionId
        self.projectPath = projectPath
        self.reason = reason
    }
}

public struct AgentThreadSubscribe: Codable, Equatable, Sendable {
    public let type = "agent-thread-sub"
    public let source: String
    public let sessionId: String
    public enum CodingKeys: String, CodingKey { case type = "t"; case source = "src"; case sessionId = "sid" }
    public init(source: String, sessionId: String) {
        self.source = source
        self.sessionId = sessionId
    }
}

public struct AgentThreadLoadOlder: Codable, Equatable, Sendable {
    public let type = "agent-thread-older"
    public let source: String
    public let sessionId: String
    public let beforeIndex: Int
    public let limit: Int
    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case source = "src"
        case sessionId = "sid"
        case beforeIndex = "bi"
        case limit = "lim"
    }
    public init(source: String, sessionId: String, beforeIndex: Int, limit: Int) {
        self.source = source
        self.sessionId = sessionId
        self.beforeIndex = beforeIndex
        self.limit = limit
    }
}

public struct AgentThreadUnsubscribe: Codable, Equatable, Sendable {
    public let type = "agent-thread-unsub"
    public let source: String
    public let sessionId: String
    public enum CodingKeys: String, CodingKey { case type = "t"; case source = "src"; case sessionId = "sid" }
    public init(source: String, sessionId: String) {
        self.source = source
        self.sessionId = sessionId
    }
}

public struct AgentThreadChunk: Codable, Equatable, Sendable {
    public let type = "agent-thread-chunk"
    public let source: String
    public let sessionId: String
    public let events: [ActivityEvent]
    public let windowStart: Int
    public let total: Int
    public let isLive: Bool
    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case source = "src"
        case sessionId = "sid"
        case events = "ev"
        case windowStart = "ws"
        case total = "tot"
        case isLive = "lv"
    }
    public init(source: String, sessionId: String, events: [ActivityEvent], windowStart: Int, total: Int, isLive: Bool) {
        self.source = source
        self.sessionId = sessionId
        self.events = events
        self.windowStart = windowStart
        self.total = total
        self.isLive = isLive
    }
}

public struct AgentThreadError: Codable, Equatable, Sendable {
    public let type = "agent-thread-error"
    public let source: String
    public let sessionId: String
    public let reason: String
    public enum CodingKeys: String, CodingKey { case type = "t"; case source = "src"; case sessionId = "sid"; case reason = "r" }
    public init(source: String, sessionId: String, reason: String) {
        self.source = source
        self.sessionId = sessionId
        self.reason = reason
    }
}

public struct SessionRevoke: Codable, Equatable, Sendable {
    public let type = "revoke"
    public enum CodingKeys: String, CodingKey { case type = "t" }
    public init() {}
}
