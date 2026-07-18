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
    case projectsSubscribe
    case threadSubscribe(projectPath: String?, source: String?, sessionId: String?)
    case threadLoadOlder(sessionId: String, beforeIndex: Int, limit: Int)
    case threadUnsubscribe(sessionId: String)
    case terminal(AgentPanelTerminalIntent)

    public static func decode(tag: String, body: [String: Any]) -> AgentPanelRequest? {
        switch tag {
        case "agent-projects-sub":
            return .projectsSubscribe
        case "agent-thread-sub":
            let projectPath = body["pp"] as? String
            let source = body["src"] as? String
            let sessionId = body["sid"] as? String
            guard projectPath != nil || sessionId != nil else {
                return nil
            }
            return .threadSubscribe(projectPath: projectPath, source: source, sessionId: sessionId)
        case "agent-thread-older":
            guard let sessionId = body["sid"] as? String,
                  let beforeIndex = body["bi"] as? Int,
                  let limit = body["lim"] as? Int else {
                return nil
            }
            return .threadLoadOlder(sessionId: sessionId, beforeIndex: beforeIndex, limit: limit)
        case "agent-thread-unsub":
            guard let sessionId = body["sid"] as? String else {
                return nil
            }
            return .threadUnsubscribe(sessionId: sessionId)
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
