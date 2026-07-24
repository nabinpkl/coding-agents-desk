import Foundation
import Testing
import AgentDeskWire
import AgentPanel

@testable import AgentDeskHost

// R24: the macOS Agents window drives the same sidecar-backed AgentFeedBridge the iOS input lane
// drives; only the transport differs. These tests pin that AgentPanelBridgeTransport maps each
// AgentPanelRequest onto the right bridge handler with the associated values landing in the right
// wire fields, using the same FakeSidecarClient/CapturingSink harness as AgentFeedBridgeTests.
@MainActor
struct AgentPanelBridgeTransportTests {
    private func waitFor(_ sink: CapturingSink, count: Int, timeout: TimeInterval = 2.0) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if sink.received.count >= count { return }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
    }

    private func makeTransport(
        _ fake: FakeSidecarClient
    ) -> (AgentPanelBridgeTransport, CapturingSink) {
        let sink = CapturingSink()
        let bridge = AgentFeedBridge(client: fake, send: { sink.accept($0) })
        return (AgentPanelBridgeTransport(bridge: bridge), sink)
    }

    @Test func projectsSubscribeDrivesADigestFetchAndPush() async throws {
        let fake = FakeSidecarClient()
        fake.digestResult = .success([])
        let (transport, sink) = makeTransport(fake)

        transport.sendAgentPanelRequest(.projectsSubscribe)
        await waitFor(sink, count: 1)

        #expect(sink.received.count == 1)
        let push = try sink.decode(AgentProjectsPush.self, at: 0)
        #expect(push.projects.isEmpty)
    }

    @Test func threadSubscribeCarriesSessionIdIntoSeedChunkAndStream() async throws {
        let fake = FakeSidecarClient()
        fake.eventsPageResult = .success(AgentFeedEventsPage(events: [], total: 0))
        let (transport, sink) = makeTransport(fake)

        transport.sendAgentPanelRequest(
            .threadSubscribe(projectPath: "/proj", source: "claude", sessionId: "sess-xyz")
        )
        await waitFor(sink, count: 1)

        let chunk = try sink.decode(AgentThreadChunk.self, at: 0)
        #expect(chunk.sessionId == "sess-xyz")
        #expect(chunk.isLive == false)
        #expect(fake.streamOpenedForSessionId == "sess-xyz")
    }

    @Test func threadLoadOlderCarriesSessionIdIntoAnOlderChunk() async throws {
        let fake = FakeSidecarClient()
        fake.eventsPageResult = .success(AgentFeedEventsPage(events: [], total: 10))
        let (transport, sink) = makeTransport(fake)

        transport.sendAgentPanelRequest(
            .threadLoadOlder(sessionId: "sess-older", beforeIndex: 5, limit: 3)
        )
        await waitFor(sink, count: 1)

        let chunk = try sink.decode(AgentThreadChunk.self, at: 0)
        #expect(chunk.sessionId == "sess-older")
        #expect(chunk.isLive == false)
    }

    @Test func threadUnsubscribeCancelsTheSessionStream() async throws {
        let fake = FakeSidecarClient()
        fake.eventsPageResult = .success(AgentFeedEventsPage(events: [], total: 0))
        let (transport, sink) = makeTransport(fake)

        transport.sendAgentPanelRequest(
            .threadSubscribe(projectPath: "/proj", source: nil, sessionId: "sess-cancel")
        )
        await waitFor(sink, count: 1)
        #expect(fake.streamOpenedForSessionId == "sess-cancel")

        transport.sendAgentPanelRequest(.threadUnsubscribe(sessionId: "sess-cancel"))
        try await Task.sleep(nanoseconds: 200_000_000)
        #expect(fake.streamCancelledCount >= 1)
    }

    @Test func terminalIntentsRouteToTheNativeCallbackWithoutTouchingTheFeedBridge() {
        let fake = FakeSidecarClient()
        var received: [AgentPanelTerminalIntent] = []
        let sink = CapturingSink()
        let bridge = AgentFeedBridge(client: fake, send: { sink.accept($0) })
        let transport = AgentPanelBridgeTransport(
            bridge: bridge,
            onTerminalIntent: { received.append($0) }
        )
        let context = AgentPanelTerminalContext(
            projectPath: "/Users/dev/projects/alpha",
            source: .codex,
            sessionID: "session-1"
        )

        transport.sendAgentPanelRequest(.terminal(.open(requestID: "request-1", context: context)))
        transport.sendAgentPanelRequest(.terminal(.close(requestID: "request-1", context: context)))
        transport.sendAgentPanelRequest(.terminal(.contextEnded(requestID: "request-1", context: context)))

        #expect(received == [
            .open(requestID: "request-1", context: context),
            .close(requestID: "request-1", context: context),
            .contextEnded(requestID: "request-1", context: context),
        ])
        #expect(sink.received.isEmpty)
    }
}
