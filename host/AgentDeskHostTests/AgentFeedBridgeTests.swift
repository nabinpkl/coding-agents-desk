import Foundation
import Testing
import AgentDeskWire

@testable import AgentDeskHost

// MARK: - FakeSidecarClient

final class FakeSidecarClient: SidecarClient, @unchecked Sendable {
    // Configurable canned return values.
    var digestResult: Result<[EngineProjectDigest], Error> = .success([])
    var eventsPageResult: Result<EngineEventsPage, Error> = .success(EngineEventsPage(events: [], total: 0))
    var rawEventResult: Result<String, Error> = .success("")

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

    func fetchRawEvent(sessionId: String, eventIndex: Int) async throws -> String {
        try rawEventResult.get()
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

private func makeSession(
    sessionId: String = "sess-1",
    source: String = "claude",
    bin: String? = "live",
    lastEventAt: Double? = 1_700_000_001_000.0,
    title: String? = "Fix the bug",
    firstPrompt: String? = nil,
    lastUserPrompt: String? = nil
) -> EngineSessionDigest {
    EngineSessionDigest(
        sessionId: sessionId,
        source: source,
        bin: bin,
        lastEventAt: lastEventAt,
        title: title,
        firstPrompt: firstPrompt,
        lastUserPrompt: lastUserPrompt
    )
}

private func makeDigest(
    project: String = "/Users/dev/my-project",
    projectName: String = "my-project",
    bin: String = "live",
    sources: [String] = ["claude"],
    primary: EngineSessionDigest? = nil,
    sessions: [EngineSessionDigest]? = nil,
    otherSessions: [EngineSessionDigest]? = nil
) -> EngineProjectDigest {
    let resolvedPrimary = primary ?? makeSession()
    return EngineProjectDigest(
        project: project,
        projectName: projectName,
        source: "claude",
        sources: sources,
        observed: false,
        lastEventAt: 1_700_000_001_000.0,
        bin: bin,
        primary: resolvedPrimary,
        sessions: sessions ?? [resolvedPrimary],
        otherSessions: otherSessions
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

    @Test func projectsSubscribeMapsCombinedSourcesSessionList() async throws {
        let fake = FakeSidecarClient()
        // A dual-source project: full sessions[] carries the primary (claude) and
        // a codex session; otherSessions[] carries an older claude session. Build
        // out-of-recency-order on purpose to verify the sort.
        let primary = makeSession(
            sessionId: "claude-new",
            source: "claude",
            bin: "live",
            lastEventAt: 3_000.0,
            title: "Newest claude thread"
        )
        let codex = makeSession(
            sessionId: "codex-mid",
            source: "codex",
            bin: "cold",
            lastEventAt: 2_000.0,
            title: "Codex thread"
        )
        // Older session present only in otherSessions, and a duplicate of the
        // primary to prove dedup keeps one entry.
        let olderClaude = makeSession(
            sessionId: "claude-old",
            source: "claude",
            bin: "cold",
            lastEventAt: 1_000.0,
            title: nil,
            firstPrompt: nil,
            lastUserPrompt: "older prompt"
        )
        let dupPrimary = makeSession(
            sessionId: "claude-new",
            source: "claude",
            bin: "live",
            lastEventAt: 3_000.0,
            title: "Newest claude thread"
        )
        let digest = makeDigest(
            sources: ["claude", "codex"],
            primary: primary,
            sessions: [primary, codex],
            otherSessions: [olderClaude, dupPrimary]
        )
        fake.digestResult = .success([digest])
        let sink = CapturingSink()
        let bridge = AgentFeedBridge(client: fake, send: { sink.accept($0) })

        bridge.handleProjectsSubscribe()
        await waitForMessages(sink, count: 1)

        let push = try sink.decode(AgentProjectsPush.self, at: 0)
        let project = push.projects[0]
        // All three unique sessions present (deduped from four entries).
        #expect(project.sessions.count == 3)
        // Recency-sorted descending by lastEventAt.
        #expect(project.sessions.map(\.sessionId) == ["claude-new", "codex-mid", "claude-old"])
        // Per-session source carries the combined Claude + Codex nature.
        #expect(Set(project.sessions.map(\.source)) == ["claude", "codex"])
        // isLive derives from the session's own bin, not the project bin.
        #expect(project.sessions[0].isLive == true)   // claude-new, bin live
        #expect(project.sessions[1].isLive == false)  // codex-mid, bin cold
        #expect(project.sessions[2].isLive == false)  // claude-old, bin cold
        // Title fallback chain: a session with no title falls to firstPrompt
        // then lastUserPrompt.
        #expect(project.sessions[2].title == "older prompt")
    }

    @Test func projectsSubscribeCapsSessionsPerProject() async throws {
        let fake = FakeSidecarClient()
        // Build 50 sessions; the cap is 30.
        let many = (0..<50).map { i in
            makeSession(
                sessionId: "sess-\(i)",
                source: i % 2 == 0 ? "claude" : "codex",
                bin: "cold",
                lastEventAt: Double(i),
                title: "Thread \(i)"
            )
        }
        let digest = makeDigest(
            sources: ["claude", "codex"],
            primary: many[0],
            sessions: Array(many.prefix(3)),
            otherSessions: Array(many.suffix(47))
        )
        fake.digestResult = .success([digest])
        let sink = CapturingSink()
        let bridge = AgentFeedBridge(client: fake, send: { sink.accept($0) })

        bridge.handleProjectsSubscribe()
        await waitForMessages(sink, count: 1)

        let push = try sink.decode(AgentProjectsPush.self, at: 0)
        #expect(push.projects[0].sessions.count == AgentFeedBridge.maxSessionsPerProject)
        // The cap keeps the most recent ones (highest lastEventAt first).
        #expect(push.projects[0].sessions[0].sessionId == "sess-49")
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

    @Test func rawEventUsesOneFrameWhenEncodedResponseFits() async throws {
        let fake = FakeSidecarClient()
        fake.rawEventResult = .success(#"{"exact":true}"#)
        let sink = CapturingSink()
        let bridge = AgentFeedBridge(client: fake, send: { sink.accept($0) })

        bridge.handleRawEvent(AgentRawEventRequest(
            requestId: "r1", sessionId: "s1", eventIndex: 7
        ))
        await waitForMessages(sink, count: 1)

        #expect(sink.received.count == 1)
        let response = try sink.decode(AgentRawEventResponse.self, at: 0)
        #expect(response.text == #"{"exact":true}"#)
    }

    @Test func rawEventFragmentsAboveInputFrameLimitAndReassembles() async throws {
        let fake = FakeSidecarClient()
        let text = String(repeating: "a", count: QuicSessionStreamFrame.maxFrameLength)
        fake.rawEventResult = .success(text)
        let sink = CapturingSink()
        let bridge = AgentFeedBridge(client: fake, send: { sink.accept($0) })

        bridge.handleRawEvent(AgentRawEventRequest(
            requestId: "r2", sessionId: "s2", eventIndex: 8
        ))
        await waitForMessages(sink, count: 2)

        #expect(sink.received.count == 2)
        var reassembler = AgentRawEventReassembler()
        var completed: AgentRawEventResponse?
        for frame in sink.received {
            #expect(frame.count <= QuicSessionStreamFrame.maxFrameLength)
            let part = try JSONDecoder().decode(AgentRawEventPart.self, from: frame)
            if case .complete(let response) = reassembler.accept(part) {
                completed = response
            }
        }
        #expect(completed?.text == text)
    }

    // MARK: SSE stream error -> AgentThreadError for that session

    @Test func streamErrorSendsAgentThreadError() async throws {
        let fake = FakeSidecarClient()
        // A clean subscribe so the live stream opens (seed chunk first).
        fake.eventsPageResult = .success(EngineEventsPage(events: [], total: 0))
        let sink = CapturingSink()
        let bridge = AgentFeedBridge(client: fake, send: { sink.accept($0) })

        let request = AgentThreadSubscribe(projectPath: "/proj", sessionId: "sess-stream-err")
        bridge.handleThreadSubscribe(request)
        await waitForMessages(sink, count: 1) // seed chunk
        #expect(fake.streamOpenedForSessionId == "sess-stream-err")

        // The live SSE stream errors (network drop / HTTP error).
        struct StreamDrop: Error, LocalizedError {
            var errorDescription: String? { "stream-dropped" }
        }
        fake.pushStreamError(StreamDrop())
        await waitForMessages(sink, count: 2)

        // The second message must be an AgentThreadError for that session.
        let errMsg = try sink.decode(AgentThreadError.self, at: 1)
        #expect(errMsg.sessionId == "sess-stream-err")
        #expect(errMsg.reason == "stream-dropped")
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

    // MARK: EngineProjectDigest decodes the real sidecar wire shape

    // Regression: the engine emits `observed` as a JSON bool (from a Set.has())
    // and `lastEventAt` as a fractional epoch-ms Double. The DTO must decode that
    // exact shape. A prior fixture used a Double for `observed`, so the decoder
    // was never exercised against the engine's real payload and a type mismatch
    // (Double vs Bool) shipped, breaking every projects fetch in the bridge.
    @Test func engineProjectDigestDecodesRealSidecarPayload() throws {
        let json = """
        [
          {
            "projectName": "agent-desk",
            "project": "/Users/dev/projects/agent-desk",
            "source": "claude",
            "sources": ["claude", "codex"],
            "observed": false,
            "lastEventAt": 1782851101572.0078
          }
        ]
        """.data(using: .utf8)!

        let digests = try JSONDecoder().decode([EngineProjectDigest].self, from: json)

        #expect(digests.count == 1)
        #expect(digests[0].observed == false)
        #expect(digests[0].project == "/Users/dev/projects/agent-desk")
        #expect(digests[0].lastEventAt == 1782851101572.0078)
    }

    // Decode-contract guard against the real sidecar block shape. The engine
    // emits tool_use blocks with `tool`/`summary`/`callId` and tool_result
    // blocks with `preview`/`callId` (full field names). A prior version of
    // EngineActivityBlock decoded only kind+text, so TOOL/RESULT rows arrived
    // empty on the client. Feed the real shape and assert every field survives.
    @Test func engineActivityBlockDecodesToolAndResultFields() throws {
        let json = """
        {
          "index": 42,
          "ts": 1782851101572.0,
          "type": "assistant",
          "blocks": [
            { "kind": "text", "text": "Running the build." },
            { "kind": "tool_use", "tool": "Bash", "summary": "just check", "callId": "call-1" },
            { "kind": "tool_result", "preview": "** TEST SUCCEEDED **", "callId": "call-1" }
          ]
        }
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(EngineActivityEvent.self, from: json)

        #expect(event.blocks.count == 3)
        #expect(event.blocks[0].text == "Running the build.")
        #expect(event.blocks[1].tool == "Bash")
        #expect(event.blocks[1].summary == "just check")
        #expect(event.blocks[1].callId == "call-1")
        #expect(event.blocks[2].preview == "** TEST SUCCEEDED **")
        #expect(event.blocks[2].callId == "call-1")
    }
}

// MARK: - HttpSidecarClient lazy base-URL resolution

// Regression: the sidecar can be mid-restart when a session attaches. The
// client must resolve the base URL per request (not capture it at construction)
// and surface a transient `notReady` when it is down, so the feed recovers on a
// later retry instead of being disabled for the whole session.
@Suite struct HttpSidecarClientNotReadyTests {
    @Test func fetchDigestThrowsNotReadyWhenSidecarDown() async {
        let client = HttpSidecarClient(baseURLProvider: { nil })
        do {
            _ = try await client.fetchDigest()
            Issue.record("expected notReady when base URL provider returns nil")
        } catch {
            #expect((error as? SidecarClientError) == .notReady)
        }
    }

    @Test func openEventStreamReportsNotReadyWhenSidecarDown() async {
        let client = HttpSidecarClient(baseURLProvider: { nil })
        let err: Error = await withCheckedContinuation { cont in
            _ = client.openEventStream(
                sessionId: "s1",
                after: 0,
                onEvent: { _ in },
                onError: { cont.resume(returning: $0) }
            )
        }
        #expect((err as? SidecarClientError) == .notReady)
    }
}
