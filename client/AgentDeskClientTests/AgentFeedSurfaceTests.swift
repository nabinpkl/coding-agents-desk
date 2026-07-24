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
                sessionId: "same"
            )) == .threadSubscribe(AgentThreadSubscribe(
                source: "claude",
                sessionId: "same"
            ))
        )
        #expect(
            AgentFeedRequest(.threadLoadOlder(
                source: "codex",
                sessionId: "same",
                beforeIndex: 50,
                limit: 25
            )) == .threadLoadOlder(AgentThreadLoadOlder(
                source: "codex",
                sessionId: "same",
                beforeIndex: 50,
                limit: 25
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
                eventIndex: 7
            )) == .rawEvent(AgentRawEventRequest(
                requestId: "raw",
                source: "claude",
                sessionId: "same",
                eventIndex: 7
            ))
        )
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
        surface.resumeAfterSessionReconnect()

        #expect(delivered == [#"{"t":"agent-projects","sub":"p","p":[]}"#])
        #expect(resumeCount == 1)
    }
}
