import Foundation

@MainActor
public final class AgentPanelSerialDelivery {
    public typealias Delivery = (String) async -> Void

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
            let rawJSON = pending.removeFirst()
            await deliver(rawJSON)
        }
        worker = nil
        let waiters = idleWaiters
        idleWaiters = []
        for waiter in waiters {
            waiter.resume()
        }
    }
}
