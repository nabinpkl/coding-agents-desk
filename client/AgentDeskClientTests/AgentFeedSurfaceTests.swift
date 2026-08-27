import Foundation
import Testing
import UIKit
import AgentDeskWire
import AgentPanel

@testable import AgentDeskClient

/// The phone's part in the agent feed is transport, and these assert exactly that much.
///
/// The suite this replaces checked field-by-field that a panel request became the matching wire
/// struct, for thirteen request types. There is one relayed request type now and the phone copies
/// it, so what is left worth asserting is the routing split: relayed requests go to the lane, and
/// native-authority requests never do.
@MainActor
struct AgentFeedSurfaceTests {
    @Test func carriesARelayedRequestWithoutEditingIt() {
        #expect(
            AgentFeedRequest(.httpRequest(
                rid: "r1",
                method: "POST",
                path: "/api/sessions/pi/s1/message",
                body: #"{"text":"hello"}"#,
                stream: false
            )) == .http(AgentFeedRelayRequest(
                rid: "r1",
                method: "POST",
                path: "/api/sessions/pi/s1/message",
                body: #"{"text":"hello"}"#,
                stream: false
            ))
        )
        #expect(
            AgentFeedRequest(.httpCancel(rid: "r1")) == .httpCancel(AgentFeedRelayCancel(rid: "r1"))
        )
    }

    /// The AskUserQuestion frames press buttons in another application's window, so they stay
    /// typed and bounded all the way across rather than riding the opaque relay.
    @Test func sendsBridgedRequestsToTheInputLaneCallback() {
        let surface = AgentFeedSurface()
        var received: [AgentFeedRequest] = []
        surface.onAgentRequest = { received.append($0) }

        surface.sendAgentPanelRequest(.httpRequest(
            rid: "r1",
            method: "GET",
            path: "/api/projects",
            body: nil,
            stream: false
        ))
        surface.sendAgentPanelRequest(.httpCancel(rid: "r1"))

        #expect(received == [
            .http(AgentFeedRelayRequest(
                rid: "r1",
                method: "GET",
                path: "/api/projects",
                body: nil,
                stream: false
            )),
            .httpCancel(AgentFeedRelayCancel(rid: "r1")),
        ])
    }

    @Test func terminalIntentsStayOnTheNativeCallback() {
        let surface = AgentFeedSurface()
        var feedRequests: [AgentFeedRequest] = []
        var terminalIntents: [AgentPanelTerminalIntent] = []
        surface.onAgentRequest = { feedRequests.append($0) }
        surface.onTerminalIntent = { terminalIntents.append($0) }
        let context = AgentPanelTerminalContext(
            projectPath: "/project",
            source: .claude,
            sessionID: "session"
        )

        surface.sendAgentPanelRequest(.terminal(
            .open(requestID: "request", context: context)
        ))
        surface.sendAgentPanelRequest(.terminal(
            .contextEnded(requestID: "request", context: context)
        ))

        #expect(feedRequests.isEmpty)
        #expect(terminalIntents == [
            .open(requestID: "request", context: context),
            .contextEnded(requestID: "request", context: context),
        ])
    }

    @Test func deliveryAndReconnectUseTheInjectableSeams() {
        let surface = AgentFeedSurface()
        var delivered: [String] = []
        var resumeCount = 0
        surface.deliverForTesting = { delivered.append($0) }
        surface.resumeAfterReconnectForTesting = { resumeCount += 1 }

        surface.deliver(rawJSON: #"{"t":"agent-http-head","rid":"r1","status":200}"#)
        surface.deliver(rawJSON: #"{"t":"agent-http-end","rid":"r1"}"#)
        surface.resumeAfterSessionReconnect()

        #expect(delivered == [
            #"{"t":"agent-http-head","rid":"r1","status":200}"#,
            #"{"t":"agent-http-end","rid":"r1"}"#,
        ])
        #expect(resumeCount == 1)
    }

    /// The host states where the panel's code comes from; this side decides what it will load.
    ///
    /// http is the case worth pinning: ATS refuses cleartext to a tailnet address, so accepting one
    /// would produce a panel that never loads and never says why, which is indistinguishable from a
    /// dead dev server. The Mac accepts http from its own launch environment, so the two sides
    /// deliberately do not share this rule.
    @Test func refusesAPanelOriginThatIsNotHTTPS() {
        #expect(
            AgentFeedSurface.panelOrigin(from: "https://mac.example.ts.net:5173")
                == .live(URL(string: "https://mac.example.ts.net:5173")!)
        )
        #expect(AgentFeedSurface.panelOrigin(from: nil) == .bundled)
        #expect(AgentFeedSurface.panelOrigin(from: "   ") == .bundled)
        #expect(AgentFeedSurface.panelOrigin(from: "http://mac.example.ts.net:5173") == .refused)
        #expect(AgentFeedSurface.panelOrigin(from: "file:///tmp/panel") == .refused)
        #expect(AgentFeedSurface.panelOrigin(from: "https://") == .refused)
        #expect(AgentFeedSurface.panelOrigin(from: "not a url") == .refused)
    }

    /// The tag is what routes this frame on both sides, and it is spelled by hand in the host's
    /// push, this client's intercept list, and the wire struct. A drift there is a phone that
    /// silently stays on its bundled build.
    @Test func panelOriginPushKeepsItsTag() throws {
        let encoded = try JSONEncoder().encode(AgentPanelOriginPush(origin: "https://mac.example.ts.net:5173"))
        let tag = try #require(
            (try JSONSerialization.jsonObject(with: encoded) as? [String: Any])?["t"] as? String
        )
        #expect(tag == "agent-panel-origin")
        #expect(AgentPanelLaneRouting.nativeInterceptedTypes.contains(tag))
        #expect(!AgentPanelLaneRouting.isPanelProtocol(tag))

        let round = try JSONDecoder().decode(AgentPanelOriginPush.self, from: encoded)
        #expect(round.origin == "https://mac.example.ts.net:5173")
        let bundled = try JSONDecoder().decode(
            AgentPanelOriginPush.self,
            from: JSONEncoder().encode(AgentPanelOriginPush(origin: nil))
        )
        #expect(bundled.origin == nil)
    }
}
