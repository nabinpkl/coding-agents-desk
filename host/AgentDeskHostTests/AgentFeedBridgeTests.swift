import Foundation
import Testing

@testable import AgentDeskHost

// MARK: - FakeSidecarClient

final class FakeSidecarClient: SidecarClient, @unchecked Sendable {
    // Configurable canned return values.
    var digestResult: Result<[EngineProjectDigest], Error> = .success([])
    var eventsPageResult: Result<EngineEventsPage, Error> = .success(EngineEventsPage(events: [], total: 0))

    // Whether a stream was opened and the injected event-push closure.
    private(set) var streamOpenedForSessionId: String?
    private(set) var streamCancelledCount = 0
    private var capturedOnEvent: (@Sendable (EngineActivityEvent) -> Void)?
    private var capturedOnError: (@Sendable (Error) -> Void)?

    func fetchDigest() async throws -> [EngineProjectDigest] {
        try digestResult.get()
    }

    func fetchEventsPage(sessionId: String, offset: Int, limit: Int) async throws -> EngineEventsPage {
        try eventsPageResult.get()
    }

    func openEventStream(
        sessionId: String,
        after: Int,
        onEvent: @escaping @Sendable (EngineActivityEvent) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> SidecarStreamHandle {
        streamOpenedForSessionId = sessionId
        capturedOnEvent = onEvent
        capturedOnError = onError
        let cancelCount = { [weak self] in
            self?.streamCancelledCount += 1
        }
        let task = Task<Void, Never> {
            // Block until cancelled; the test pushes events manually.
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
            cancelCount()
        }
        return SidecarStreamHandle(task: task)
    }

    // Push a synthetic event into the open stream.
    func pushStreamEvent(_ event: EngineActivityEvent) {
        capturedOnEvent?(event)
    }

    // Push a synthetic error into the open stream.
    func pushStreamError(_ error: Error) {
        capturedOnError?(error)
    }
}

// MARK: - CapturingSink

// Decodes received Data frames back into typed wire messages for assertions.
final class CapturingSink: @unchecked Sendable {
    private let lock = NSLock()
    private var _received: [Data] = []

    var received: [Data] {
        lock.withLock { _received }
    }

    func accept(_ data: Data) {
        lock.withLock { _received.append(data) }
    }

    func decode<T: Decodable>(_ type: T.Type, at index: Int) throws -> T {
        let data = received[index]
        return try JSONDecoder().decode(type, from: data)
    }

    func clear() {
        lock.withLock { _received.removeAll() }
    }
}

// MARK: - Test helpers

private func makeEngineEvent(index: Int = 0, type: String = "assistant") -> EngineActivityEvent {
    EngineActivityEvent(
        index: index,
        ts: 1_700_000_000_000.0,
        type: type,
        blocks: [EngineActivityBlock(kind: "text", text: "hello")]
    )
}

private func makePrimary(sessionId: String = "sess-1", source: String = "claude") -> EngineProjectPrimary {
    EngineProjectPrimary(
        sessionId: sessionId,
        source: source,
        project: "/Users/dev/my-project",
        projectName: "my-project",
        firstPrompt: "Fix the bug",
        lastUserPrompt: nil
    )
}

private func makeDigest(
    project: String = "/Users/dev/my-project",
    projectName: String = "my-project",
    bin: String = "live",
    primary: EngineProjectPrimary? = nil
) -> EngineProjectDigest {
    EngineProjectDigest(
        project: project,
        projectName: projectName,
        source: "claude",
        sources: ["claude"],
        observed: 1_700_000_000_000.0,
        lastEventAt: 1_700_000_001_000.0,
        bin: bin,
        primary: primary ?? makePrimary()
    )
}

// Wait for the sink to receive at least `count` messages within a deadline.
private func waitForMessages(_ sink: CapturingSink, count: Int, timeout: TimeInterval = 2.0) async {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if sink.received.count >= count { return }
        try? await Task.sleep(nanoseconds: 5_000_000)
    }
}

// MARK: - Tests

struct AgentFeedBridgeTests {

    // MARK: AgentProjectsSubscribe -> AgentProjectsPush

    @Test func projectsSubscribeMapsFakeDigest() async throws {
        let fake = FakeSidecarClient()
        let digest = makeDigest()
        fake.digestResult = .success([digest])
        let sink = CapturingSink()
        let bridge = AgentFeedBridge(client: fake, send: { sink.accept($0) })

        bridge.handleProjectsSubscribe()
        await waitForMessages(sink, count: 1)

        #expect(sink.received.count == 1)
        let push = try sink.decode(AgentProjectsPush.self, at: 0)
        #expect(push.projects.count == 1)
        #expect(push.projects[0].projectPath == "/Users/dev/my-project")
        #expect(push.projects[0].displayName == "my-project")
        #expect(push.projects[0].sessions.count == 1)
        #expect(push.projects[0].sessions[0].sessionId == "sess-1")
        #expect(push.projects[0].sessions[0].source == "claude")
        #expect(push.projects[0].sessions[0].title == "Fix the bug")
        #expect(push.projects[0].sessions[0].isLive == true)
    }

    // MARK: AgentThreadSubscribe -> seed chunk + live chunk

