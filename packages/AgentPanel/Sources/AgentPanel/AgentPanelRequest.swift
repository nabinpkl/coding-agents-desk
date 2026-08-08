import Foundation

/// Terminal sources remain closed because they select executable argv. Feed sources are separately
/// validated bounded strings so a registered provider such as Pi cannot gain PTY authority.
public enum AgentPanelAgentSource: String, Equatable, Sendable {
    case claude
    case codex
}

public enum AgentPanelUIValue: Equatable, Sendable {
    case null
    case bool(Bool)
    case string(String)
}

/// The interaction a panel wants performed against the AskUserQuestion panel in a Claude Desktop window.
///
/// Mirrors `AgentWindowQuestionActionKind` on the wire; the webview decoder validates the raw string so
/// a frame this build does not recognize is rejected rather than misacted. The mirror's CONTENT never
/// travels on any of these: it comes from the transcript feed, where the `AskUserQuestion` tool_use
/// already carries the full question JSON.
public enum AgentPanelQuestionActionKind: String, Equatable, Sendable {
    case select
    case other
    case submit
    case skip
    case dismiss
    case viewOptions = "view-options"
}

/// Which view of a transcript a request addresses: `raw` is every line in file order, `nice` is
/// content lines only, renumbered contiguously.
///
/// Validated at the decoder for the same reason as the harness name, and with more at stake: an
/// event index is mode-relative, so the SAME integer names a different line in the two views.
/// Defaulting an unrecognized value to `raw` would answer a nice-mode request with raw-mode indices,
/// and every index in the reply would address the wrong line with nothing to signal it.
public enum AgentPanelEventMode: String, Equatable, Sendable {
    case raw
    case nice
}

public struct AgentPanelTerminalContext: Equatable, Sendable {
    public let projectPath: String
    public let source: AgentPanelAgentSource
    public let sessionID: String

    public init(projectPath: String, source: AgentPanelAgentSource, sessionID: String) {
        self.projectPath = projectPath
        self.source = source
        self.sessionID = sessionID
    }
}

public enum AgentPanelTerminalIntent: Equatable, Sendable {
    case open(requestID: String, context: AgentPanelTerminalContext)
    case close(requestID: String, context: AgentPanelTerminalContext)
    case contextEnded(requestID: String, context: AgentPanelTerminalContext)
}

public enum AgentPanelRequest: Equatable, Sendable {
    case projectsWatch(subscriptionId: String)
    case projectsUnwatch(subscriptionId: String)
    case projectSessionsWatch(subscriptionId: String, projectPath: String)
    case projectSessionsUnwatch(subscriptionId: String)
    case threadSubscribe(source: String, sessionId: String, mode: AgentPanelEventMode)
    case threadLoadOlder(
        source: String,
        sessionId: String,
        beforeIndex: Int,
        limit: Int,
        mode: AgentPanelEventMode
    )
    case threadUnsubscribe(source: String, sessionId: String)
    case rawEvent(
        requestId: String,
        source: String,
        sessionId: String,
        eventIndex: Int,
        mode: AgentPanelEventMode
    )
    case createSession(requestId: String, source: String, projectPath: String)
    case send(requestId: String, source: String, sessionId: String, text: String, delivery: String)
    case abort(requestId: String, source: String, sessionId: String)
    case extensionUIResponse(source: String, sessionId: String, requestId: String, value: AgentPanelUIValue)
    case terminal(AgentPanelTerminalIntent)
    case windowInputWatch(subscriptionId: String, sessionId: String)
    case windowInputUnwatch(subscriptionId: String)
    case windowInputSync(requestId: String, sessionId: String, text: String)
    case windowInputRead(requestId: String, sessionId: String)
    /// Fills the composer and presses Return, committing the prompt in Claude Desktop. Unlike `sync`,
    /// this actually sends, so it activates (and fronts) the owning window. Bounded like a sync.
    case windowInputSubmit(requestId: String, sessionId: String, text: String)
    /// Subscribes to one session's AskUserQuestion panel state. Focus-gated like the composer watch:
    /// only a panel the user is looking at keeps the host's poll and AX traffic alive.
    case questionWatch(subscriptionId: String, sessionId: String)
    case questionUnwatch(subscriptionId: String)
    /// One interaction with the session's AskUserQuestion panel. Explicit user intent, so it may bring
    /// the window onto the active Desktop and put it back.
    case questionAction(
        requestId: String,
        sessionId: String,
        kind: AgentPanelQuestionActionKind,
        optionIndex: Int?,
        desired: Bool?,
        otherText: String?
    )

