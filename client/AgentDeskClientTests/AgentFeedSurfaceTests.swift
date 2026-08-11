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
    @Test func keepsTheQuestionMirrorTyped() {
        #expect(AgentFeedRequest(.questionWatch(
            subscriptionId: "q-1",
            sessionId: "session"
        )) == .questionWatch(AgentWindowQuestionWatch(
            subscriptionId: "q-1",
            sessionId: "session"
        )))
        #expect(AgentFeedRequest(.questionUnwatch(subscriptionId: "q-1"))
            == .questionUnwatch(AgentWindowQuestionUnwatch(subscriptionId: "q-1")))
        #expect(AgentFeedRequest(.questionAction(
            requestId: "a-1",
            sessionId: "session",
            kind: .select,
            optionIndex: 2,
            desired: true,
            otherText: nil
        )) == .questionAction(AgentWindowQuestionAction(
            requestId: "a-1",
            sessionId: "session",
            kind: "select",
            optionIndex: 2,
            desired: 1,
            text: nil
        )))
        #expect(AgentFeedRequest(.questionAction(
            requestId: "a-2",
            sessionId: "session",
            kind: .other,
            optionIndex: nil,
            desired: nil,
            otherText: "custom answer"
        )) == .questionAction(AgentWindowQuestionAction(
            requestId: "a-2",
            sessionId: "session",
            kind: "other",
            optionIndex: nil,
            desired: nil,
            text: "custom answer"
        )))
    }

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
        surface.sendAgentPanelRequest(.questionWatch(
            subscriptionId: "q",
            sessionId: "s"
        ))
        surface.sendAgentPanelRequest(.questionAction(
            requestId: "a",
            sessionId: "s",
            kind: .submit,
            optionIndex: nil,
            desired: nil,
            otherText: nil
        ))

        #expect(received == [
            .http(AgentFeedRelayRequest(
                rid: "r1",
                method: "GET",
                path: "/api/projects",
                body: nil,
                stream: false
            )),
            .httpCancel(AgentFeedRelayCancel(rid: "r1")),
            .questionWatch(AgentWindowQuestionWatch(
                subscriptionId: "q",
                sessionId: "s"
            )),
            .questionAction(AgentWindowQuestionAction(
                requestId: "a",
                sessionId: "s",
                kind: "submit",
                optionIndex: nil,
                desired: nil,
                text: nil
            )),
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
}
