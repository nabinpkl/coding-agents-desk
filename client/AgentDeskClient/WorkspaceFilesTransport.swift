import Foundation
import Network
import AgentDeskWire

enum WorkspaceFilesTransportError: Error, Equatable {
    case notStarted
    case closed
    case unexpectedRole(QuicSessionStreamRole)
    case malformedResponse
}

/// The frame plumbing the transport rides on, abstracted so the request/response correlation can be
/// tested without a live QUIC stream. `receive()` yields one `.files` response payload at a time.
protocol WorkspaceFilesFrameChannel: Sendable {
    func send(_ payload: Data) async throws
    func receive() async throws -> Data
    func close()
}

/// Client side of the authenticated Files lane. It opens the lane, then correlates each
/// `WorkspaceFileRequest` with its `WorkspaceFileResponse` by request id, so responses may arrive in
/// any order. On teardown every in-flight request is failed rather than left hanging. It rides its
/// own `.files` stream, so it can never block the input or media lanes.
actor WorkspaceFilesTransport {
    private let channel: WorkspaceFilesFrameChannel
    private var pending: [String: CheckedContinuation<WorkspaceFileResponse, Error>] = [:]
    private var receiveTask: Task<Void, Never>?
    private var closed = false

    init(channel: WorkspaceFilesFrameChannel) {
        self.channel = channel
    }

    /// Announces the lane to the host (the first frame's role is what routes the stream) and starts
    /// reading responses. Idempotent.
    func open() async throws {
        guard !closed, receiveTask == nil else { return }
        // A non-empty announce frame: the host consumes this first frame purely to route the
        // `.files` lane, and a zero-length frame would stall its stream read.
        try await channel.send(Data([0]))
        receiveTask = Task { [weak self] in
            await self?.receiveLoop()
        }
    }

    func request(_ request: WorkspaceFileRequest) async throws -> WorkspaceFileResponse {
        guard !closed else { throw WorkspaceFilesTransportError.closed }
        guard receiveTask != nil else { throw WorkspaceFilesTransportError.notStarted }
        let payload = try JSONEncoder().encode(request)
        let key = request.requestID.value
        return try await withCheckedThrowingContinuation { continuation in
            // Register before sending so a fast response can never race ahead of the waiter.
            pending[key] = continuation
            Task { [weak self] in
                await self?.deliver(payload, key: key)
            }
        }
    }

    func close() {
        guard !closed else { return }
        closed = true
        receiveTask?.cancel()
        receiveTask = nil
        let waiting = pending
        pending.removeAll()
        channel.close()
        for (_, continuation) in waiting {
            continuation.resume(throwing: WorkspaceFilesTransportError.closed)
        }
    }

    private func deliver(_ payload: Data, key: String) async {
        do {
            try await channel.send(payload)
        } catch {
            // The send failed; fail this request if the response has not already resolved it.
            if let continuation = pending.removeValue(forKey: key) {
                continuation.resume(throwing: error)
            }
        }
    }

    private func receiveLoop() async {
        while !closed {
            let payload: Data
            do {
                payload = try await channel.receive()
            } catch {
                break
            }
            guard let response = try? JSONDecoder().decode(WorkspaceFileResponse.self, from: payload) else {
                // A response we cannot decode is a protocol break, not a per-request error we can
                // route (there is no id to correlate). Drop the frame and keep serving the lane.
                continue
            }
            if let continuation = pending.removeValue(forKey: response.requestID.value) {
                continuation.resume(returning: response)
            }
        }
        failAllPending()
    }

    private func failAllPending() {
        guard !closed else { return }
        let waiting = pending
        pending.removeAll()
        for (_, continuation) in waiting {
            continuation.resume(throwing: WorkspaceFilesTransportError.closed)
        }
    }
}

/// Live channel over an authenticated `.files` QUIC stream.
@available(iOS 26.0, *)
final class QuicWorkspaceFilesChannel: WorkspaceFilesFrameChannel, @unchecked Sendable {
    private let stream: QUIC.Stream<QUICStream>

    init(stream: QUIC.Stream<QUICStream>) {
        self.stream = stream
    }

    func send(_ payload: Data) async throws {
        try await QuicSessionStreamIO.sendPayload(payload, role: .files, on: stream)
    }

    func receive() async throws -> Data {
        let frame = try await QuicSessionStreamIO.receiveFrame(on: stream)
        guard frame.role == .files else {
            throw WorkspaceFilesTransportError.unexpectedRole(frame.role)
        }
        return frame.payload
    }

    func close() {
        Task { [stream] in
            try? await stream.send(Data(), endOfStream: true)
        }
    }
}