    public static func decode(tag: String, body: [String: Any]) -> AgentPanelRequest? {
        switch tag {
        case "agent-projects-watch":
            guard let subscriptionId = nonemptyString(body["sub"]) else { return nil }
            return .projectsWatch(subscriptionId: subscriptionId)
        case "agent-projects-unwatch":
            guard let subscriptionId = nonemptyString(body["sub"]) else { return nil }
            return .projectsUnwatch(subscriptionId: subscriptionId)
        case "agent-project-sessions-watch":
            guard let subscriptionId = nonemptyString(body["sub"]),
                  let projectPath = nonemptyString(body["pp"]) else { return nil }
            return .projectSessionsWatch(subscriptionId: subscriptionId, projectPath: projectPath)
        case "agent-project-sessions-unwatch":
            guard let subscriptionId = nonemptyString(body["sub"]) else { return nil }
            return .projectSessionsUnwatch(subscriptionId: subscriptionId)
        case "agent-thread-sub":
            guard let source = feedSource(body["src"]),
                  let sessionId = nonemptyString(body["sid"]),
                  let mode = eventMode(body["md"]) else { return nil }
            return .threadSubscribe(source: source, sessionId: sessionId, mode: mode)
        case "agent-thread-older":
            // Both bounds are enforced here because the host derives the sidecar page from them as
            // `offset = max(0, bi - lim)` / `limit = bi - offset`. A negative `bi` or a non-positive
            // `lim` therefore produces a negative sidecar limit, which comes back as an HTTP 400 the
            // panel surfaces as a thread error. The window the page can cover is still bounded
            // downstream by `bi` and the sidecar's own limit cap, so no upper bound belongs here.
            guard let source = feedSource(body["src"]),
                  let sessionId = nonemptyString(body["sid"]),
                  let beforeIndex = body["bi"] as? Int,
                  beforeIndex >= 0,
                  let limit = body["lim"] as? Int,
                  limit >= 1,
                  let mode = eventMode(body["md"]) else {
                return nil
            }
            return .threadLoadOlder(
                source: source,
                sessionId: sessionId,
                beforeIndex: beforeIndex,
                limit: limit,
                mode: mode
            )
        case "agent-thread-unsub":
            guard let source = feedSource(body["src"]),
                  let sessionId = nonemptyString(body["sid"]) else {
                return nil
            }
            return .threadUnsubscribe(source: source, sessionId: sessionId)
        case "agent-raw-event-get":
            guard let requestId = body["rid"] as? String,
                  !requestId.isEmpty,
                  let source = feedSource(body["src"]),
                  let sessionId = nonemptyString(body["sid"]),
                  let eventIndex = body["ei"] as? Int,
                  eventIndex >= 0,
                  let mode = eventMode(body["md"]) else {
                return nil
            }
            return .rawEvent(
                requestId: requestId,
                source: source,
                sessionId: sessionId,
                eventIndex: eventIndex,
                mode: mode
            )
        case "agent-session-create":
            guard let requestId = requestIdentifier(body["rid"]),
                  let source = feedSource(body["src"]),
                  let projectPath = nonemptyString(body["pp"]) else { return nil }
            return .createSession(requestId: requestId, source: source, projectPath: projectPath)
        case "agent-session-send":
            guard let requestId = requestIdentifier(body["rid"]),
                  let source = feedSource(body["src"]),
                  let sessionId = nonemptyString(body["sid"]),
                  let text = body["tx"] as? String,
                  !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  let delivery = body["del"] as? String,
                  delivery == "next" || delivery == "steer" else { return nil }
            return .send(requestId: requestId, source: source, sessionId: sessionId, text: text, delivery: delivery)
        case "agent-session-abort":
            guard let requestId = requestIdentifier(body["rid"]),
                  let source = feedSource(body["src"]),
                  let sessionId = nonemptyString(body["sid"]) else { return nil }
            return .abort(requestId: requestId, source: source, sessionId: sessionId)
        case "agent-extension-ui-response":
            guard let requestId = requestIdentifier(body["rid"]),
                  let source = feedSource(body["src"]),
                  let sessionId = nonemptyString(body["sid"]),
                  let value = uiValue(body["v"]) else { return nil }
            return .extensionUIResponse(source: source, sessionId: sessionId, requestId: requestId, value: value)
        case "agent-window-input-watch":
            // Bounded, unlike the sidecar watches above: this subscription id keys an entry in the
            // host's re-resolve loop, which scans the live process table on a timer until it is
            // unwatched. The other watches key a sidecar stream the sidecar bounds itself.
            guard let subscriptionId = requestIdentifier(body["sub"]),
                  let sessionId = sessionIdentifier(body["sid"]) else { return nil }
            return .windowInputWatch(subscriptionId: subscriptionId, sessionId: sessionId)
        case "agent-window-input-unwatch":
            guard let subscriptionId = requestIdentifier(body["sub"]) else { return nil }
            return .windowInputUnwatch(subscriptionId: subscriptionId)
        case "agent-window-input-sync":
            // Empty text is ALLOWED here, unlike `agent-session-send`: clearing the composer is a real
            // intent, where sending an empty prompt is not. The cap exists because this string is written
            // verbatim into another application's text field.
            guard let requestId = requestIdentifier(body["rid"]),
                  let sessionId = sessionIdentifier(body["sid"]),
                  let raw = body["tx"] as? String,
                  let text = AgentPanelWindowInputBounds.text(raw) else { return nil }
            return .windowInputSync(requestId: requestId, sessionId: sessionId, text: text)
        case "agent-window-input-read":
            guard let requestId = requestIdentifier(body["rid"]),
                  let sessionId = sessionIdentifier(body["sid"]) else { return nil }
            return .windowInputRead(requestId: requestId, sessionId: sessionId)
        case "agent-window-input-submit":
            // Same bounds as a sync: empty clears-then-sends nothing is a real intent, and the cap
            // exists because this string is written verbatim into another application's field.
            guard let requestId = requestIdentifier(body["rid"]),
                  let sessionId = sessionIdentifier(body["sid"]),
                  let raw = body["tx"] as? String,
                  let text = AgentPanelWindowInputBounds.text(raw) else { return nil }
            return .windowInputSubmit(requestId: requestId, sessionId: sessionId, text: text)
        case "agent-window-question-watch":
            guard let subscriptionId = requestIdentifier(body["sub"]),
                  let sessionId = sessionIdentifier(body["sid"]) else { return nil }
            return .questionWatch(subscriptionId: subscriptionId, sessionId: sessionId)
        case "agent-window-question-unwatch":
            guard let subscriptionId = requestIdentifier(body["sub"]) else { return nil }
            return .questionUnwatch(subscriptionId: subscriptionId)
        case "agent-window-question-action":
            // The option index addresses an element in ANOTHER application's window, so it is bounded
            // like every other identifier here rather than trusted from the wire. The desired state is
            // 0/1 only; the Other answer is written verbatim into the panel's text field, so it shares
            // the composer sync's blast-radius cap. Per-kind presence is enforced by the shared payload
            // validator, so `select` without an index and `submit` with a stray payload are both
            // rejected rather than misacted.
            guard let requestId = requestIdentifier(body["rid"]),
                  let sessionId = sessionIdentifier(body["sid"]),
                  let rawKind = body["k"] as? String,
                  let kind = AgentPanelQuestionActionKind(rawValue: rawKind) else { return nil }
            let optionIndex: Int?
            if let raw = body["oi"] as? Int, raw >= 0, raw < AgentPanelWindowInputBounds.maxQuestionOptions {
                optionIndex = raw
            } else if body["oi"] == nil {
                optionIndex = nil
            } else {
                return nil
            }
            let desired: Bool?
            if let raw = body["v"] as? Int, raw == 0 || raw == 1 {
                desired = raw == 1
            } else if body["v"] == nil {
                desired = nil
            } else {
                return nil
            }
            let otherText: String?
            if let raw = body["tx"] as? String {
                guard let text = AgentPanelWindowInputBounds.text(raw) else { return nil }
                otherText = text
            } else {
                otherText = nil
            }
            guard let payload = AgentPanelWindowInputBounds.questionActionPayload(
                kind: kind,
                optionIndex: optionIndex,
                desired: desired,
                otherText: otherText
            ) else { return nil }
            return .questionAction(
                requestId: requestId,
                sessionId: sessionId,
                kind: kind,
                optionIndex: payload.optionIndex,
                desired: payload.desired,
                otherText: payload.otherText
            )
        case "agent-terminal-open":
            return decodeTerminalIntent(body: body, make: AgentPanelTerminalIntent.open)
        case "agent-terminal-close":
            return decodeTerminalIntent(body: body, make: AgentPanelTerminalIntent.close)
        case "agent-terminal-context-ended":
            return decodeTerminalIntent(body: body, make: AgentPanelTerminalIntent.contextEnded)
        default:
            return nil
        }
    }

