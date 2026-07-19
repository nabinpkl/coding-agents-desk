import Foundation
import Testing
import AgentDeskWire

@testable import AgentDeskClient

/// Records outbound frames and lets the test feed inbound response frames on demand. `receive()` is
/// driven by a single consumer (the transport's receive loop), so one AsyncStream iterator is safe.
private final class MockWorkspaceChannel: WorkspaceFrameChannel, @unchecked Sendable {
    private let lock = NSLock()
    private var sends: [Data] = []
    private let continuation: AsyncStream<Data>.Continuation
    private var iterator: AsyncStream<Data>.AsyncIterator

    init() {
        var capturedContinuation: AsyncStream<Data>.Continuation!
        let stream = AsyncStream<Data> { capturedContinuation = $0 }
        continuation = capturedContinuation
        iterator = stream.makeAsyncIterator()
    }

    func send(_ payload: Data) async throws {
        lock.withLock { sends.append(payload) }
    }

    func receive() async throws -> Data {
        guard let next = await iterator.next() else { throw CancellationError() }
        return next
    }

    func close() {
        continuation.finish()
    }

    func deliver(_ response: WorkspaceLaneResponse) {
        continuation.yield((try? WorkspaceLaneCodec.encode(response)) ?? Data())
    }

    func deliverRaw(_ data: Data) {
        continuation.yield(data)
    }

    var recordedSendCount: Int { lock.withLock { sends.count } }
}

private func readRequest(_ id: String) -> WorkspaceLaneRequest {
    .files(.read(requestID: WorkspaceRequestID(value: id), workspaceID: "w", path: "note.txt"))
}

private func readResponse(_ id: String, text: String) -> WorkspaceLaneResponse {
    .files(.read(
        requestID: WorkspaceRequestID(value: id),
        result: WorkspaceFileReadResult(
            workspaceID: "w", path: "note.txt", text: text,
            revision: WorkspaceFileRevision(digest: id)
        )
    ))
}

struct WorkspaceTransportTests {
    /// Once a request's outbound frame is recorded, its continuation is already registered (the
    /// transport registers before it sends), so waiting on the send count gates delivery safely.
    private func waitForSends(_ channel: MockWorkspaceChannel, count: Int) async {
        while channel.recordedSendCount < count { await Task.yield() }
    }

    @Test func correlatesResponsesToRequestsRegardlessOfArrivalOrder() async throws {
        let channel = MockWorkspaceChannel()
        let transport = WorkspaceTransport(channel: channel)
        try await transport.open()

        async let first = transport.request(readRequest("A"))
        async let second = transport.request(readRequest("B"))

        // announce + two request frames == 3 sends recorded => both waiters registered.
        await waitForSends(channel, count: 3)
        channel.deliver(readResponse("B", text: "beta"))
        channel.deliver(readResponse("A", text: "alpha"))

        let (a, b) = try await (first, second)
        #expect(a.requestID?.value == "A")
        #expect(b.requestID?.value == "B")
        if case .files(.read(_, let result)) = a { #expect(result.text == "alpha") } else { Issue.record("expected read") }
        if case .files(.read(_, let result)) = b { #expect(result.text == "beta") } else { Issue.record("expected read") }
    }

    @Test func teardownFailsEveryInFlightRequest() async throws {
        let channel = MockWorkspaceChannel()
        let transport = WorkspaceTransport(channel: channel)
        try await transport.open()

        let inflight = Task { try await transport.request(readRequest("A")) }
        await waitForSends(channel, count: 2) // announce + the request

        await transport.close()

        await #expect(throws: WorkspaceTransportError.closed) {
            _ = try await inflight.value
        }
    }

    @Test func duplicateRequestIDFailsLoudInsteadOfLeaking() async throws {
        let channel = MockWorkspaceChannel()
        let transport = WorkspaceTransport(channel: channel)
        try await transport.open()

        async let first = transport.request(readRequest("A"))
        await waitForSends(channel, count: 2) // announce + first request registered

        await #expect(throws: WorkspaceTransportError.duplicateRequestID("A")) {
            _ = try await transport.request(readRequest("A"))
        }

        // The first request still resolves normally.
        channel.deliver(readResponse("A", text: "alpha"))
        let resolved = try await first
        #expect(resolved.requestID?.value == "A")
    }

    @Test func undecodableResponseClosesTransportAndFailsPending() async throws {
        let channel = MockWorkspaceChannel()
        let transport = WorkspaceTransport(channel: channel)
        try await transport.open()

        let inflight = Task { try await transport.request(readRequest("A")) }
        await waitForSends(channel, count: 2)
        channel.deliverRaw(Data("not a response".utf8))

        await #expect(throws: WorkspaceTransportError.malformedResponse) {
            _ = try await inflight.value
        }
    }

    @Test func requestBeforeOpenThrowsNotStarted() async {
        let transport = WorkspaceTransport(channel: MockWorkspaceChannel())
        await #expect(throws: WorkspaceTransportError.notStarted) {
            _ = try await transport.request(readRequest("A"))
        }
    }

    @Test func deliversErrorResponsesToTheWaitingRequest() async throws {
        let channel = MockWorkspaceChannel()
        let transport = WorkspaceTransport(channel: channel)
        try await transport.open()

        async let response = transport.request(readRequest("A"))
        await waitForSends(channel, count: 2)
        channel.deliver(.files(.error(
            requestID: WorkspaceRequestID(value: "A"),
            error: WorkspaceFileError(code: .notFound, message: "gone")
        )))

        guard case .files(.error(_, let error)) = try await response else {
            Issue.record("expected an error response")
            return
        }
        #expect(error.code == .notFound)
    }

    @Test func publishesUnsolicitedWorkspaceEventsWithoutConsumingARequest() async throws {
        let channel = MockWorkspaceChannel()
        let transport = WorkspaceTransport(channel: channel)
        try await transport.open()
        let events = await transport.events()
        let firstEvent = Task { await events.first(where: { _ in true }) }

        channel.deliver(.workspaceChanged(WorkspaceChangedPush(
            workspaceID: "w",
            generation: 3,
            changedPaths: ["note.txt"]
        )))

        guard case .workspaceChanged(let push) = await firstEvent.value else {
            Issue.record("expected workspace change push")
            return
        }
        #expect(push.generation == 3)
    }
}
