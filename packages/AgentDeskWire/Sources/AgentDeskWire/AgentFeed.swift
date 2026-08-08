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
    /// Stable Anthropic message id (`msg_...`), shared between the durable
    /// transcript and the live mirror, used to hand a streaming tail off.
    public let messageId: String?

    public enum CodingKeys: String, CodingKey {
        case id = "id"
        case index = "i"
        case revision = "rev"
        case phase = "ph"
        case ts
        case type = "tp"
        case blocks = "b"
        case otherModeIndex = "xi"
        case messageId = "mid"
    }

    public init(
        id: String,
        index: Int,
        revision: Int,
        phase: String,
        ts: Double,
        type: String,
        blocks: [ActivityBlock],
        otherModeIndex: Int? = nil,
        messageId: String? = nil
    ) {
        self.id = id
        self.index = index
        self.revision = revision
        self.phase = phase
        self.ts = ts
        self.type = type
        self.blocks = blocks
        self.otherModeIndex = otherModeIndex
        self.messageId = messageId
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
    public let canStreamLive: Bool?

    public enum CodingKeys: String, CodingKey {
        case modes = "md"
        case canSend = "snd"
        case canSteer = "str"
        case canAbort = "abt"
        case canFetchRaw = "raw"
        case canOpenTerminal = "pty"
        case supportsExtensionUI = "xui"
        case canStreamLive = "csl"
    }

    public init(modes: [String], canSend: Bool, canSteer: Bool, canAbort: Bool, canFetchRaw: Bool, canOpenTerminal: Bool, supportsExtensionUI: Bool, canStreamLive: Bool? = nil) {
        self.modes = modes
        self.canSend = canSend
        self.canSteer = canSteer
        self.canAbort = canAbort
        self.canFetchRaw = canFetchRaw
        self.canOpenTerminal = canOpenTerminal
        self.supportsExtensionUI = supportsExtensionUI
        self.canStreamLive = canStreamLive
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

/// The in-flight assistant message streamed from the claude live mirror, shown
/// below the durable transcript rows until the transcript contains that message
/// (the panel hands the tail off by `messageId`). `event == nil` means the live
/// tail is over.
public struct AgentLiveTail: Codable, Equatable, Sendable {
    public let type = "agent-live-tail"
    public let source: String
    public let sessionId: String
    public let event: ActivityEvent?

    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case source = "src"
        case sessionId = "sid"
        case event = "ev"
    }

    public init(source: String, sessionId: String, event: ActivityEvent?) {
        self.source = source
        self.sessionId = sessionId
        self.event = event
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
    public let session: AgentSessionSummary?
    public enum CodingKeys: String, CodingKey { case type = "t"; case requestId = "rid"; case source = "src"; case sessionId = "sid"; case delivery = "del"; case session = "s" }
    public init(requestId: String, source: String, sessionId: String, delivery: String, session: AgentSessionSummary? = nil) {
        self.requestId = requestId
        self.source = source
        self.sessionId = sessionId
        self.delivery = delivery
        self.session = session
    }
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

public struct AgentExtensionUIDismissed: Codable, Equatable, Sendable {
    public let type = "agent-extension-ui-dismissed"
    public let source: String
    public let sessionId: String
    public let requestId: String
    public enum CodingKeys: String, CodingKey { case type = "t"; case source = "src"; case sessionId = "sid"; case requestId = "rid" }
    public init(source: String, sessionId: String, requestId: String) {
        self.source = source
        self.sessionId = sessionId
        self.requestId = requestId
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

// MARK: - Claude Desktop composer sync

/// Why a session's composer-sync field is unavailable, or why a write did not land.
///
/// Fixed codes rather than prose: the panel owns the wording, a code survives translation, and it greps
/// cleanly in host logs. Carried on the wire as a plain string so a code this peer does not recognize
/// degrades to "unavailable, reason unknown" instead of failing the whole message.
public enum AgentWindowInputReason: String, Error, Equatable, Sendable {
    /// No process anywhere carries `--resume=<sessionId>`, so the session is not open.
    case notRunning = "not-running"
    /// A resuming process exists, but every parent chain terminates at a shell or tmux rather than the
    /// Claude.app main binary. A terminal session has no window composer to write into.
    case terminalOnly = "terminal-only"
    /// Two or more Claude.app instances each hold this session. macOS reaches this state on its own:
    /// a second instance restores a session the first one already had, and each instance has its own
    /// window on its own Desktop. Reported rather than resolved, because picking one silently
    /// addresses the wrong window and the write looks successful right up until the text appears in
    /// the other Desktop's session.
    case multipleInstances = "multiple-instances"
    /// The chain reaches Claude.app, but WindowServer lists no window for that pid.
    case noWindow = "no-window"
    case accessibilityDenied = "ax-denied"
    /// The window materialized but exposed no `AXTextArea` described as `Prompt`. Deliberately fatal:
    /// writing into whatever text element happened to be first is worse than refusing.
    case composerMissing = "composer-missing"
    case moveFailed = "move-failed"
    /// The window mover is not installed or would not start. macOS has no public API for moving another
    /// application's window between Desktops (ADR-0059), so an off-Desktop composer is unreachable
    /// without it. Separate from `moveFailed` because nothing about retrying will help.
    case windowMoverUnavailable = "window-mover-unavailable"
    case writeFailed = "write-failed"
    /// The composer read back as something other than what was written.
    case verifyMismatch = "verify-mismatch"
    /// The Space authority could not resolve Desktops, so no move can be attempted or verified.
    case placementUnavailable = "placement-unavailable"
    /// The frontmost application changed across the write. The write is non-activating by
    /// construction, so this reports a broken assumption rather than a recoverable failure: it cannot
    /// be undone, and it is the signal that this approach is wrong on the current macOS.
    case focusStolen = "focus-stolen"
    /// A Codex Desktop session resolved to more than one open window (same thread title and same
    /// project, usually a thread that has not received its first message yet). Refused rather than
    /// guessed: writing into the wrong window is indistinguishable from a correct write until the
    /// text lands in the other session.
    case ambiguousWindow = "ambiguous-window"
    /// A question action found no AskUserQuestion panel in the window -- it vanished between the
    /// transcript signal and the press, or was answered in the real window first.
    case questionMissing = "question-missing"
}

public struct AgentWindowInputWatch: Codable, Equatable, Sendable {
    public let type = "agent-window-input-watch"
    public let subscriptionId: String
    public let sessionId: String
    public enum CodingKeys: String, CodingKey { case type = "t"; case subscriptionId = "sub"; case sessionId = "sid" }
    public init(subscriptionId: String, sessionId: String) {
        self.subscriptionId = subscriptionId
        self.sessionId = sessionId
    }
}

public struct AgentWindowInputUnwatch: Codable, Equatable, Sendable {
    public let type = "agent-window-input-unwatch"
    public let subscriptionId: String
    public enum CodingKeys: String, CodingKey { case type = "t"; case subscriptionId = "sub" }
    public init(subscriptionId: String) { self.subscriptionId = subscriptionId }
}

public struct AgentWindowInputStatus: Codable, Equatable, Sendable {
    public let type = "agent-window-input-status"
    public let subscriptionId: String
    public let sessionId: String
    public let enabled: Bool
    /// An `AgentWindowInputReason` raw value when `enabled` is false; nil when the field is usable.
    public let reason: String?
    /// True when the owning window already sits on the active Desktop, so reading or writing its composer
    /// costs no Space move. The panel prefills only in that case and otherwise offers an explicit load,
    /// because an automatic prefill would flash a foreign window onto the viewer's Desktop on every
    /// session click.
    public let onActiveDesktop: Bool
    /// The composer's current text, present only when it was read without moving anything.
    public let composerText: String?
    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case subscriptionId = "sub"
        case sessionId = "sid"
        case enabled = "en"
        case reason = "r"
        case onActiveDesktop = "cur"
        case composerText = "tx"
    }
    public init(
        subscriptionId: String,
        sessionId: String,
        enabled: Bool,
        reason: String? = nil,
        onActiveDesktop: Bool = false,
        composerText: String? = nil
    ) {
        self.subscriptionId = subscriptionId
        self.sessionId = sessionId
        self.enabled = enabled
        self.reason = reason
        self.onActiveDesktop = onActiveDesktop
        self.composerText = composerText
    }
}

/// Write `text` into the session's Claude Desktop composer. Fill only: the panel never submits, so the
/// human still presses Return in the real window and can edit before they do.
public struct AgentWindowInputSync: Codable, Equatable, Sendable {
    public let type = "agent-window-input-sync"
    public let requestId: String
    public let sessionId: String
    public let text: String
    public enum CodingKeys: String, CodingKey { case type = "t"; case requestId = "rid"; case sessionId = "sid"; case text = "tx" }
    public init(requestId: String, sessionId: String, text: String) {
        self.requestId = requestId
        self.sessionId = sessionId
        self.text = text
    }
}

/// Fill the session's composer with `text` and press Return, committing the prompt in Claude Desktop.
///
/// Unlike `AgentWindowInputSync`, this actually sends: the writer fills the real composer and presses
/// Return in the owning window, so the prompt runs. The result reads back the composer value observed
/// AFTER the send, which is expected to be the cleared field. This deliberately activates the owning
/// window -- committing a prompt is the user asking for it -- so the non-activating guarantees of the
/// sync path do not apply here.
public struct AgentWindowInputSubmit: Codable, Equatable, Sendable {
    public let type = "agent-window-input-submit"
    public let requestId: String
    public let sessionId: String
    public let text: String
    public enum CodingKeys: String, CodingKey { case type = "t"; case requestId = "rid"; case sessionId = "sid"; case text = "tx" }
    public init(requestId: String, sessionId: String, text: String) {
        self.requestId = requestId
        self.sessionId = sessionId
        self.text = text
    }
}

/// Read the session composer's current text, moving the window if it is not already on the active
/// Desktop. Explicit because that move is visible; the free case is answered by `AgentWindowInputStatus`.
public struct AgentWindowInputRead: Codable, Equatable, Sendable {
    public let type = "agent-window-input-read"
    public let requestId: String
    public let sessionId: String
    public enum CodingKeys: String, CodingKey { case type = "t"; case requestId = "rid"; case sessionId = "sid" }
    public init(requestId: String, sessionId: String) {
        self.requestId = requestId
        self.sessionId = sessionId
    }
}

/// The outcome of a sync or a read. `text` is the composer value observed AFTER the operation, which is
/// the read-back that proves a write landed as well as the answer to a read.
public struct AgentWindowInputResult: Codable, Equatable, Sendable {
    public let type = "agent-window-input-result"
    public let requestId: String
    public let sessionId: String
    public let ok: Bool
    /// An `AgentWindowInputReason` raw value when `ok` is false.
    public let reason: String?
    public let text: String?
    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case requestId = "rid"
        case sessionId = "sid"
        case ok
        case reason = "r"
        case text = "tx"
    }
    public init(requestId: String, sessionId: String, ok: Bool, reason: String? = nil, text: String? = nil) {
        self.requestId = requestId
        self.sessionId = sessionId
        self.ok = ok
        self.reason = reason
        self.text = text
    }
}

// MARK: - Claude Desktop AskUserQuestion mirror

/// The interaction a panel wants performed against the AskUserQuestion panel in a Claude Desktop window.
///
/// The mirror's CONTENT never travels on this frame: the question text, option labels, and multi-select
/// shape come from the transcript/live feed, where the `AskUserQuestion` tool_use already carries its
/// full input JSON. AX is only the actuator, so the wire stays a list of actions plus the post-action
/// read-back state.
public enum AgentWindowQuestionActionKind: String, Codable, Equatable, Sendable {
    /// Press (or un-press, per `desired`) one option. Single-select options are buttons whose press
    /// selects; multi-select options are checkboxes whose press toggles. The host presses only when the
    /// element's current state differs from `desired`, so retrying an action is idempotent.
    case select
    /// Type into the panel's "Other" input. The host also checks the Other affordance when unchecked.
    case other
    case submit
    case skip
    case dismiss
    case viewOptions = "view-options"
}

/// Subscribe to one session's AskUserQuestion panel state. Same focus-gated discipline as the composer
/// watch: only a panel the user is looking at keeps the host's poll and AX traffic alive.
public struct AgentWindowQuestionWatch: Codable, Equatable, Sendable {
    public let type = "agent-window-question-watch"
    public let subscriptionId: String
    public let sessionId: String
    public enum CodingKeys: String, CodingKey { case type = "t"; case subscriptionId = "sub"; case sessionId = "sid" }
    public init(subscriptionId: String, sessionId: String) {
        self.subscriptionId = subscriptionId
        self.sessionId = sessionId
    }
}

public struct AgentWindowQuestionUnwatch: Codable, Equatable, Sendable {
    public let type = "agent-window-question-unwatch"
    public let subscriptionId: String
    public enum CodingKeys: String, CodingKey { case type = "t"; case subscriptionId = "sub" }
    public init(subscriptionId: String) { self.subscriptionId = subscriptionId }
}

/// What the host currently observes in the session's Claude Desktop window, on top of the JSON the
/// panel already holds. Content is deliberately absent: the mirror renders the transcript's
/// `AskUserQuestion` tool_use and consults this only for live state and lifecycle.
public struct AgentWindowQuestionStatus: Codable, Equatable, Sendable {
    public let type = "agent-window-question-status"
    public let subscriptionId: String
    public let sessionId: String
    /// Whether the host can reach the window at all; false carries `reason`.
    public let enabled: Bool
    /// An `AgentWindowInputReason` raw value when `enabled` is false.
    public let reason: String?
    /// True when the owning window already sits on the active Desktop, so AX reads cost no Space move.
    public let onActiveDesktop: Bool
    /// Whether an AskUserQuestion panel is present in the window's accessibility tree. nil when the
    /// window is on another Desktop, where Chromium builds no tree to read.
    public let present: Bool?
    /// Indices (into the JSON `options` array) of the options currently selected/checked in the panel.
    /// Empty when nothing is selected or the state cannot be read.
    public let selected: [Int]
    /// The panel's "Other" input value, nil when unreadable.
    public let otherText: String?
    /// The panel's Submit button enabled state, nil when unreadable.
    public let submitEnabled: Bool?
    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case subscriptionId = "sub"
        case sessionId = "sid"
        case enabled = "en"
        case reason = "r"
        case onActiveDesktop = "cur"
        case present = "pr"
        case selected = "sel"
        case otherText = "oth"
        case submitEnabled = "sb"
    }
    public init(
        subscriptionId: String,
        sessionId: String,
        enabled: Bool,
        reason: String? = nil,
        onActiveDesktop: Bool = false,
        present: Bool? = nil,
        selected: [Int] = [],
        otherText: String? = nil,
        submitEnabled: Bool? = nil
    ) {
        self.subscriptionId = subscriptionId
        self.sessionId = sessionId
        self.enabled = enabled
        self.reason = reason
        self.onActiveDesktop = onActiveDesktop
        self.present = present
        self.selected = selected
        self.otherText = otherText
        self.submitEnabled = submitEnabled
    }
}

/// One interaction with the session's AskUserQuestion panel in Claude Desktop.
///
/// An action is an explicit user request, so like a composer submit it may bring the window onto the
/// active Desktop and put it back (the AX tree for another Desktop's window does not exist). The reply
/// is `AgentWindowQuestionResult` carrying the state read after the action, which is how the mirror
/// learns the press landed -- and, for submit/skip/dismiss, that the panel is gone.
public struct AgentWindowQuestionAction: Codable, Equatable, Sendable {
    public let type = "agent-window-question-action"
    public let requestId: String
    public let sessionId: String
    public let kind: String
    /// The option index into the JSON `options` array; required by `select`.
    public let optionIndex: Int?
    /// The desired checked state for `select`: 1 checks (presses an unchecked element), 0 unchecks
    /// (presses a checked multi-select checkbox). Single-select options cannot be un-pressed, so 0 is a
    /// no-op there. Required by `select`.
    public let desired: Int?
    /// The "Other" answer text; required by `other`. Bounded like a composer sync, because it is written
    /// verbatim into another application's text field.
    public let text: String?
    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case requestId = "rid"
        case sessionId = "sid"
        case kind = "k"
        case optionIndex = "oi"
        case desired = "v"
        case text = "tx"
    }
    public init(
        requestId: String,
        sessionId: String,
        kind: String,
        optionIndex: Int? = nil,
        desired: Int? = nil,
        text: String? = nil
    ) {
        self.requestId = requestId
        self.sessionId = sessionId
        self.kind = kind
        self.optionIndex = optionIndex
        self.desired = desired
        self.text = text
    }
}

/// The outcome of a question action, plus the panel state read immediately after it.
public struct AgentWindowQuestionResult: Codable, Equatable, Sendable {
    public let type = "agent-window-question-result"
    public let requestId: String
    public let sessionId: String
    public let ok: Bool
    /// An `AgentWindowInputReason` raw value when `ok` is false.
    public let reason: String?
    public let present: Bool?
    public let selected: [Int]
    public let otherText: String?
    public let submitEnabled: Bool?
    public enum CodingKeys: String, CodingKey {
        case type = "t"
        case requestId = "rid"
        case sessionId = "sid"
        case ok
        case reason = "r"
        case present = "pr"
        case selected = "sel"
        case otherText = "oth"
        case submitEnabled = "sb"
    }
    public init(
        requestId: String,
        sessionId: String,
        ok: Bool,
        reason: String? = nil,
        present: Bool? = nil,
        selected: [Int] = [],
        otherText: String? = nil,
        submitEnabled: Bool? = nil
    ) {
        self.requestId = requestId
        self.sessionId = sessionId
        self.ok = ok
        self.reason = reason
        self.present = present
        self.selected = selected
        self.otherText = otherText
        self.submitEnabled = submitEnabled
    }
}
