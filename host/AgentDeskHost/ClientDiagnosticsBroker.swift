import Foundation
import AgentDeskWire

enum ClientDiagnosticsRequesterError: Error, LocalizedError {
    case noActiveSession
    case timedOut
    case unavailable
    case unauthorized
    case malformedResponse
    case remote(String)

    var errorDescription: String? {
        switch self {
        case .noActiveSession:
            "no active client session"
        case .timedOut:
            "diagnostics request timed out"
        case .unavailable:
            "client diagnostics unavailable"
        case .unauthorized:
            "client rejected diagnostics authentication"
        case .malformedResponse:
            "client returned a malformed diagnostics response"
        case .remote(let reason):
            reason
        }
    }
}

@MainActor
protocol ClientDiagnosticsCollecting: AnyObject {
    func collect(_ request: DiagnosticsRequest) async throws -> CollectedClientDiagnostics
    func cancel()
}

/// The sole iterator over an input lane's diagnostics stream. It routes request
/// IDs to collectors and keeps unsolicited reconnect announcements separate.
@MainActor
final class ClientDiagnosticsBroker: ClientDiagnosticsCollecting {
    typealias AnnouncementHandler = @MainActor (DiagnosticsSummary) -> Void

    private struct Pending {
        var summary: DiagnosticsSummary?
        var payloads: [String: Data] = [:]
        var nextSequence = 0
        let continuation: CheckedContinuation<CollectedClientDiagnostics, Error>
    }

    private let server: any InputChannelServing
    private let timeoutSeconds: TimeInterval
    private let announcementHandler: AnnouncementHandler
    private var pending: [String: Pending] = [:]
    private var receiveTask: Task<Void, Never>?

    init(
        server: any InputChannelServing,
        timeoutSeconds: TimeInterval = Config.diagnosticsRequestTimeoutSeconds,
        announcementHandler: @escaping AnnouncementHandler
    ) {
        self.server = server
        self.timeoutSeconds = timeoutSeconds
        self.announcementHandler = announcementHandler
    }

    func start() {
        guard receiveTask == nil else { return }
        receiveTask = Task { [weak self, server] in
            for await update in server.diagnosticsUpdates {
                guard let self else { return }
                self.route(update)
            }
            self?.failAll(ClientDiagnosticsRequesterError.unavailable)
        }
    }

    func collect(_ request: DiagnosticsRequest) async throws -> CollectedClientDiagnostics {
        guard receiveTask != nil else {
            throw ClientDiagnosticsRequesterError.unavailable
        }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                guard pending[request.requestId] == nil else {
                    continuation.resume(throwing: ClientDiagnosticsRequesterError.malformedResponse)
                    return
                }
                pending[request.requestId] = Pending(continuation: continuation)
                server.pushDiagnosticsRequest(request)
                Task { [weak self] in
                    guard let timeoutSeconds = self?.timeoutSeconds else { return }
                    try? await Task.sleep(for: .seconds(timeoutSeconds))
                    guard !Task.isCancelled else { return }
                    self?.fail(
                        requestId: request.requestId,
                        error: ClientDiagnosticsRequesterError.timedOut
                    )
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                self?.fail(
                    requestId: request.requestId,
                    error: CancellationError()
                )
            }
        }
    }

    func cancel() {
        receiveTask?.cancel()
        receiveTask = nil
        failAll(ClientDiagnosticsRequesterError.unavailable)
    }

    private func route(_ update: DiagnosticsChannelUpdate) {
        switch update {
        case .summary(let summary) where summary.requestId.hasPrefix("announce-"):
            announcementHandler(summary)
        case .summary(let summary):
            guard var request = pending[summary.requestId] else { return }
            request.summary = summary
            pending[summary.requestId] = request
            if summary.runs.isEmpty {
                finish(
                    requestId: summary.requestId,
                    result: CollectedClientDiagnostics(summary: summary, runPayloads: [:])
                )
            }
        case .chunk(let chunk):
            guard var request = pending[chunk.requestId],
                  chunk.sequence == request.nextSequence else {
                fail(
                    requestId: chunk.requestId,
                    error: ClientDiagnosticsRequesterError.malformedResponse
                )
                return
            }
            guard let bytes = Data(base64Encoded: chunk.payloadBase64) else {
                fail(
                    requestId: chunk.requestId,
                    error: ClientDiagnosticsRequesterError.malformedResponse
                )
                return
            }
            request.nextSequence += 1
            request.payloads[chunk.runId, default: Data()].append(bytes)
            pending[chunk.requestId] = request
            if chunk.isFinal {
                guard let summary = request.summary else {
                    fail(
                        requestId: chunk.requestId,
                        error: ClientDiagnosticsRequesterError.malformedResponse
                    )
                    return
                }
                finish(
                    requestId: chunk.requestId,
                    result: CollectedClientDiagnostics(
                        summary: summary,
                        runPayloads: request.payloads
                    )
                )
            }
        case .error(let remote):
            let error: Error = remote.reason == "unauthorized"
                ? ClientDiagnosticsRequesterError.unauthorized
                : ClientDiagnosticsRequesterError.remote(remote.reason)
            fail(requestId: remote.requestId, error: error)
        }
    }

    private func finish(requestId: String, result: CollectedClientDiagnostics) {
        pending.removeValue(forKey: requestId)?.continuation.resume(returning: result)
    }

    private func fail(requestId: String, error: Error) {
        pending.removeValue(forKey: requestId)?.continuation.resume(throwing: error)
    }

    private func failAll(_ error: Error) {
        let active = pending.values
        pending.removeAll()
        for request in active {
            request.continuation.resume(throwing: error)
        }
    }
}
