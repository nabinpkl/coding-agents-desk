import Foundation
import Network
import os
import AgentDeskWire

enum WorkspaceFilesLaneError: Error, Equatable {
    case unexpectedRole(QuicSessionStreamRole)
    case malformedRequest
    case notStarted
}

/// Serves one authenticated `.files` QUIC stream (binary body codec in protocol 8, ADR-0057). It reads a
/// `WorkspaceFileRequest` per frame, dispatches it through the injected handler (which resolves the
/// current workspace store and applies root-scoped file semantics), and writes back the correlated
/// `WorkspaceFileResponse`. All filesystem authority lives behind the handler; this type only
/// frames and correlates. A malformed frame closes the lane rather than guessing a response.
@available(macOS 26.0, *)
final class WorkspaceFilesLaneServer: @unchecked Sendable {
    /// Resolves one request to its response. Async so the host can read the current store from the
    /// `WorkspaceRepository` actor before applying file semantics.
    typealias RequestHandler = @Sendable (WorkspaceFileRequest) async -> WorkspaceFileResponse

    private let stream: QUIC.Stream<QUICStream>
    private let fingerprint: DeviceFingerprint
    private let logger = Logger(subsystem: Config.logSubsystem, category: "workspace-files")
    private let stateLock = NSLock()
    private var task: Task<Void, Never>?
    private var stopped = false

    /// The request dispatcher. The host sets this in its lane-ready handler before `start()`.
    var handleRequest: RequestHandler?
    var onClose: (() -> Void)?

    init(stream: QUIC.Stream<QUICStream>, fingerprint: DeviceFingerprint) {
        self.stream = stream
        self.fingerprint = fingerprint
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

    private func finish() {
        stateLock.lock()
        task = nil
        stateLock.unlock()
        onClose?()
    }

    private func run() async {
        defer { finish() }
        guard let handleRequest else {
            logger.error("workspace files lane started without a request handler; closing")
            return
        }
        do {
            while !Task.isCancelled {
                let frame = try await QuicSessionStreamIO.receiveFrame(on: stream, expectedRole: .files)
                guard frame.role == .files else {
                    throw WorkspaceFilesLaneError.unexpectedRole(frame.role)
                }
                let responsePayload = try await Self.responsePayload(
                    for: frame.payload,
                    handleRequest: handleRequest
                )
                try await QuicSessionStreamIO.sendPayload(responsePayload, role: .files, on: stream)
            }
        } catch {
            logger.notice(
                "workspace files lane ended fp=\(self.fingerprint.rawValue, privacy: .public) error=\(String(describing: error), privacy: .public)"
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
        let request: WorkspaceFileRequest
        do {
            request = try WorkspaceFilesCodec.decodeRequest(payload)
        } catch {
            throw WorkspaceFilesLaneError.malformedRequest
        }
        let response = await handleRequest(request)
        return try WorkspaceFilesCodec.encode(response)
    }
}
