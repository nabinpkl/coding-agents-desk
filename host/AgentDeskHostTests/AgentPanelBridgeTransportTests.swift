import Foundation
import Testing
import AgentDeskWire
import AgentPanel

@testable import AgentDeskHost

@MainActor
struct AgentPanelBridgeTransportTests {
    @Test func visibilityRequestsDriveTheSharedBridge() async throws {
        let fake = FakeSidecarClient()
        fake.projects = AgentFeedProjectsSnapshot(projects: [])
        fake.sessions = AgentFeedSessionsSnapshot(
            projectPath: "/project",
            sessions: []
        )
        let sink = CapturingSink()
        let bridge = AgentFeedBridge(client: fake, send: sink.accept)
        let transport = AgentPanelBridgeTransport(bridge: bridge)

        transport.sendAgentPanelRequest(.projectsWatch(subscriptionId: "p-1"))
        fake.pushProjects()
        await waitFor { sink.count == 1 }
        let projectPush = try sink.decode(AgentProjectsPush.self, at: 0)
        #expect(projectPush.subscriptionId == "p-1")

        transport.sendAgentPanelRequest(.projectsUnwatch(subscriptionId: "p-1"))
        transport.sendAgentPanelRequest(.projectSessionsWatch(
            subscriptionId: "s-1",
            projectPath: "/project"
        ))
        fake.pushSessions()
        await waitFor { sink.count == 2 }
        let sessionPush = try sink.decode(AgentProjectSessionsPush.self, at: 1)
        #expect(sessionPush.subscriptionId == "s-1")
        #expect(sessionPush.projectPath == "/project")
    }

    @Test func threadRequestsPreserveSourceAndSessionIdentity() async throws {
        let fake = FakeSidecarClient()
        fake.eventsPage = AgentFeedEventsPage(events: [], total: 10)
        let sink = CapturingSink()
        let bridge = AgentFeedBridge(client: fake, send: sink.accept)
        let transport = AgentPanelBridgeTransport(bridge: bridge)

        transport.sendAgentPanelRequest(.threadLoadOlder(
            source: "codex",
            sessionId: "same",
            beforeIndex: 5,
            limit: 3
        ))
        await waitFor { sink.count == 1 }
        let chunk = try sink.decode(AgentThreadChunk.self, at: 0)
        #expect(chunk.source == "codex")
        #expect(chunk.sessionId == "same")
    }

    @Test func terminalIntentsRemainNative() {
        let fake = FakeSidecarClient()
        var received: [AgentPanelTerminalIntent] = []
        let sink = CapturingSink()
        let bridge = AgentFeedBridge(client: fake, send: sink.accept)
        let transport = AgentPanelBridgeTransport(
            bridge: bridge,
            onTerminalIntent: { received.append($0) }
        )
        let context = AgentPanelTerminalContext(
            projectPath: "/project",
            source: .codex,
            sessionID: "session"
        )

        transport.sendAgentPanelRequest(.terminal(
            .open(requestID: "request", context: context)
        ))
        transport.sendAgentPanelRequest(.terminal(
            .close(requestID: "request", context: context)
        ))
        transport.sendAgentPanelRequest(.terminal(
            .contextEnded(requestID: "request", context: context)
        ))

        #expect(received.count == 3)
        #expect(sink.count == 0)
    }

    private func waitFor(
        _ predicate: @escaping @Sendable () -> Bool
    ) async {
        let deadline = ContinuousClock.now.advanced(by: .seconds(2))
        while ContinuousClock.now < deadline {
            if predicate() { return }
            try? await Task.sleep(for: .milliseconds(5))
        }
    }
}
