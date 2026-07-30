import Foundation

/// The harness a request addresses. One validated type for every source-carrying request, terminal
/// intents included: the decoder is the only boundary between webview-supplied text and the host's
/// transcript and PTY paths, so an unrecognized harness has to die here rather than travel as a
/// string that each consumer re-checks (or forgets to).
public enum AgentPanelAgentSource: String, Equatable, Sendable {
    case claude
    case codex
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
    case threadSubscribe(source: AgentPanelAgentSource, sessionId: String)
    case threadLoadOlder(source: AgentPanelAgentSource, sessionId: String, beforeIndex: Int, limit: Int)
    case threadUnsubscribe(source: AgentPanelAgentSource, sessionId: String)
    case rawEvent(requestId: String, source: AgentPanelAgentSource, sessionId: String, eventIndex: Int)
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
                  let sessionId = nonemptyString(body["sid"]) else { return nil }
            return .threadSubscribe(source: source, sessionId: sessionId)
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
                  limit >= 1 else {
                return nil
            }
            return .threadLoadOlder(source: source, sessionId: sessionId, beforeIndex: beforeIndex, limit: limit)
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
                  eventIndex >= 0 else {
                return nil
            }
            return .rawEvent(requestId: requestId, source: source, sessionId: sessionId, eventIndex: eventIndex)
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
