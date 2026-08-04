import Foundation

/// Counts the SSE streams the sidecar client is holding open, so a stream that is never torn down
/// becomes visible while it is still only eating headroom rather than once it has filled the pool.
///
/// It counts INTENT, not established sockets: a stream is counted from the moment it is asked for,
/// including while it waits for a free connection. That is deliberate, because a count above the
/// pool's limit IS the starvation state, and a census that only counted connections it had actually
/// got would fall silent at exactly the moment it was needed.
///
/// Reported as transitions rather than a level so a steady state at the mark prints once, not on
/// every stream that opens after it. The mark re-arms only after the count falls back below it.
final class AgentFeedStreamCensus: @unchecked Sendable {
    /// `@unchecked` because the counters are plain storage guarded by `lock`; nothing here is
    /// readable without taking it.
    enum Transition: Equatable {
        case quiet
        case reachedWatermark(live: Int, watermark: Int, limit: Int)
        case recovered(live: Int, watermark: Int)
    }

    private let lock = NSLock()
    private let limit: Int
    private let watermark: Int
    private var live = 0
    private var warned = false

    init(limit: Int, watermark: Int? = nil) {
        self.limit = limit
        // Three quarters of the pool: high enough that ordinary multi-window use stays silent, low
        // enough that the warning still arrives with room to act on it.
        self.watermark = watermark ?? max(1, limit * 3 / 4)
    }

    var liveCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return live
    }

    func opened() -> Transition {
        lock.lock()
        defer { lock.unlock() }
        live += 1
        guard !warned, live >= watermark else { return .quiet }
        warned = true
        return .reachedWatermark(live: live, watermark: watermark, limit: limit)
    }

    func closed() -> Transition {
        lock.lock()
        defer { lock.unlock() }
        // Floored rather than allowed to go negative: a double close would otherwise silently buy
        // back headroom the pool does not have, which is the opposite of what this exists to catch.
        live = max(0, live - 1)
        guard warned, live < watermark else { return .quiet }
        warned = false
        return .recovered(live: live, watermark: watermark)
    }
}
