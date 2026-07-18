import AgentDeskWire
import AgentPanel

/// Adapts the reusable AgentPanel request contract to the host-local `AgentFeedBridge` (R24). The
/// macOS Agents window drives the same sidecar-backed bridge the iOS input lane drives; the only
/// difference is the transport. Where the iOS path decodes `.files`/agent frames off the QUIC lane
/// and calls `bridge.handle*`, this maps the webview's in-process `AgentPanelRequest` onto the exact
/// same wire types and handlers, so both surfaces share one bridge implementation.
@MainActor
final class AgentPanelBridgeTransport: AgentPanelTransport {
    private let bridge: AgentFeedBridge
    private let onTerminalIntent: ((AgentPanelTerminalIntent) -> Void)?

    init(
        bridge: AgentFeedBridge,
        onTerminalIntent: ((AgentPanelTerminalIntent) -> Void)? = nil
    ) {
        self.bridge = bridge
        self.onTerminalIntent = onTerminalIntent
    }

    func sendAgentPanelRequest(_ request: AgentPanelRequest) {
        switch request {
        case .projectsSubscribe:
            bridge.handleProjectsSubscribe()
        case .threadSubscribe(let projectPath, let source, let sessionId):
            bridge.handleThreadSubscribe(AgentThreadSubscribe(
                projectPath: projectPath, source: source, sessionId: sessionId
            ))
        case .threadLoadOlder(let sessionId, let beforeIndex, let limit):
            bridge.handleThreadLoadOlder(AgentThreadLoadOlder(
                sessionId: sessionId, beforeIndex: beforeIndex, limit: limit
            ))
        case .threadUnsubscribe(let sessionId):
            bridge.handleThreadUnsubscribe(AgentThreadUnsubscribe(sessionId: sessionId))
        case .terminal(let intent):
            onTerminalIntent?(intent)
        }
    }
}
