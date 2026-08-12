import Foundation
import Testing
import AgentDeskWire
@testable import AgentDeskHost

/// What is worth testing about a relay, and what is not.
///
/// The bridge these replace had a test per endpoint asserting that a field named one thing on one
/// side arrived named another thing on the other. Those tests passed on both sides of every drift
/// they were supposed to catch, because each side asserted its own restatement.
///
/// A relay has no fields to get wrong. What it can get wrong is the allow-list, the concurrency
/// bound, the chunk boundaries, and the lifetime of a transfer -- so those are what is here.
@Suite("agent-feed relay")
struct AgentFeedHTTPRelayTests {
    @Test func refusesPathsOutsideTheSidecarAPI() {
        #expect(AgentFeedRelay.PathPolicy.allows(path: "/api/inventory/stream"))
        #expect(AgentFeedRelay.PathPolicy.allows(path: "/api/sessions/claude/s1/timeline?mode=nice"))
        // Everything a path could name other than the sidecar's own API.
        #expect(!AgentFeedRelay.PathPolicy.allows(path: "/health"))
        #expect(!AgentFeedRelay.PathPolicy.allows(path: "/api/../secrets"))
        #expect(!AgentFeedRelay.PathPolicy.allows(path: "http://evil.example/api/x"))
        #expect(!AgentFeedRelay.PathPolicy.allows(path: "//evil.example/api/x"))
        #expect(!AgentFeedRelay.PathPolicy.allows(path: "/api/\\..\\etc"))
        #expect(!AgentFeedRelay.PathPolicy.allows(method: "DELETE"))
        #expect(AgentFeedRelay.PathPolicy.allows(method: "post"))
    }

    @Test func aRefusedPathIsAnsweredWithAnErrorAndNeverReachesTheSidecar() async {
        let client = RecordingRelayClient()
        let sink = FrameSink()
        let relay = AgentFeedHTTPRelay(client: client, send: sink.accept)

        relay.handleRequest(AgentFeedRelayRequest(rid: "r1", method: "GET", path: "/etc/passwd"))

        #expect(client.performed.isEmpty)
        #expect(sink.errors().map(\.rid) == ["r1"])
    }