    private static func nonemptyString(_ value: Any?) -> String? {
        guard let value = value as? String, !value.isEmpty else { return nil }
        return value
    }

    private static func agentSource(_ value: Any?) -> AgentPanelAgentSource? {
        guard let value = nonemptyString(value) else { return nil }
        return AgentPanelAgentSource(rawValue: value)
    }

    private static func feedSource(_ value: Any?) -> String? {
        guard let value = nonemptyString(value),
              value.range(of: #"^[a-z][a-z0-9-]{0,31}$"#, options: .regularExpression) != nil else {
            return nil
        }
        return value
    }

    private static func requestIdentifier(_ value: Any?) -> String? {
        guard let value = nonemptyString(value) else { return nil }
        return AgentPanelWindowInputBounds.identifier(value)
    }

    /// A session id used to ADDRESS A WINDOW, rather than to name a sidecar transcript.
    ///
    /// The sidecar paths above accept any nonempty string because the sidecar validates its own ids. This
    /// one is compared against the live process table to find the window that owns the session, so it is
    /// bounded and charset-restricted here: an unbounded value would be scanned against every process's
    /// argv on every re-resolve.
    private static func sessionIdentifier(_ value: Any?) -> String? {
        requestIdentifier(value)
    }

    private static func uiValue(_ value: Any?) -> AgentPanelUIValue? {
        if value is NSNull { return .null }
        if let value = value as? Bool { return .bool(value) }
        if let value = value as? String { return .string(value) }
        return nil
    }

