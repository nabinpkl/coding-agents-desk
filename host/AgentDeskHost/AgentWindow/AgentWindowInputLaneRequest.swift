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

    static func submit(_ message: AgentWindowInputSubmit) -> AgentPanelRequest? {
        guard let requestId = AgentPanelWindowInputBounds.identifier(message.requestId),
              let sessionId = AgentPanelWindowInputBounds.identifier(message.sessionId),
              let text = AgentPanelWindowInputBounds.text(message.text) else { return nil }
        return .windowInputSubmit(requestId: requestId, sessionId: sessionId, text: text)
    }

    static func questionWatch(_ message: AgentWindowQuestionWatch) -> AgentPanelRequest? {
        guard let subscriptionId = AgentPanelWindowInputBounds.identifier(message.subscriptionId),
              let sessionId = AgentPanelWindowInputBounds.identifier(message.sessionId) else { return nil }
        return .questionWatch(subscriptionId: subscriptionId, sessionId: sessionId)
    }

    static func questionUnwatch(_ message: AgentWindowQuestionUnwatch) -> AgentPanelRequest? {
        guard let subscriptionId = AgentPanelWindowInputBounds.identifier(message.subscriptionId) else {
            return nil
        }
        return .questionUnwatch(subscriptionId: subscriptionId)
    }

    static func questionAction(_ message: AgentWindowQuestionAction) -> AgentPanelRequest? {
        guard let requestId = AgentPanelWindowInputBounds.identifier(message.requestId),
              let sessionId = AgentPanelWindowInputBounds.identifier(message.sessionId),
              let kind = AgentPanelQuestionActionKind(rawValue: message.kind) else { return nil }
        // The wire's `desired` is a 0/1 integer because the panel speaks JSON booleans nowhere else on
        // this lane; the converter restores the panel's own boolean view. Per-kind presence and range
        // are enforced by the same payload validator the webview decoder uses, so the two doors cannot
        // drift.
        let optionIndex = message.optionIndex.flatMap { $0 >= 0 ? $0 : nil }
        let desired = message.desired.flatMap { $0 == 1 ? true : ($0 == 0 ? false : nil) }
        let otherText = message.text.flatMap(AgentPanelWindowInputBounds.text)
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
    }
}
