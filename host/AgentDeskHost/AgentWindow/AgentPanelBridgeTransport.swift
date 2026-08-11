import AgentDeskWire
import AgentPanel

/// Adapts the reusable AgentPanel request contract to the host-local agent-feed relay. The macOS
/// Agents window drives the same relay the iOS input lane drives; the only difference is the
/// transport. Where the iOS path decodes agent frames off the QUIC lane and calls `relay.handle*`,
/// this maps the webview's in-process `AgentPanelRequest` onto the exact same wire types and
/// handlers, so both surfaces share one relay implementation.
///
/// There are two kinds of request and the split is the whole design: a relayed sidecar call, which
/// this forwards without reading a field of it, and a native-authority action, which does not go
/// near the sidecar and is handed to the host.
@MainActor
final class AgentPanelBridgeTransport: AgentPanelTransport {
    private let relay: AgentFeedHTTPRelay
    private let onTerminalIntent: ((AgentPanelTerminalIntent) -> Void)?
    private let onWindowInput: ((AgentPanelRequest) -> Void)?

    init(
        relay: AgentFeedHTTPRelay,
        onTerminalIntent: ((AgentPanelTerminalIntent) -> Void)? = nil,
        onWindowInput: ((AgentPanelRequest) -> Void)? = nil
    ) {
        self.relay = relay
        self.onTerminalIntent = onTerminalIntent
        self.onWindowInput = onWindowInput
    }

    func sendAgentPanelRequest(_ request: AgentPanelRequest) {
        switch request {
        case .httpRequest(let rid, let method, let path, let body, let stream):
            relay.handleRequest(AgentFeedRelayRequest(
                rid: rid,
                method: method,
                path: path,
                body: body,
                stream: stream
            ))
        case .httpCancel(let rid):
            relay.handleCancel(AgentFeedRelayCancel(rid: rid))
        case .terminal(let intent):
            onTerminalIntent?(intent)
        case .windowInputWatch, .windowInputUnwatch, .windowInputSync, .windowInputRead, .windowInputSubmit,
             .questionWatch, .questionUnwatch, .questionAction:
            // Composer sync and the AskUserQuestion mirror are host-local Accessibility actions against
            // another application's window. They route past the relay deliberately: the relay is a
            // sidecar proxy, and there is no sidecar in this path. With no handler attached -- a
            // host without its Space authority -- nothing answers, so the panel keeps its field disabled
            // and its mirror inert rather than believing a write or press landed.
            onWindowInput?(request)
        }
    }
}
