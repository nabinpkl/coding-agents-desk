import Foundation

// What still lives here after the agent-feed payloads left.
//
// The feed's model used to be restated in this file in abbreviated keys, renamed into and out of a
// second Swift restatement of the same shapes, and mirrored again in TypeScript on both ends. The
// sidecar owns that model now and it travels as an opaque body through `AgentFeedRelayFrames`, so
// there is nothing here to keep in step with it.
//
// What remains is native authority: the Claude Desktop composer sync and the AskUserQuestion mirror
// write into another application's window through Accessibility, and `SessionRevoke` ends a session.
// Those are bounded, typed, and rarely changed on purpose -- editing them SHOULD cost a Swift
// compile, because each one is a capability rather than a view of data the sidecar already owns.

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
    /// The current macOS build does not expose the private bridged operation for moving another
    /// application's window between Desktops. Separate from `moveFailed` because retrying cannot
    /// restore an unavailable native capability.
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
