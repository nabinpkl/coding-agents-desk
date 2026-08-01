import Foundation
import Testing
import UIKit
import AgentDeskWire
import AgentPanel

@testable import AgentDeskClient

@MainActor
struct AgentFeedSurfaceTests {
    @Test func bridgesVisibilityRequestsExactly() {
        #expect(
            AgentFeedRequest(.projectsWatch(subscriptionId: "p-1"))
                == .projectsWatch(AgentProjectsWatch(subscriptionId: "p-1"))
        )
        #expect(
            AgentFeedRequest(.projectsUnwatch(subscriptionId: "p-1"))
                == .projectsUnwatch(AgentProjectsUnwatch(subscriptionId: "p-1"))
        )
        #expect(
            AgentFeedRequest(.projectSessionsWatch(
                subscriptionId: "s-1",
                projectPath: "/project"
            )) == .projectSessionsWatch(AgentProjectSessionsWatch(
                subscriptionId: "s-1",
                projectPath: "/project"
            ))
        )
        #expect(
            AgentFeedRequest(.projectSessionsUnwatch(subscriptionId: "s-1"))
                == .projectSessionsUnwatch(
                    AgentProjectSessionsUnwatch(subscriptionId: "s-1")
                )
        )
    }

    @Test func bridgesThreadAndRawIdentityExactly() {
        #expect(
            AgentFeedRequest(.threadSubscribe(
                source: "claude",
                sessionId: "same",
                mode: .raw
            )) == .threadSubscribe(AgentThreadSubscribe(
                source: "claude",
                sessionId: "same",
                mode: "raw"
            ))
        )
        #expect(
            AgentFeedRequest(.threadLoadOlder(
                source: "codex",
                sessionId: "same",
                beforeIndex: 50,
                limit: 25,
                mode: .raw
            )) == .threadLoadOlder(AgentThreadLoadOlder(
                source: "codex",
                sessionId: "same",
                beforeIndex: 50,
                limit: 25,
                mode: "raw"
            ))
        )
        #expect(
            AgentFeedRequest(.threadUnsubscribe(
                source: "codex",
                sessionId: "same"
            )) == .threadUnsubscribe(AgentThreadUnsubscribe(
                source: "codex",
                sessionId: "same"
            ))
        )
        #expect(
            AgentFeedRequest(.rawEvent(
                requestId: "raw",
                source: "claude",
                sessionId: "same",
                eventIndex: 7,
                mode: .raw
            )) == .rawEvent(AgentRawEventRequest(
                requestId: "raw",
                source: "claude",
                sessionId: "same",
                eventIndex: 7,
                mode: "raw"
            ))
        )
    }

    @Test func bridgesLiveAgentCommandsAndExtensionResponsesExactly() {
        #expect(AgentFeedRequest(.createSession(
            requestId: "create-1",
            source: "pi",
            projectPath: "/project"
        )) == .sessionCreate(AgentSessionCreate(
            requestId: "create-1",
            source: "pi",
            projectPath: "/project"
        )))
        #expect(AgentFeedRequest(.send(
            requestId: "send-1",
            source: "pi",
            sessionId: "session",
            text: "hello",
            delivery: "steer"
        )) == .sessionSend(AgentSessionSend(
            requestId: "send-1",
            source: "pi",
            sessionId: "session",
            text: "hello",
            delivery: "steer"
        )))
        #expect(AgentFeedRequest(.abort(
            requestId: "abort-1",
            source: "pi",
            sessionId: "session"
        )) == .sessionAbort(AgentSessionAbort(
            requestId: "abort-1",
            source: "pi",
            sessionId: "session"
        )))
        #expect(AgentFeedRequest(.extensionUIResponse(
            source: "pi",
            sessionId: "session",
            requestId: "ui-1",
            value: .bool(true)
        )) == .extensionUIResponse(AgentExtensionUIResponse(
            source: "pi",
            sessionId: "session",
            requestId: "ui-1",
            value: .bool(true)
        )))
    }

    @Test func sendsBridgedRequestsToTheInputLaneCallback() {
        let surface = AgentFeedSurface()
        var received: [AgentFeedRequest] = []
        surface.onAgentRequest = { received.append($0) }

        surface.sendAgentPanelRequest(.projectsWatch(subscriptionId: "p"))
        surface.sendAgentPanelRequest(.threadUnsubscribe(
            source: "codex",
            sessionId: "s"
        ))

        #expect(received == [
            .projectsWatch(AgentProjectsWatch(subscriptionId: "p")),
            .threadUnsubscribe(AgentThreadUnsubscribe(
                source: "codex",
                sessionId: "s"
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

        surface.deliver(rawJSON: #"{"t":"agent-projects","sub":"p","p":[]}"#)
        surface.deliver(rawJSON: #"{"t":"agent-extension-ui-dismissed","src":"pi","sid":"session","rid":"ui-1"}"#)
        surface.resumeAfterSessionReconnect()

        #expect(delivered == [
            #"{"t":"agent-projects","sub":"p","p":[]}"#,
            #"{"t":"agent-extension-ui-dismissed","src":"pi","sid":"session","rid":"ui-1"}"#,
        ])
        #expect(resumeCount == 1)
    }
}
