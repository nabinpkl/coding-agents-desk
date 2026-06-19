import Foundation

final class WebSocketSignalingChannel: SignalingChannel, InputCapabilityRefreshing, @unchecked Sendable {
    private let capabilityRequestSender: @Sendable (InputCapabilityRefreshRequest) async throws -> Void
    private let capabilityGrants: AsyncStream<InputCapabilityGrant>
    private let capabilityGrantContinuation: AsyncStream<InputCapabilityGrant>.Continuation
    private let closer: @Sendable () -> Void
    private var pendingRefreshes: [String: CheckedContinuation<InputCapabilityGrant, Error>] = [:]
    private var closed = false
    private let lock = NSLock()

    init(
        capabilityRequestSender: @escaping @Sendable (InputCapabilityRefreshRequest) async throws -> Void,
        closer: @escaping @Sendable () -> Void
    ) {
        var capabilityGrantContinuation: AsyncStream<InputCapabilityGrant>.Continuation!
        capabilityGrants = AsyncStream { capabilityGrantContinuation = $0 }
        self.capabilityGrantContinuation = capabilityGrantContinuation
        self.capabilityRequestSender = capabilityRequestSender
        self.closer = closer
    }

    func deliver(_ grant: InputCapabilityGrant) {
        capabilityGrantContinuation.yield(grant)
        resumePendingRefresh(sessionId: grant.sessionId, with: .success(grant))
    }

    func deliver(_ rejection: SessionRejected) {
        resumeAllPendingRefreshes(with: .failure(rejection))
    }

    func refreshInputCapability(deviceFingerprint: DeviceFingerprint, sessionId: String) async throws -> InputCapabilityGrant {
        let request = InputCapabilityRefreshRequest(
            deviceFingerprint: deviceFingerprint,
            sessionId: sessionId
        )
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                registerPendingRefresh(sessionId: sessionId, continuation: continuation)
                Task { [weak self, capabilityRequestSender] in
                    do {
                        try await capabilityRequestSender(request)
                    } catch {
                        self?.resumePendingRefresh(sessionId: sessionId, with: .failure(error))
                    }
                }
            }
        } onCancel: {
            resumePendingRefresh(sessionId: sessionId, with: .failure(CancellationError()))
        }
    }

    func close() {
        lock.lock()
        guard !closed else {
            lock.unlock()
            return
        }
        closed = true
        let pending = pendingRefreshes
        pendingRefreshes.removeAll()
        lock.unlock()
        capabilityGrantContinuation.finish()
        for continuation in pending.values {
            continuation.resume(throwing: SessionRejected(reason: .malformed))
        }
        closer()
    }

    private func registerPendingRefresh(
        sessionId: String,
        continuation: CheckedContinuation<InputCapabilityGrant, Error>
    ) {
        lock.lock()
        if closed {
            lock.unlock()
            continuation.resume(throwing: SessionRejected(reason: .malformed))
            return
        }
        if let previous = pendingRefreshes.updateValue(continuation, forKey: sessionId) {
            lock.unlock()
            previous.resume(throwing: SessionRejected(reason: .malformed))
            return
        }
        lock.unlock()
    }

    private func resumePendingRefresh(
        sessionId: String,
        with result: Result<InputCapabilityGrant, Error>
    ) {
        lock.lock()
        let continuation = pendingRefreshes.removeValue(forKey: sessionId)
        lock.unlock()
        guard let continuation else { return }
        continuation.resume(with: result)
    }

    private func resumeAllPendingRefreshes(with result: Result<InputCapabilityGrant, Error>) {
        lock.lock()
        let pending = pendingRefreshes
        pendingRefreshes.removeAll()
        lock.unlock()
        for continuation in pending.values {
            continuation.resume(with: result)
        }
    }
}

// SessionDialer's output: active session metadata after the per-connection
// handshake succeeds.
struct SessionHandshakeOutcome {
    let active: ActiveSession
    let signaling: SignalingChannel
    let inputCapability: InputCapabilityGrant
    let mediaCapability: MediaCapabilityGrant
}

// PairingClient.attemptSession's output: the handshake outcome plus
// the dedicated input transport opened in the same step. ADR-0005.
struct SessionConnection {
    let active: ActiveSession
    let signaling: SignalingChannel
    let inputChannel: InputChannel
    let mediaCapability: MediaCapabilityGrant
    let host: String
    let port: UInt16
}