    @Test func aResponseArrivesAsHeadThenChunksThenEnd() async {
        let client = RecordingRelayClient()
        let sink = FrameSink()
        let relay = AgentFeedHTTPRelay(client: client, send: sink.accept)

        relay.handleRequest(AgentFeedRelayRequest(rid: "r1", method: "GET", path: "/api/projects"))
        client.respond(status: 200, body: Data(#"{"projects":[]}"#.utf8))

        #expect(sink.heads() == [AgentFeedRelayHead(rid: "r1", status: 200)])
        #expect(sink.chunks().map(\.data) == [#"{"projects":[]}"#])
        #expect(sink.chunks().map(\.complete) == [true])
        #expect(sink.ends().map(\.rid) == ["r1"])
    }

    /// The reason chunking exists at all: a raw transcript line can be megabytes, and it must
    /// arrive as several frames that reassemble into exactly the bytes the sidecar sent.
    @Test func aLargeBodySplitsIntoNumberedChunksThatReassemble() async {
        let client = RecordingRelayClient()
        let sink = FrameSink()
        let relay = AgentFeedHTTPRelay(client: client, send: sink.accept)
        let body = String(repeating: "a", count: AgentFeedRelay.chunkBytes * 2 + 7)

        relay.handleRequest(AgentFeedRelayRequest(rid: "r1", method: "GET", path: "/api/raw"))
        client.respond(status: 200, body: Data(body.utf8))

        let chunks = sink.chunks()
        #expect(chunks.count == 3)
        #expect(chunks.map(\.seq) == [0, 1, 2])
        #expect(chunks.map(\.complete) == [false, false, true])
        #expect(chunks.map(\.data).joined() == body)
    }

    /// A split at an arbitrary byte would land mid-character and decode to a replacement
    /// character on the far side -- one silently corrupted character per megabyte, in a view
    /// whose whole promise is that it shows the file's exact bytes.
    @Test func aChunkBoundaryNeverSplitsACharacter() async {
        let client = RecordingRelayClient()
        let sink = FrameSink()
        let relay = AgentFeedHTTPRelay(client: client, send: sink.accept)
        // Four-byte characters do not divide the chunk size evenly, so the natural cut lands
        // inside one.
        let body = String(repeating: "😀", count: AgentFeedRelay.chunkBytes / 2)

        relay.handleRequest(AgentFeedRelayRequest(rid: "r1", method: "GET", path: "/api/raw"))
        client.respond(status: 200, body: Data(body.utf8))

        let chunks = sink.chunks()
        #expect(chunks.count > 1)
        #expect(!chunks.contains { $0.data.contains("\u{FFFD}") })
        #expect(chunks.map(\.data).joined() == body)
    }

    @Test func eachSubscriptionMessageCompletesOnItsOwn() async {
        let client = RecordingRelayClient()
        let sink = FrameSink()
        let relay = AgentFeedHTTPRelay(client: client, send: sink.accept)

        relay.handleRequest(AgentFeedRelayRequest(
            rid: "r1",
            method: "GET",
            path: "/api/sessions/claude/s1/timeline?mode=nice",
            stream: true
        ))
        client.open(status: 200)
        client.message(#"{"type":"timeline"}"#)
        client.message(#"{"type":"tail"}"#)

        let chunks = sink.chunks()
        // Numbered across the stream, not per message, so a reader that drops one can tell --
        // and each marked complete, so a message boundary is not confused with a chunk boundary.
        #expect(chunks.map(\.seq) == [0, 1])
        #expect(chunks.map(\.complete) == [true, true])
        #expect(sink.ends().isEmpty)
    }

    @Test func cancellingATransferStopsItAndFreesItsSlot() async {
        let client = RecordingRelayClient()
        let sink = FrameSink()
        let relay = AgentFeedHTTPRelay(client: client, send: sink.accept)

        relay.handleRequest(AgentFeedRelayRequest(rid: "r1", method: "GET", path: "/api/x", stream: true))
        relay.handleCancel(AgentFeedRelayCancel(rid: "r1"))
        // The slot is free again, so a later request is admitted rather than refused.
        relay.handleRequest(AgentFeedRelayRequest(rid: "r2", method: "GET", path: "/api/x", stream: true))

        #expect(client.subscribed == ["/api/x", "/api/x"])
        #expect(sink.errors().isEmpty)
    }

    @Test func moreConcurrentSubscriptionsThanTheCapAreRefusedRatherThanQueued() async {
        let client = RecordingRelayClient()
        let sink = FrameSink()
        let relay = AgentFeedHTTPRelay(client: client, send: sink.accept)

        for index in 0...AgentFeedRelay.maximumConcurrentStreams {
            relay.handleRequest(AgentFeedRelayRequest(
                rid: "r\(index)",
                method: "GET",
                path: "/api/x",
                stream: true
            ))
        }

        #expect(client.subscribed.count == AgentFeedRelay.maximumConcurrentStreams)
        #expect(sink.errors().map(\.rid) == ["r\(AgentFeedRelay.maximumConcurrentStreams)"])
    }

    /// The failure this split exists to prevent: a surface's resting subscriptions used to
    /// share one counter with its requests, so a panel that had opened enough of the tree
    /// was refused when it asked a question -- and the message blamed a concurrency limit
    /// nothing was actually contending for.
    @Test func subscriptionsAtTheirCapDoNotRefuseAOneShotRequest() async {
        let client = RecordingRelayClient()
        let sink = FrameSink()
        let relay = AgentFeedHTTPRelay(client: client, send: sink.accept)

        for index in 0..<AgentFeedRelay.maximumConcurrentStreams {
            relay.handleRequest(AgentFeedRelayRequest(
                rid: "s\(index)",
                method: "GET",
                path: "/api/x",
                stream: true
            ))
        }
        relay.handleRequest(AgentFeedRelayRequest(rid: "r1", method: "GET", path: "/api/sessions"))

        #expect(client.performed.count == 1)
        #expect(sink.errors().isEmpty)
    }

    @Test func moreConcurrentRequestsThanTheCapAreRefusedRatherThanQueued() async {
        let client = RecordingRelayClient()
        let sink = FrameSink()
        let relay = AgentFeedHTTPRelay(client: client, send: sink.accept)

        for index in 0...AgentFeedRelay.maximumConcurrentRequests {
            relay.handleRequest(AgentFeedRelayRequest(
                rid: "r\(index)",
                method: "GET",
                path: "/api/sessions"
            ))
        }

        #expect(client.performed.count == AgentFeedRelay.maximumConcurrentRequests)
        #expect(sink.errors().map(\.rid) == ["r\(AgentFeedRelay.maximumConcurrentRequests)"])
    }

    @Test func resetAbandonsEveryInFlightTransfer() async {
        let client = RecordingRelayClient()
        let sink = FrameSink()
        let relay = AgentFeedHTTPRelay(client: client, send: sink.accept)

        relay.handleRequest(AgentFeedRelayRequest(rid: "r1", method: "GET", path: "/api/x", stream: true))
        relay.handleRequest(AgentFeedRelayRequest(rid: "r2", method: "GET", path: "/api/y", stream: true))
        relay.reset()
        // Every slot is free, so a fresh request after a lane re-attach is admitted.
        relay.handleRequest(AgentFeedRelayRequest(rid: "r3", method: "GET", path: "/api/z", stream: true))

        #expect(client.subscribed == ["/api/x", "/api/y", "/api/z"])
        #expect(sink.errors().isEmpty)
    }

    @Test func anOversizedBodyIsRefusedBeforeItIsCopied() async {
        let client = RecordingRelayClient()
        let sink = FrameSink()
        let relay = AgentFeedHTTPRelay(client: client, send: sink.accept)

        relay.handleRequest(AgentFeedRelayRequest(
            rid: "r1",
            method: "POST",
            path: "/api/sessions",
            body: String(repeating: "x", count: AgentFeedRelay.PathPolicy.maximumBodyBytes + 1)
        ))

        #expect(client.performed.isEmpty)
        #expect(sink.errors().map(\.rid) == ["r1"])
    }

    @Test func aTransportFailureIsReportedOnTheRequestThatFailed() async {
        let client = RecordingRelayClient()
        let sink = FrameSink()
        let relay = AgentFeedHTTPRelay(client: client, send: sink.accept)

        relay.handleRequest(AgentFeedRelayRequest(rid: "r1", method: "GET", path: "/api/projects"))
        client.fail(SidecarClientError.server("sidecar is down"))

        #expect(sink.errors().map(\.rid) == ["r1"])
        #expect(sink.ends().isEmpty)
    }
}

// MARK: - Doubles

/// Collects the relay's outgoing frames, decoded back into the structs it sent.
private final class FrameSink: @unchecked Sendable {
    private let lock = NSLock()
    private var frames: [Data] = []

    func accept(_ data: Data) {
        lock.lock()
        frames.append(data)
        lock.unlock()
    }

    /// Decoding is by tag, because every frame decodes as any other with matching fields --
    /// an end frame is a prefix of an error frame.
    ///
    /// An unreadable frame is REPORTED, not skipped. Skipping is how this sink came to claim the
    /// relay had emitted nothing: when the wire moved its tag from `type` to `t`, every frame
    /// stopped decoding here, `try?` turned that into an empty array, and eight tests blamed the
    /// relay for a change in the envelope. The two that assert no error was sent were worse off --
    /// they passed, for exactly the same reason, because nothing is also no errors.
    private func tagged<T: Decodable>(_ tag: String, as type: T.Type) -> [T] {
        lock.lock()
        let snapshot = frames
        lock.unlock()
        return snapshot.compactMap { data in
            let json = String(decoding: data, as: UTF8.self)
            guard let header = try? JSONDecoder().decode(Tag.self, from: data) else {
                Issue.record("relay frame is not tagged under `t`, so no reader can route it: \(json)")
                return nil
            }
            guard header.type == tag else { return nil }
            do {
                return try JSONDecoder().decode(type, from: data)
            } catch {
                Issue.record("frame tagged \(tag) does not decode as \(type): \(json)")
                return nil
            }
        }
    }

    func heads() -> [AgentFeedRelayHead] { tagged("agent-http-head", as: AgentFeedRelayHead.self) }
    func chunks() -> [AgentFeedRelayChunk] { tagged("agent-http-chunk", as: AgentFeedRelayChunk.self) }
    func ends() -> [AgentFeedRelayEnd] { tagged("agent-http-end", as: AgentFeedRelayEnd.self) }
    func errors() -> [AgentFeedRelayError] { tagged("agent-http-err", as: AgentFeedRelayError.self) }

    /// Reads a frame's tag and nothing else, so a frame can be routed before it is decoded as
    /// anything in particular.
    ///
    /// The key is `t`, not `type`. That is the whole point of the spelling: the tag shares a
    /// channel every reader matches `t` on, and `AgentFeedRelayFrames.swift` explains at length
    /// why any other key silences the host-to-panel direction. It is restated here because
    /// `CodingKeys` takes a literal, and it is pinned against the real encoding by
    /// `agentFeedRelayFramesTagThemselvesUnderTheKeyThePanelReads` in AgentDeskWire's own tests.
    private struct Tag: Decodable {
        let type: String

        enum CodingKeys: String, CodingKey {
            case type = "t"
        }
    }
}

/// A sidecar transport that records what it was asked for and answers on command.
private final class RecordingRelayClient: AgentFeedRelayClient, @unchecked Sendable {
    private let lock = NSLock()
    private var _performed: [(method: String, path: String)] = []
    private var _subscribed: [String] = []
    private var onResponse: ((Int, Data) -> Void)?
    private var onOpen: ((Int) -> Void)?
    private var onMessage: ((String) -> Void)?
    private var onError: ((Error) -> Void)?

    var performed: [(method: String, path: String)] {
        lock.lock(); defer { lock.unlock() }
        return _performed
    }

    var subscribed: [String] {
        lock.lock(); defer { lock.unlock() }
        return _subscribed
    }

    func perform(
        method: String,
        path: String,
        body: Data?,
        onResponse: @escaping @Sendable (Int, Data) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> SidecarStreamHandle {
        lock.lock()
        _performed.append((method, path))
        self.onResponse = onResponse
        self.onError = onError
        lock.unlock()
        return SidecarStreamHandle(task: Task {})
    }

    func subscribe(
        path: String,
        onOpen: @escaping @Sendable (Int) -> Void,
        onMessage: @escaping @Sendable (String) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> SidecarStreamHandle {
        lock.lock()
        _subscribed.append(path)
        self.onOpen = onOpen
        self.onMessage = onMessage
        self.onError = onError
        lock.unlock()
        return SidecarStreamHandle(task: Task {})
    }

    func respond(status: Int, body: Data) {
        lock.lock(); let callback = onResponse; lock.unlock()
        callback?(status, body)
    }

    func open(status: Int) {
        lock.lock(); let callback = onOpen; lock.unlock()
        callback?(status)
    }

    func message(_ payload: String) {
        lock.lock(); let callback = onMessage; lock.unlock()
        callback?(payload)
    }

    func fail(_ error: Error) {
        lock.lock(); let callback = onError; lock.unlock()
        callback?(error)
    }
}
