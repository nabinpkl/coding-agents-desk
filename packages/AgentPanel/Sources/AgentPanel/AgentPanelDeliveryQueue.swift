import Foundation

@MainActor
public final class AgentPanelDeliveryQueue {
    public typealias Delivery = (String) -> Void

    private let deliver: Delivery
    private var pending: [String] = []
    private var ready = false
    private(set) public var isTornDown = false

    public init(deliver: @escaping Delivery) {
        self.deliver = deliver
    }

    public var pendingCount: Int {
        pending.count
    }

    public func enqueue(rawJSON: String) {
        guard !isTornDown else {
            return
        }
        if ready {
            deliver(rawJSON)
        } else {
            pending.append(rawJSON)
        }
    }

    public func markReady() {
        guard !isTornDown else {
            return
        }
        ready = true
        let queued = pending
        pending = []
        for rawJSON in queued {
            deliver(rawJSON)
        }
    }

    public func markNotReady() {
        guard !isTornDown else {
            return
        }
        ready = false
    }

    public func teardown() {
        isTornDown = true
        pending = []
    }
}
