import AgentDeskWire
import AgentPanel

/// Adapts the reusable AgentPanel request contract to the host-local `AgentFeedBridge` (R24). The
/// macOS Agents window drives the same sidecar-backed bridge the iOS input lane drives; the only
/// difference is the transport. Where the iOS path decodes `.files`/agent frames off the QUIC lane
/// and calls `bridge.handle*`, this maps the webview's in-process `AgentPanelRequest` onto the exact
/// same wire types and handlers, so both surfaces share one bridge implementation. The wire types
/// carry `source` as a string; the validated `AgentPanelAgentSource` is unwrapped here, at the one
/// boundary that crosses into them, so nothing downstream sees an unchecked harness name.
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
        case .projectsWatch(let subscriptionId):
            bridge.handleProjectsWatch(AgentProjectsWatch(subscriptionId: subscriptionId))
        case .projectsUnwatch(let subscriptionId):
            bridge.handleProjectsUnwatch(AgentProjectsUnwatch(subscriptionId: subscriptionId))
        case .projectSessionsWatch(let subscriptionId, let projectPath):
            bridge.handleProjectSessionsWatch(AgentProjectSessionsWatch(
                subscriptionId: subscriptionId,
                projectPath: projectPath
            ))
        case .projectSessionsUnwatch(let subscriptionId):
            bridge.handleProjectSessionsUnwatch(AgentProjectSessionsUnwatch(subscriptionId: subscriptionId))
        case .threadSubscribe(let source, let sessionId, let mode):
            bridge.handleThreadSubscribe(AgentThreadSubscribe(
                source: source.rawValue,
                sessionId: sessionId,
                mode: mode.rawValue
            ))
        case .threadLoadOlder(let source, let sessionId, let beforeIndex, let limit, let mode):
            bridge.handleThreadLoadOlder(AgentThreadLoadOlder(
                source: source.rawValue,
                sessionId: sessionId,
                beforeIndex: beforeIndex,
                limit: limit,
                mode: mode.rawValue
            ))
        case .threadUnsubscribe(let source, let sessionId):
            bridge.handleThreadUnsubscribe(AgentThreadUnsubscribe(
                source: source.rawValue,
                sessionId: sessionId
            ))
        case .rawEvent(let requestId, let source, let sessionId, let eventIndex, let mode):
            bridge.handleRawEvent(AgentRawEventRequest(
                requestId: requestId,
                source: source.rawValue,
                sessionId: sessionId,
                eventIndex: eventIndex,
                mode: mode.rawValue
            ))
        case .terminal(let intent):
            onTerminalIntent?(intent)
        }
    }
}
