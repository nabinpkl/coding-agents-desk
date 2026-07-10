import Foundation

public enum AgentPanelRequest: Equatable, Sendable {
    case projectsSubscribe
    case threadSubscribe(projectPath: String?, source: String?, sessionId: String?)
    case threadLoadOlder(sessionId: String, beforeIndex: Int, limit: Int)
    case threadUnsubscribe(sessionId: String)

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
        default:
            return nil
        }
    }
}

@MainActor
public protocol AgentPanelTransport: AnyObject {
    func sendAgentPanelRequest(_ request: AgentPanelRequest)
}
