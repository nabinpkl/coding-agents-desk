import Foundation

public enum AgentJSONValue: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([AgentJSONValue])
    case object([String: AgentJSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([AgentJSONValue].self) { self = .array(value) }
        else { self = .object(try container.decode([String: AgentJSONValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}

public struct ActivityBlock: Codable, Equatable, Sendable {
    public let kind: String
    public let label: String?
    public let text: String?
    public let tool: String?
    public let summary: String?
    public let preview: String?
    public let callId: String?
    public let input: [String: AgentJSONValue]?
    public let hiddenChars: Int?
    public let hiddenLines: Int?

    public enum CodingKeys: String, CodingKey {
        case kind = "k"
        case label = "lb"
        case text = "tx"
        case tool = "tl"
        case summary = "sm"
        case preview = "pv"
        case callId = "ci"
        case input = "in"
        case hiddenChars = "hc"
        case hiddenLines = "hl"
    }

    public init(kind: String, label: String? = nil, text: String? = nil, tool: String? = nil, summary: String? = nil, preview: String? = nil, callId: String? = nil, input: [String: AgentJSONValue]? = nil, hiddenChars: Int? = nil, hiddenLines: Int? = nil) {
        self.kind = kind
        self.label = label
        self.text = text
        self.tool = tool
        self.summary = summary
        self.preview = preview
        self.callId = callId
        self.input = input
        self.hiddenChars = hiddenChars
        self.hiddenLines = hiddenLines
    }
}

public struct ActivityEvent: Codable, Equatable, Sendable {
    public let id: String
    /// Position in the mode this event was read in.
    public let index: Int
    public let revision: Int
    public let phase: String
    public let ts: Double
    public let type: String
    public let blocks: [ActivityBlock]
    /// Position of the same line in the OTHER mode, or nil when it has none -- a machinery line read
    /// in raw mode is absent from the nice view entirely. Carried so a mode switch can keep the
    /// viewer's place: the index is mode-relative, and this is the only translation the panel has
    /// without another round trip.
    public let otherModeIndex: Int?

    public enum CodingKeys: String, CodingKey {
        case id = "id"
        case index = "i"
        case revision = "rev"
        case phase = "ph"
        case ts
        case type = "tp"
        case blocks = "b"
        case otherModeIndex = "xi"
    }

    public init(
        id: String,
        index: Int,
        revision: Int,
        phase: String,
        ts: Double,
        type: String,
        blocks: [ActivityBlock],
        otherModeIndex: Int? = nil
    ) {
        self.id = id
        self.index = index
        self.revision = revision
        self.phase = phase
        self.ts = ts
        self.type = type
        self.blocks = blocks
        self.otherModeIndex = otherModeIndex
    }
}

/// Latest context-window occupancy for a session, for the panel's header meter.
///
/// `limit` arrives RESOLVED: Codex publishes its window in the transcript, and the sidecar resolves
/// Claude's from its own model table, so neither the host nor either panel holds model knowledge.
/// Nil means the sidecar has no window for the model, and the panel shows a count with no fill bar
/// rather than a fraction of a guessed denominator.
public struct TokenUsage: Codable, Equatable, Sendable {
    public let current: Int
    public let limit: Int?
    public let updatedAt: Double
    public let model: String?

    public enum CodingKeys: String, CodingKey {
        case current = "cur"
        case limit = "lim"
        case updatedAt = "ua"
        case model = "mdl"
    }

    public init(current: Int, limit: Int? = nil, updatedAt: Double, model: String? = nil) {
        self.current = current
        self.limit = limit
        self.updatedAt = updatedAt
        self.model = model
    }
}

public struct AgentProjectSummary: Codable, Equatable, Sendable {
    public let projectPath: String
    public let displayName: String
    public let sourceCounts: [String: Int]
    public let sessionCount: Int
    public let lastEventAt: Double

    public enum CodingKeys: String, CodingKey {
        case projectPath = "pp"
        case displayName = "dn"
        case sourceCounts = "sc"
        case sessionCount = "sn"
        case lastEventAt = "lea"
    }

    public init(projectPath: String, displayName: String, sourceCounts: [String: Int], sessionCount: Int, lastEventAt: Double) {
        self.projectPath = projectPath
        self.displayName = displayName
        self.sourceCounts = sourceCounts
        self.sessionCount = sessionCount
        self.lastEventAt = lastEventAt
    }
}

public struct AgentSessionCapabilities: Codable, Equatable, Sendable {
    public let modes: [String]
    public let canSend: Bool
    public let canSteer: Bool
    public let canAbort: Bool
    public let canFetchRaw: Bool
    public let canOpenTerminal: Bool
    public let supportsExtensionUI: Bool

    public enum CodingKeys: String, CodingKey {
        case modes = "md"
        case canSend = "snd"
        case canSteer = "str"
        case canAbort = "abt"
        case canFetchRaw = "raw"
        case canOpenTerminal = "pty"
        case supportsExtensionUI = "xui"
    }

    public init(modes: [String], canSend: Bool, canSteer: Bool, canAbort: Bool, canFetchRaw: Bool, canOpenTerminal: Bool, supportsExtensionUI: Bool) {
        self.modes = modes
        self.canSend = canSend
        self.canSteer = canSteer
        self.canAbort = canAbort
        self.canFetchRaw = canFetchRaw
        self.canOpenTerminal = canOpenTerminal
        self.supportsExtensionUI = supportsExtensionUI
    }
}

public struct AgentSessionSummary: Codable, Equatable, Sendable {
    public let sessionId: String
    public let source: String
    public let title: String
    public let lastEventAt: Double
    public let activity: String
    public let capabilities: AgentSessionCapabilities

    public enum CodingKeys: String, CodingKey {
        case sessionId = "sid"
        case source = "src"
        case title = "ttl"
        case lastEventAt = "lea"
        case activity = "ac"
        case capabilities = "cap"
    }

    public init(sessionId: String, source: String, title: String, lastEventAt: Double, activity: String, capabilities: AgentSessionCapabilities) {
        self.sessionId = sessionId
        self.source = source
        self.title = title
        self.lastEventAt = lastEventAt
        self.activity = activity
        self.capabilities = capabilities
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
    /// Which view to stream. Absent means `raw`, the fidelity view, which is also what every caller
    /// meant before modes existed.
    public let mode: String?
    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case source = "src"
        case sessionId = "sid"
        case mode = "md"
    }
    public init(source: String, sessionId: String, mode: String? = nil) {
        self.source = source
        self.sessionId = sessionId
        self.mode = mode
    }
}

public struct AgentThreadLoadOlder: Codable, Equatable, Sendable {
    public let type = "agent-thread-older"
    public let source: String
    public let sessionId: String
    public let beforeIndex: Int
    public let limit: Int
    /// Which view `beforeIndex` is counted in. Absent means `raw`.
    public let mode: String?
    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case source = "src"
        case sessionId = "sid"
        case beforeIndex = "bi"
        case limit = "lim"
        case mode = "md"
    }
    public init(source: String, sessionId: String, beforeIndex: Int, limit: Int, mode: String? = nil) {
        self.source = source
        self.sessionId = sessionId
        self.beforeIndex = beforeIndex
        self.limit = limit
        self.mode = mode
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
    /// Session occupancy as of this chunk. Carried on the chunk rather than on each event because it
    /// is session state, and the chunk stream already fires per event, so the meter updates live
    /// without a message type of its own. Nil when the transcript has published no occupancy yet.
    public let usage: TokenUsage?
    /// The view this chunk answers, so the panel can discard one that is still in flight from the mode
    /// it just left. Without it, indices counted in the old view would merge into the new one and every
    /// row would be off. Absent means `raw`.
    public let mode: String?
    public let kind: String
    public let sequence: Int
    public let runState: String?
    public let queueSteer: Int
    public let queueFollowUp: Int
    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case source = "src"
        case sessionId = "sid"
        case events = "ev"
        case windowStart = "ws"
        case total = "tot"
        case isLive = "lv"
        case usage = "u"
        case mode = "md"
        case kind = "k"
        case sequence = "seq"
        case runState = "rs"
        case queueSteer = "qs"
        case queueFollowUp = "qf"
    }
    public init(
        source: String,
        sessionId: String,
        events: [ActivityEvent],
        windowStart: Int,
        total: Int,
        isLive: Bool,
        usage: TokenUsage? = nil,
        mode: String? = nil,
        kind: String,
        sequence: Int,
        runState: String? = nil,
        queueSteer: Int = 0,
        queueFollowUp: Int = 0
    ) {
        self.source = source
        self.sessionId = sessionId
        self.events = events
        self.windowStart = windowStart
        self.total = total
        self.isLive = isLive
        self.usage = usage
        self.mode = mode
        self.kind = kind
        self.sequence = sequence
        self.runState = runState
        self.queueSteer = queueSteer
        self.queueFollowUp = queueFollowUp
    }
}

public struct AgentSessionCreate: Codable, Equatable, Sendable {
    public let type = "agent-session-create"
    public let requestId: String
    public let source: String
    public let projectPath: String
    public enum CodingKeys: String, CodingKey { case type = "t"; case requestId = "rid"; case source = "src"; case projectPath = "pp" }
    public init(requestId: String, source: String, projectPath: String) { self.requestId = requestId; self.source = source; self.projectPath = projectPath }
}

public struct AgentSessionSend: Codable, Equatable, Sendable {
    public let type = "agent-session-send"
    public let requestId: String
    public let source: String
    public let sessionId: String
    public let text: String
    public let delivery: String
    public enum CodingKeys: String, CodingKey { case type = "t"; case requestId = "rid"; case source = "src"; case sessionId = "sid"; case text = "tx"; case delivery = "del" }
    public init(requestId: String, source: String, sessionId: String, text: String, delivery: String) { self.requestId = requestId; self.source = source; self.sessionId = sessionId; self.text = text; self.delivery = delivery }
}

public struct AgentSessionAbort: Codable, Equatable, Sendable {
    public let type = "agent-session-abort"
    public let requestId: String
    public let source: String
    public let sessionId: String
    public enum CodingKeys: String, CodingKey { case type = "t"; case requestId = "rid"; case source = "src"; case sessionId = "sid" }
    public init(requestId: String, source: String, sessionId: String) { self.requestId = requestId; self.source = source; self.sessionId = sessionId }
}

public struct AgentCommandReceipt: Codable, Equatable, Sendable {
    public let type = "agent-command-receipt"
    public let requestId: String
    public let source: String
    public let sessionId: String
    public let delivery: String
    public enum CodingKeys: String, CodingKey { case type = "t"; case requestId = "rid"; case source = "src"; case sessionId = "sid"; case delivery = "del" }
    public init(requestId: String, source: String, sessionId: String, delivery: String) { self.requestId = requestId; self.source = source; self.sessionId = sessionId; self.delivery = delivery }
}

public struct AgentCommandError: Codable, Equatable, Sendable {
    public let type = "agent-command-error"
    public let requestId: String
    public let code: String
    public let message: String
    public let retryable: Bool
    public enum CodingKeys: String, CodingKey { case type = "t"; case requestId = "rid"; case code = "c"; case message = "m"; case retryable = "rt" }
    public init(requestId: String, code: String, message: String, retryable: Bool) { self.requestId = requestId; self.code = code; self.message = message; self.retryable = retryable }
}

public struct AgentExtensionUIRequest: Codable, Equatable, Sendable {
    public let type = "agent-extension-ui-request"
    public let source: String
    public let sessionId: String
    public let requestId: String
    public let kind: String
    public let title: String?
    public let message: String?
    public let options: [String]?
    public let placeholder: String?
    public let prefill: String?
    public let level: String?
    public let key: String?
    public let lines: [String]?
    public let expectsResponse: Bool
    public enum CodingKeys: String, CodingKey { case type = "t"; case source = "src"; case sessionId = "sid"; case requestId = "rid"; case kind = "k"; case title = "ttl"; case message = "m"; case options = "o"; case placeholder = "ph"; case prefill = "pf"; case level = "lv"; case key; case lines = "ln"; case expectsResponse = "er" }
    public init(source: String, sessionId: String, requestId: String, kind: String, title: String? = nil, message: String? = nil, options: [String]? = nil, placeholder: String? = nil, prefill: String? = nil, level: String? = nil, key: String? = nil, lines: [String]? = nil, expectsResponse: Bool) {
        self.source = source
        self.sessionId = sessionId
        self.requestId = requestId
        self.kind = kind
        self.title = title
        self.message = message
        self.options = options
        self.placeholder = placeholder
        self.prefill = prefill
        self.level = level
        self.key = key
        self.lines = lines
        self.expectsResponse = expectsResponse
    }
}

public struct AgentExtensionUIResponse: Codable, Equatable, Sendable {
    public let type = "agent-extension-ui-response"
    public let source: String
    public let sessionId: String
    public let requestId: String
    public let value: AgentJSONValue
    public enum CodingKeys: String, CodingKey { case type = "t"; case source = "src"; case sessionId = "sid"; case requestId = "rid"; case value = "v" }
    public init(source: String, sessionId: String, requestId: String, value: AgentJSONValue) { self.source = source; self.sessionId = sessionId; self.requestId = requestId; self.value = value }
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
