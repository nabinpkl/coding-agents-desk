import Foundation
import OSLog
import AgentDeskWire

/// Holds a redial until the path it will dial over has stopped moving.
///
/// Owns its own `LinkPathObserver` because the transport's dies with the session, and this is
/// needed in exactly the window where there is no session: between a link change tearing the
/// old one down and the new one being dialed.
///
/// Runs unconditionally rather than being started per handover. The gate needs the path's
/// recent history to know whether it has held still, and an observer started at the moment of
/// the handover has none -- it would report the first snapshot it ever saw as stable.
@available(iOS 26.0, *)
final class SessionPathReadiness: @unchecked Sendable {
    static let shared = SessionPathReadiness()

    private let logger = Logger(subsystem: Config.logSubsystem, category: "session-path")
    private let state: OSAllocatedUnfairLock<NetworkPathSettleGate>
    private let observer: LinkPathObserver
    private let startedAt: UInt64

    private init() {
        let start = DispatchTime.now().uptimeNanoseconds
        let state = OSAllocatedUnfairLock(
            initialState: NetworkPathSettleGate(debounceMs: Config.sessionPathSettleDebounceMs)
        )
        startedAt = start
        self.state = state
        // Captures the locals rather than `self`: the observer is a stored property of the
        // object whose init this is, so reaching back through `self` here would be reading it
        // mid-construction.
        observer = LinkPathObserver { [state] snapshot in
            let nowMs = Int((DispatchTime.now().uptimeNanoseconds &- start) / 1_000_000)
            state.withLock { $0.observe(snapshot, atMs: nowMs) }
        }
    }

    func start() {
        observer.start(queue: .main)
    }

    private var nowMs: Int {
        Int((DispatchTime.now().uptimeNanoseconds &- startedAt) / 1_000_000)
    }

    /// Waits for the path to hold still, giving up after `timeoutMs`.
    ///
    /// The timeout is not a failure path. A path that never settles is one we still have to
    /// dial over, and waiting longer than the doomed dial used to cost would trade one delay
    /// for another. Returns whether it settled, for the log only -- the caller dials either way.
    @discardableResult
    func waitUntilSettled(timeoutMs: Int = Config.sessionPathSettleTimeoutMs) async -> Bool {
        let deadline = nowMs + max(0, timeoutMs)
        var waitedMs = 0
        while true {
            if state.withLock({ $0.hasSettled(atMs: nowMs) }) {
                if waitedMs > 0 {
                    logger.notice("path settled after \(waitedMs, privacy: .public)ms; dialing")
                }
                return true
            }
            let remaining = deadline - nowMs
            guard remaining > 0 else {
                logger.notice("path unsettled after \(waitedMs, privacy: .public)ms; dialing anyway")
                return false
            }
            let step = min(Config.sessionPathSettlePollMs, remaining)
            try? await Task.sleep(nanoseconds: UInt64(step) * 1_000_000)
            if Task.isCancelled { return false }
            waitedMs += step
        }
    }
}
