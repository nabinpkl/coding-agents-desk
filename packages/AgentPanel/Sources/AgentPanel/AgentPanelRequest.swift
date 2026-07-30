import Foundation

/// The harness a request addresses. One validated type for every source-carrying request, terminal
/// intents included: the decoder is the only boundary between webview-supplied text and the host's
/// transcript and PTY paths, so an unrecognized harness has to die here rather than travel as a
/// string that each consumer re-checks (or forgets to).
public enum AgentPanelAgentSource: String, Equatable, Sendable {
    case claude
    case codex
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
    case threadSubscribe(source: AgentPanelAgentSource, sessionId: String, mode: AgentPanelEventMode)
    case threadLoadOlder(
        source: AgentPanelAgentSource,
        sessionId: String,
        beforeIndex: Int,
        limit: Int,
        mode: AgentPanelEventMode
    )
    case threadUnsubscribe(source: AgentPanelAgentSource, sessionId: String)
    case rawEvent(
        requestId: String,
        source: AgentPanelAgentSource,
        sessionId: String,
        eventIndex: Int,
        mode: AgentPanelEventMode
    )
    case terminal(AgentPanelTerminalIntent)

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
            guard let source = agentSource(body["src"]),
                  let sessionId = nonemptyString(body["sid"]),
                  let mode = eventMode(body["md"]) else { return nil }
            return .threadSubscribe(source: source, sessionId: sessionId, mode: mode)
        case "agent-thread-older":
            // Both bounds are enforced here because the host derives the sidecar page from them as
            // `offset = max(0, bi - lim)` / `limit = bi - offset`. A negative `bi` or a non-positive
            // `lim` therefore produces a negative sidecar limit, which comes back as an HTTP 400 the
            // panel surfaces as a thread error. The window the page can cover is still bounded
            // downstream by `bi` and the sidecar's own limit cap, so no upper bound belongs here.
            guard let source = agentSource(body["src"]),
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
            guard let source = agentSource(body["src"]),
                  let sessionId = nonemptyString(body["sid"]) else {
                return nil
            }
            return .threadUnsubscribe(source: source, sessionId: sessionId)
        case "agent-raw-event-get":
            guard let requestId = body["rid"] as? String,
                  !requestId.isEmpty,
                  let source = agentSource(body["src"]),
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
