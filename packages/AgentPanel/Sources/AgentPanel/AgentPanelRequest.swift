import Foundation

public enum AgentPanelTerminalSource: String, Equatable, Sendable {
    case claude
    case codex
}

public struct AgentPanelTerminalContext: Equatable, Sendable {
    public let projectPath: String
    public let source: AgentPanelTerminalSource
    public let sessionID: String

    public init(projectPath: String, source: AgentPanelTerminalSource, sessionID: String) {
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
    case threadSubscribe(source: String, sessionId: String)
    case threadLoadOlder(source: String, sessionId: String, beforeIndex: Int, limit: Int)
    case threadUnsubscribe(source: String, sessionId: String)
    case rawEvent(requestId: String, source: String, sessionId: String, eventIndex: Int)
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
            guard let source = agentSource(body["src"]),
                  let sessionId = nonemptyString(body["sid"]),
                  let beforeIndex = body["bi"] as? Int,
                  let limit = body["lim"] as? Int else {
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

    private static func agentSource(_ value: Any?) -> String? {
        guard let value = nonemptyString(value), value == "claude" || value == "codex" else {
            return nil
        }
        return value
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
              let rawSource = rawContext["src"] as? String,
              let source = AgentPanelTerminalSource(rawValue: rawSource),
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
