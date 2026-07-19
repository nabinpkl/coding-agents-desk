import Foundation
import Network
import os
import AgentDeskWire

enum WorkspaceLaneServerError: Error, Equatable {
    case unexpectedRole(QuicSessionStreamRole)
    case malformedRequest
    case notStarted
}

/// Serves one authenticated protocol-v11 workspace lane on the `.files` stream. Requests and
/// unsolicited pushes share one actor-serialized writer so concurrent observation and IDE-state
/// fan-out cannot interleave application frames.
@available(macOS 26.0, *)
final class WorkspaceLaneServer: @unchecked Sendable {
    typealias RequestHandler = @Sendable (WorkspaceLaneRequest) async -> WorkspaceLaneResponse

    private let stream: QUIC.Stream<QUICStream>
    private let fingerprint: DeviceFingerprint
    private let writer: WorkspaceLaneWriter
    private let logger = Logger(subsystem: Config.logSubsystem, category: "workspace-lane")
    private let stateLock = NSLock()
    private var task: Task<Void, Never>?
    private var stopped = false

    /// The request dispatcher. The host sets this in its lane-ready handler before `start()`.
    var handleRequest: RequestHandler?
    var onClose: (() -> Void)?

    init(stream: QUIC.Stream<QUICStream>, fingerprint: DeviceFingerprint) {
        self.stream = stream
        self.fingerprint = fingerprint
        writer = WorkspaceLaneWriter(stream: stream)
    }

    func start() {
        stateLock.lock()
        guard task == nil, !stopped else {
            stateLock.unlock()
            return
        }
        let started = Task { await self.run() }
        task = started
        stateLock.unlock()
    }

    func stop() {
        stateLock.lock()
        stopped = true
        let started = task
        task = nil
        stateLock.unlock()
        started?.cancel()
    }

    func push(_ response: WorkspaceLaneResponse) async throws {
        guard response.requestID == nil else {
            throw WorkspaceLaneServerError.malformedRequest
        }
        try await writer.send(response)
    }

    private func finish() {
        stateLock.lock()
        task = nil
        stateLock.unlock()
        onClose?()
    }

    private func run() async {
        defer { finish() }
        guard let handleRequest else {
            logger.error("workspace lane started without a request handler; closing")
            return
        }
        do {
            while !Task.isCancelled {
                let frame = try await QuicSessionStreamIO.receiveFrame(on: stream, expectedRole: .files)
                guard frame.role == .files else {
                    throw WorkspaceLaneServerError.unexpectedRole(frame.role)
                }
                let responsePayload = try await Self.responsePayload(
                    for: frame.payload,
                    handleRequest: handleRequest
                )
                try await writer.sendPayload(responsePayload)
            }
        } catch {
            logger.notice(
                "workspace lane ended fp=\(self.fingerprint.rawValue, privacy: .public) error=\(String(describing: error), privacy: .public)"
            )
        }
    }

    /// Pure request/response codec, factored out so the framing contract is unit-testable without a
    /// live QUIC stream. Decodes the request, dispatches it, and encodes the response. A payload
    /// that is not a valid request throws `malformedRequest` so the caller can close the lane.
    static func responsePayload(
        for payload: Data,
        handleRequest: RequestHandler
    ) async throws -> Data {
        let request: WorkspaceLaneRequest
        do {
            request = try WorkspaceLaneCodec.decodeRequest(payload)
        } catch {
            throw WorkspaceLaneServerError.malformedRequest
        }
        let response = await handleRequest(request)
        return try WorkspaceLaneCodec.encode(response)
    }
}

@available(macOS 26.0, *)
private actor WorkspaceLaneWriter {
    private let stream: QUIC.Stream<QUICStream>

    init(stream: QUIC.Stream<QUICStream>) {
        self.stream = stream
    }

    func send(_ response: WorkspaceLaneResponse) async throws {
        try await sendPayload(WorkspaceLaneCodec.encode(response))
    }

    func sendPayload(_ payload: Data) async throws {
        try await QuicSessionStreamIO.sendPayload(payload, role: .files, on: stream)
    }
}