    /// An ABSENT mode means `raw`, which is the fidelity view and the behavior every caller had
    /// before modes existed. A PRESENT but unrecognized mode is rejected: the caller meant something
    /// specific and we cannot tell what, and guessing renumbers every index in the reply.
    private static func eventMode(_ value: Any?) -> AgentPanelEventMode? {
        guard let value else { return .raw }
        guard let raw = value as? String, !raw.isEmpty else { return nil }
        return AgentPanelEventMode(rawValue: raw)
    }

    private static func decodeTerminalIntent(
        body: [String: Any],
        make: (String, AgentPanelTerminalContext) -> AgentPanelTerminalIntent
    ) -> AgentPanelRequest? {
        guard let requestID = body["rid"] as? String,
              !requestID.isEmpty,
              let rawContext = body["ctx"] as? [String: Any],
              let projectPath = rawContext["pp"] as? String,
              !projectPath.isEmpty,
              let source = agentSource(rawContext["src"]),
              let sessionID = rawContext["sid"] as? String,
              !sessionID.isEmpty else {
            return nil
        }
        return .terminal(make(
            requestID,
            AgentPanelTerminalContext(
                projectPath: projectPath,
                source: source,
                sessionID: sessionID
            )
        ))
    }
}

/// The bounds every composer-sync field must satisfy, wherever it enters the host.
///
/// Public because `AgentPanelRequest.decode` is not the only door. The Mac Agents window posts these
/// requests as webview messages and they are bounded there; the phone posts the same four over the
/// authenticated QUIC lane, where they arrive as already-decoded wire structs that never touch the
/// decoder above. Both entry points call these, so a bound cannot hold on one surface and be skipped
/// on the other -- and the remote surface is the one that most needs it.
public enum AgentPanelWindowInputBounds {
    /// Longest composer text the panel may push into a Claude Desktop window.
    ///
    /// Not a protocol limit but a blast-radius one: unlike every other panel request, this string is set
    /// verbatim as another application's text-field value, so an unbounded one is a way to wedge that app
    /// rather than merely to send a large prompt.
    public static let textLimit = 100_000

    /// Upper bound (exclusive) for an AskUserQuestion option index. The index addresses an element in
    /// another application's window, so it is bounded here like every identifier that does.
    public static let maxQuestionOptions = 64

    /// A bounded, charset-restricted identifier. Applied to request ids everywhere, and to the session
    /// ids that address a window: those are compared against the live process table, so an unbounded
    /// value would be scanned against every process's argv on every re-resolve.
    public static func identifier(_ value: String) -> String? {
        guard !value.isEmpty, value.count <= 128,
              value.range(of: #"^[A-Za-z0-9._:-]+$"#, options: .regularExpression) != nil else {
            return nil
        }
        return value
    }

    /// Empty text is ALLOWED, unlike a session send: clearing the composer is a real intent, where
    /// sending an empty prompt is not.
    public static func text(_ value: String) -> String? {
        value.count <= textLimit ? value : nil
    }

    /// Per-kind validation of a question action's payload, shared by the webview decoder and the phone
    /// lane converter so the two doors cannot drift.
    ///
    /// `select` requires an option index in range and an explicit desired state; `other` requires the
    /// answer text (bounded by `text`); the button kinds take no payload at all. An `other` answer may
    /// be the empty string -- clearing the input is a real intent -- so presence, not content, is what
    /// is checked.
    public static func questionActionPayload(
        kind: AgentPanelQuestionActionKind,
        optionIndex: Int?,
        desired: Bool?,
        otherText: String?
    ) -> (optionIndex: Int?, desired: Bool?, otherText: String?)? {
        switch kind {
        case .select:
            guard let optionIndex, optionIndex >= 0, optionIndex < maxQuestionOptions, let desired else {
                return nil
            }
            return (optionIndex, desired, nil)
        case .other:
            guard let otherText else { return nil }
            return (nil, nil, otherText)
        case .submit, .skip, .dismiss, .viewOptions:
            guard optionIndex == nil, desired == nil, otherText == nil else { return nil }
            return (nil, nil, nil)
        }
    }
}

@MainActor
public protocol AgentPanelTransport: AnyObject {
    func sendAgentPanelRequest(_ request: AgentPanelRequest)
}
