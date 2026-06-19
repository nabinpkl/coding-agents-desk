import Foundation

final class WebSocketSignalingChannel: SignalingChannel, @unchecked Sendable {
    private let closer: @Sendable () -> Void
    private var closed = false
    private let lock = NSLock()

    init(closer: @escaping @Sendable () -> Void) {
        self.closer = closer
    }

    func close() {
        lock.lock()
        defer { lock.unlock() }
        guard !closed else { return }
        closed = true
        closer()
    }
}
