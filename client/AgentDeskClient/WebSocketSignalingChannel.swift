import Foundation

// ADR-0004 SignalingChannel impl, client side. SessionDialer constructs one
// per successful handshake and starts a background receive loop on the
// underlying URLSessionWebSocketTask. The channel owns the task lifecycle;
// closing the channel cancels the task.

final class WebSocketSignalingChannel: SignalingChannel, InputCapabilityRefreshing, @unchecked Sendable {
    let inbound: AsyncStream<WebRTCSignalingFrame>
    private let continuation: AsyncStream<WebRTCSignalingFrame>.Continuation
    private let sender: @Sendable (WebRTCSignalingFrame) async throws -> Void
    private let capabilityRequestSender: @Sendable (InputCapabilityRefreshRequest) async throws -> Void
    private let capabilityGrants: AsyncStream<InputCapabilityGrant>
    private let capabilityGrantContinuation: AsyncStream<InputCapabilityGrant>.Continuation
    private let closer: @Sendable () -> Void
    private var closed = false
    private let lock = NSLock()

    init(
        sender: @escaping @Sendable (WebRTCSignalingFrame) async throws -> Void,
        capabilityRequestSender: @escaping @Sendable (InputCapabilityRefreshRequest) async throws -> Void,
        closer: @escaping @Sendable () -> Void
    ) {
        var continuation: AsyncStream<WebRTCSignalingFrame>.Continuation!
        inbound = AsyncStream { continuation = $0 }
        self.continuation = continuation
        var capabilityGrantContinuation: AsyncStream<InputCapabilityGrant>.Continuation!
        capabilityGrants = AsyncStream { capabilityGrantContinuation = $0 }
        self.capabilityGrantContinuation = capabilityGrantContinuation
        self.sender = sender
        self.capabilityRequestSender = capabilityRequestSender
        self.closer = closer
    }

    func send(_ frame: WebRTCSignalingFrame) async throws {
        try await sender(frame)
    }

    func deliver(_ frame: WebRTCSignalingFrame) {
        continuation.yield(frame)
    }

    func deliver(_ grant: InputCapabilityGrant) {
        capabilityGrantContinuation.yield(grant)
    }

    func refreshInputCapability(deviceFingerprint: DeviceFingerprint, sessionId: String) async throws -> InputCapabilityGrant {
        try await capabilityRequestSender(InputCapabilityRefreshRequest(
            deviceFingerprint: deviceFingerprint,
            sessionId: sessionId
        ))
        for await grant in capabilityGrants where grant.sessionId == sessionId {
            return grant
        }
        throw SessionRejected(reason: .malformed)
    }

    func close() {
        lock.lock()
        defer { lock.unlock() }
        guard !closed else { return }
        closed = true
        continuation.finish()
        capabilityGrantContinuation.finish()
        closer()
    }
}

// SessionDialer's output: the WebRTC signaling channel and the active
// session metadata, after the per-connection handshake succeeds.
struct SessionHandshakeOutcome {
    let active: ActiveSession
    let signaling: SignalingChannel
    let inputCapability: InputCapabilityGrant
}

// PairingClient.attemptSession's output: the handshake outcome plus
// the dedicated input transport opened in the same step. ADR-0005.
struct SessionConnection {
    let active: ActiveSession
    let signaling: SignalingChannel
    let inputChannel: InputChannel
}
