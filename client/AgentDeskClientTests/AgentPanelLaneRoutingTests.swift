import Foundation
import Testing
@testable import AgentDeskClient

/// Pins the `.agent`-lane routing boundary: panel-protocol frames are forwarded verbatim to the web
/// view (including types the client has not been taught yet), while a fixed native set is
/// intercepted. This is what makes new agent message types reach the panel without a per-type
/// change here — the class of bug that silently dropped `agent-live-tail`.
struct AgentPanelLaneRoutingTests {
    @Test func liveTailIsPanelProtocol() {
        #expect(AgentPanelLaneRouting.isPanelProtocol("agent-live-tail"))
    }

    // Raw-event fragments stopped being a native concern when the relay took over chunking
    // (ADR-0095): they are ordinary relayed frames now and belong on the forwarded side.
    @Test func durableAndFeedFramesRemainPanelProtocol() {
        #expect(AgentPanelLaneRouting.isPanelProtocol("agent-raw-event-part"))
        #expect(AgentPanelLaneRouting.isPanelProtocol("agent-thread-chunk"))
        #expect(AgentPanelLaneRouting.isPanelProtocol("agent-thread-error"))
        #expect(AgentPanelLaneRouting.isPanelProtocol("agent-projects"))
        #expect(AgentPanelLaneRouting.isPanelProtocol("agent-command-receipt"))
        #expect(AgentPanelLaneRouting.isPanelProtocol("agent-extension-ui-request"))
    }

    // Forward-compatibility: an `agent-*` type the current build has never seen must still be
    // forwarded verbatim, because the panel webview (the authority on the protocol) decodes by `t`
    // and ignores what it does not yet know. This is the property that removes the need to edit a
    // client-side allowlist every time the panel grows.
    @Test func unknownAgentTypesAreForwardedByConstruction() {
        #expect(AgentPanelLaneRouting.isPanelProtocol("agent-future-message"))
        #expect(AgentPanelLaneRouting.isPanelProtocol("agent-something-not-yet-invented"))
    }

    @Test func nativeInterceptedAgentTypesAreNotForwarded() {
        #expect(!AgentPanelLaneRouting.isPanelProtocol("agent-say"))
        #expect(!AgentPanelLaneRouting.isPanelProtocol("agent-panel-origin"))
        #expect(!AgentPanelLaneRouting.isPanelProtocol("agent-terminal-ready"))
        #expect(!AgentPanelLaneRouting.isPanelProtocol("agent-terminal-ended"))
        #expect(!AgentPanelLaneRouting.isPanelProtocol("agent-terminal-error"))
    }

    @Test func nativeInputFramesAreNotForwarded() {
        #expect(!AgentPanelLaneRouting.isPanelProtocol("thumbnails-push"))
        #expect(!AgentPanelLaneRouting.isPanelProtocol("cursor"))
        #expect(!AgentPanelLaneRouting.isPanelProtocol("desktop-state"))
        #expect(!AgentPanelLaneRouting.isPanelProtocol("workspace-terminal-ready"))
    }
}