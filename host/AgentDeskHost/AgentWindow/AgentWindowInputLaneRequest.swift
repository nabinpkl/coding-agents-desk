import AgentDeskWire
import AgentPanel

/// Validates the phone lane's composer-sync frames into the panel request the coordinator consumes.
///
/// The Mac Agents window's requests are bounded by `AgentPanelRequest.decode`, which is the door its
/// webview messages come through. The phone's arrive already decoded as wire structs off the QUIC lane
/// and never touch that decoder, so without this they would reach the coordinator unbounded -- and the
/// phone is the surface that most needs the check, being the one that is not in this process. Both paths
/// call `AgentPanelWindowInputBounds`, so the rules cannot drift apart.
///
/// A rejected frame returns nil and is dropped with a log rather than answered with a failure result:
/// the identifiers a reply would be addressed by are the ones that just failed validation.
enum AgentWindowInputLaneRequest {
    static func watch(_ message: AgentWindowInputWatch) -> AgentPanelRequest? {
        guard let subscriptionId = AgentPanelWindowInputBounds.identifier(message.subscriptionId),
              let sessionId = AgentPanelWindowInputBounds.identifier(message.sessionId) else { return nil }
        return .windowInputWatch(subscriptionId: subscriptionId, sessionId: sessionId)
    }

    static func unwatch(_ message: AgentWindowInputUnwatch) -> AgentPanelRequest? {
        guard let subscriptionId = AgentPanelWindowInputBounds.identifier(message.subscriptionId) else {
            return nil
        }
        return .windowInputUnwatch(subscriptionId: subscriptionId)
    }

    static func sync(_ message: AgentWindowInputSync) -> AgentPanelRequest? {
        guard let requestId = AgentPanelWindowInputBounds.identifier(message.requestId),
              let sessionId = AgentPanelWindowInputBounds.identifier(message.sessionId),
              let text = AgentPanelWindowInputBounds.text(message.text) else { return nil }
        return .windowInputSync(requestId: requestId, sessionId: sessionId, text: text)
    }

    static func read(_ message: AgentWindowInputRead) -> AgentPanelRequest? {
        guard let requestId = AgentPanelWindowInputBounds.identifier(message.requestId),
              let sessionId = AgentPanelWindowInputBounds.identifier(message.sessionId) else { return nil }
        return .windowInputRead(requestId: requestId, sessionId: sessionId)
    }
}
