import Foundation

/// Serializes async native-to-JS deliveries so callAsyncJavaScript pushes never
/// overlap, preserving order, and delivers in BATCHES: everything queued while a
/// delivery is in flight is handed over as one array, so a burst of live feed
/// messages (a codex delta stream can exceed 60 messages/second) costs one
/// webview round trip and one JS task instead of one per message. The JS side
/// fans the batch out to the panel's own deliver function in order, which lets
/// React coalesce the updates into a single render per batch. A slow webview
/// grows the batches; a fast one keeps them tiny, so latency only rises when
/// the webview is the bottleneck. Generic; shared by every panel.
@MainActor
public final class WebPanelSerialDelivery {
    public typealias Delivery = ([String]) async -> Void

    /// Cap on one batch, so a pathological backlog cannot freeze the webview in
    /// a single oversized JS task. The remainder stays queued for the next batch.
    public static let maximumBatchSize = 256

    private let deliver: Delivery
    private var pending: [String] = []
    private var worker: Task<Void, Never>?
    private var idleWaiters: [CheckedContinuation<Void, Never>] = []
    private(set) public var isCancelled = false

    public init(deliver: @escaping Delivery) {
        self.deliver = deliver
    }

    public var pendingCount: Int {
        pending.count
    }

    public func enqueue(rawJSON: String) {
        guard !isCancelled else {
            return
        }
        pending.append(rawJSON)
        startWorkerIfNeeded()
    }

    public func cancel() {
        guard !isCancelled else {
            return
        }
        isCancelled = true
        pending = []
        worker?.cancel()
    }

    public func waitUntilIdle() async {
        guard worker != nil else {
            return
        }
        await withCheckedContinuation { continuation in
            idleWaiters.append(continuation)
        }
    }

    private func startWorkerIfNeeded() {
        guard worker == nil, !isCancelled else {
            return
        }
        worker = Task { @MainActor [weak self] in
            await self?.runWorker()
        }
    }

    private func runWorker() async {
        while !Task.isCancelled, !isCancelled, !pending.isEmpty {
            let batch = Array(pending.prefix(Self.maximumBatchSize))
            pending.removeFirst(batch.count)
            await deliver(batch)
        }
        worker = nil
        let waiters = idleWaiters
        idleWaiters = []
        for waiter in waiters {
            waiter.resume()
        }
    }
}
