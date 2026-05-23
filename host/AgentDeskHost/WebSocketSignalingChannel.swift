import Foundation

// ADR-0004 SignalingChannel impl, host side. Wraps a post-SessionReady
// connection. PairingSignalingServer constructs one per ActiveSession,
// holds it in the connection context, and delivers WebRTCSignalingFrames
// into it as they arrive. Outbound sends go through a closure so this
// type doesn't import Network.

final class WebSocketSignalingChannel: SignalingChannel, @unchecked Sendable {
    let inbound: AsyncStream<WebRTCSignalingFrame>
    private let continuation: AsyncStream<WebRTCSignalingFrame>.Continuation
    private let sender: @Sendable (WebRTCSignalingFrame) async throws -> Void
    private let closer: @Sendable () -> Void
    private var closed = false
    private let lock = NSLock()

    init(
        sender: @escaping @Sendable (WebRTCSignalingFrame) async throws -> Void,
        closer: @escaping @Sendable () -> Void
    ) {
        var continuation: AsyncStream<WebRTCSignalingFrame>.Continuation!
        inbound = AsyncStream { continuation = $0 }
        self.continuation = continuation
        self.sender = sender
        self.closer = closer
    }

    func send(_ frame: WebRTCSignalingFrame) async throws {
        try await sender(frame)
    }

    func deliver(_ frame: WebRTCSignalingFrame) {
        continuation.yield(frame)
    }

    func close() {
        lock.lock()
        defer { lock.unlock() }
        guard !closed else { return }
        closed = true
        continuation.finish()
        closer()
    }
}
