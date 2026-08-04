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
            guard let subscriptionId = nonemptyString(body["sub"]),
                  let sessionId = sessionIdentifier(body["sid"]) else { return nil }
            return .windowInputWatch(subscriptionId: subscriptionId, sessionId: sessionId)
        case "agent-window-input-unwatch":
            guard let subscriptionId = nonemptyString(body["sub"]) else { return nil }
            return .windowInputUnwatch(subscriptionId: subscriptionId)
        case "agent-window-input-sync":
            // Empty text is ALLOWED here, unlike `agent-session-send`: clearing the composer is a real
            // intent, where sending an empty prompt is not. The cap exists because this string is written
            // verbatim into another application's text field.
            guard let requestId = requestIdentifier(body["rid"]),
                  let sessionId = sessionIdentifier(body["sid"]),
                  let text = body["tx"] as? String,
                  text.count <= composerTextLimit else { return nil }
            return .windowInputSync(requestId: requestId, sessionId: sessionId, text: text)
        case "agent-window-input-read":
            guard let requestId = requestIdentifier(body["rid"]),
                  let sessionId = sessionIdentifier(body["sid"]) else { return nil }
            return .windowInputRead(requestId: requestId, sessionId: sessionId)
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
        guard let value = nonemptyString(value), value.count <= 128,
              value.range(of: #"^[A-Za-z0-9._:-]+$"#, options: .regularExpression) != nil else {
            return nil
        }
        return value
    }

    /// Longest composer text the panel may push into a Claude Desktop window.
    ///
    /// Not a protocol limit but a blast-radius one: unlike every other request here, this string is set
    /// verbatim as another application's text-field value, so an unbounded one is a way to wedge that app
    /// rather than merely to send a large prompt.
    static let composerTextLimit = 100_000

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

@MainActor
public protocol AgentPanelTransport: AnyObject {
    func sendAgentPanelRequest(_ request: AgentPanelRequest)
}