    @Test func threadSubscribeSendsSeedChunkThenLiveChunk() async throws {
        let fake = FakeSidecarClient()
        let event = makeEngineEvent(index: 5, type: "user")
        fake.eventsPageResult = .success(EngineEventsPage(events: [event], total: 6))
        let sink = CapturingSink()
        let bridge = AgentFeedBridge(client: fake, send: { sink.accept($0) })

        let request = AgentThreadSubscribe(projectPath: "/proj", sessionId: "sess-abc")
        bridge.handleThreadSubscribe(request)
        await waitForMessages(sink, count: 1)

        // Seed chunk: isLive == false
        let seedChunk = try sink.decode(AgentThreadChunk.self, at: 0)
        #expect(seedChunk.sessionId == "sess-abc")
        #expect(seedChunk.isLive == false)
        #expect(seedChunk.total == 6)
        #expect(seedChunk.events.count == 1)

        // Push a live event from the fake stream.
        let liveEvent = makeEngineEvent(index: 6, type: "assistant")
        fake.pushStreamEvent(liveEvent)
        await waitForMessages(sink, count: 2)

        // Live chunk: isLive == true
        let liveChunk = try sink.decode(AgentThreadChunk.self, at: 1)
        #expect(liveChunk.sessionId == "sess-abc")
        #expect(liveChunk.isLive == true)
        #expect(liveChunk.events.count == 1)
        #expect(liveChunk.events[0].type == "assistant")
    }

    // MARK: type -> tp mapping

    @Test func engineEventTypeFieldMapsToWireTpKey() async throws {
        let fake = FakeSidecarClient()
        let event = EngineActivityEvent(
            index: 0,
            ts: 1_700_000_000_000.0,
            type: "assistant",
            blocks: [EngineActivityBlock(kind: "text", text: "hi")]
        )
        fake.eventsPageResult = .success(EngineEventsPage(events: [event], total: 1))
        let sink = CapturingSink()
        let bridge = AgentFeedBridge(client: fake, send: { sink.accept($0) })

        let request = AgentThreadSubscribe(projectPath: "/proj", sessionId: "sess-tp")
        bridge.handleThreadSubscribe(request)
        await waitForMessages(sink, count: 1)

        let chunkData = sink.received[0]
        let jsonString = String(data: chunkData, encoding: .utf8) ?? ""

        // The wire ActivityEvent uses CodingKey "tp", not "type".
        #expect(jsonString.contains("\"tp\":\"assistant\""))
        #expect(!jsonString.contains("\"type\":\"assistant\""))

        // Also confirm round-trip through the wire envelope.
        let chunk = try JSONDecoder().decode(AgentThreadChunk.self, from: chunkData)
        #expect(chunk.events[0].type == "assistant")
    }

    // MARK: AgentThreadLoadOlder -> AgentThreadChunk with isLive == false

    @Test func threadLoadOlderSendsOlderChunk() async throws {
        let fake = FakeSidecarClient()
        let event = makeEngineEvent(index: 3, type: "user")
        fake.eventsPageResult = .success(EngineEventsPage(events: [event], total: 10))
        let sink = CapturingSink()
        let bridge = AgentFeedBridge(client: fake, send: { sink.accept($0) })

        let request = AgentThreadLoadOlder(sessionId: "sess-older", beforeIndex: 5, limit: 3)
        bridge.handleThreadLoadOlder(request)
        await waitForMessages(sink, count: 1)

        #expect(sink.received.count == 1)
        let chunk = try sink.decode(AgentThreadChunk.self, at: 0)
        #expect(chunk.sessionId == "sess-older")
        #expect(chunk.isLive == false)
        #expect(chunk.total == 10)
    }

    // MARK: AgentThreadUnsubscribe -> stream cancel()

    @Test func threadUnsubscribeCancelsStream() async throws {
        let fake = FakeSidecarClient()
        fake.eventsPageResult = .success(EngineEventsPage(events: [], total: 0))
        let sink = CapturingSink()
        let bridge = AgentFeedBridge(client: fake, send: { sink.accept($0) })

        let subRequest = AgentThreadSubscribe(projectPath: "/proj", sessionId: "sess-cancel")
        bridge.handleThreadSubscribe(subRequest)
        await waitForMessages(sink, count: 1)
        // Stream should have been opened.
        #expect(fake.streamOpenedForSessionId == "sess-cancel")

        let unsubRequest = AgentThreadUnsubscribe(sessionId: "sess-cancel")
        bridge.handleThreadUnsubscribe(unsubRequest)

        // Give the cancel task a moment to run.
        try await Task.sleep(nanoseconds: 200_000_000)
        #expect(fake.streamCancelledCount >= 1)
    }

    // MARK: Fetch error -> AgentThreadError

    @Test func fetchErrorSendsAgentThreadError() async throws {
        let fake = FakeSidecarClient()
        struct TestError: Error, LocalizedError {
            var errorDescription: String? { "session-not-found" }
        }
        fake.eventsPageResult = .failure(TestError())
        let sink = CapturingSink()
        let bridge = AgentFeedBridge(client: fake, send: { sink.accept($0) })

        let request = AgentThreadSubscribe(projectPath: "/proj", sessionId: "sess-err")
        bridge.handleThreadSubscribe(request)
        await waitForMessages(sink, count: 1)

        #expect(sink.received.count == 1)
        let errMsg = try sink.decode(AgentThreadError.self, at: 0)
        #expect(errMsg.sessionId == "sess-err")
        #expect(!errMsg.reason.isEmpty)
    }

    // MARK: reset() cancels all active streams

    @Test func resetCancelsAllActiveStreams() async throws {
        let fake = FakeSidecarClient()
        fake.eventsPageResult = .success(EngineEventsPage(events: [], total: 0))
        let sink = CapturingSink()
        let bridge = AgentFeedBridge(client: fake, send: { sink.accept($0) })

        // Open one stream.
        let request = AgentThreadSubscribe(projectPath: "/proj", sessionId: "sess-reset")
        bridge.handleThreadSubscribe(request)
        await waitForMessages(sink, count: 1)

        bridge.reset()
        try await Task.sleep(nanoseconds: 200_000_000)
        #expect(fake.streamCancelledCount >= 1)
    }
}
