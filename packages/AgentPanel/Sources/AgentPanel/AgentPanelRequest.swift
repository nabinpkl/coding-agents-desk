import Foundation

/// Terminal sources remain closed because they select executable argv. Feed sources are separately
/// validated bounded strings so a registered provider such as Pi cannot gain PTY authority.
public enum AgentPanelAgentSource: String, Equatable, Sendable {
    case claude
    case codex
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
    /// One request against the agent-feed sidecar, relayed verbatim.
    ///
    /// This case names no endpoint and no field, which is the point: the sidecar owns the
    /// model and the panel owns the view, and adding a field to either is not a change to
    /// this enum. What travels is a path and, for a POST, an already-serialized body.
    ///
    /// The path is NOT vetted here. `AgentFeedRelay.PathPolicy` is the single allow-list
    /// and the security boundary; a second copy in this decoder would be free to disagree
    /// with the one that actually executes the request.
    case httpRequest(rid: String, method: String, path: String, body: String?, stream: Bool)
    /// Abandons an in-flight relayed request, including a subscription. Replaces every
    /// per-type unwatch the feed used to carry.
    case httpCancel(rid: String)
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
        case "agent-http-req":
            // Shape only. The body is passed through as the panel serialized it, and the
            // path is checked by the relay, which is the one place that can be right about
            // what a path may address.
            guard let rid = requestIdentifier(body["rid"]),
                  let method = nonemptyString(body["method"]),
                  let path = nonemptyString(body["path"]) else { return nil }
            let requestBody = body["body"] as? String
            return .httpRequest(
                rid: rid,
                method: method,
                path: path,
                body: requestBody,
                stream: body["stream"] as? Bool ?? false
            )
        case "agent-http-cancel":
            guard let rid = requestIdentifier(body["rid"]) else { return nil }
            return .httpCancel(rid: rid)
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

    private static func requestIdentifier(_ value: Any?) -> String? {
        guard let value = nonemptyString(value) else { return nil }
        return AgentPanelWindowInputBounds.identifier(value)
    }

    /// A session id used to ADDRESS A WINDOW, rather than to name a sidecar transcript.
    ///
    /// A relayed request carries whatever id the sidecar validates for itself. This one is compared
    /// against the live process table to find the window that owns the session, so it is bounded and
    /// charset-restricted here: an unbounded value would be scanned against every process's argv on
    /// every re-resolve.
    private static func sessionIdentifier(_ value: Any?) -> String? {
        requestIdentifier(value)
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
