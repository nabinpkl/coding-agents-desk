import Foundation

/// Keep a datagram receive loop alive across a transient error instead of ending it.
///
/// Both receive loops used to `return` on any thrown error, which turned every transient fault
/// into a permanent one. Measured on LTE: the host's control loop ended with
/// `POSIXErrorCode(22): Invalid argument` on four consecutive session teardowns, after which the
/// host could not read another keyframe request, frame ack or liveness probe on that connection
/// no matter what the network did afterwards. A session in that state is alive and deaf.
///
/// The errors are worth ending on only if they are terminal, and the evidence says they are not.
/// In the same run the client's probes 2, 3, 4 and 5 -- sent 2 seconds apart -- all arrived at the
/// host within 5 milliseconds of each other. The path had not died; it stalled for about six
/// seconds and flushed everything in a burst. A loop that gave up at the first error missed the
/// recovery it was waiting for by a fraction of the time it had already waited.
///
/// So the loop retries, with two bounds that matter:
///
/// - **Backoff**, because a connection that throws instantly would otherwise spin a core.
/// - **A finite budget**, because a receive loop that never gives up hides a genuinely dead
///   connection instead of reporting it. Past the budget it stops and says so.
///
/// One honest limitation: whether `receive()` can succeed again on the same connection object
/// after a given error is not something this can know, and it is not documented. If it cannot,
/// this changes a silent permanent deafness into a bounded, logged one -- still the better
/// failure, but the recovery has to be confirmed on a real link, not assumed here.
///
/// Cancellation is deliberately NOT handled by this type. It is the one genuinely terminal
/// signal, it is Swift-concurrency specific rather than a policy question, and the call site
/// already has `Task.isCancelled` in hand.
public struct DatagramReceiveRetry: Equatable, Sendable {
    /// What the loop should do after a throw.
    public enum Outcome: Equatable, Sendable {
        /// Wait this long, then call `receive()` again.
        case retry(backoffMs: Double)
        /// The failure run outlived its budget. Stop, and report these.
        case giveUp(failures: Int, elapsedMs: Double)
    }

    /// A failure run that ended, for the one line worth logging when it does.
    public struct Recovery: Equatable, Sendable {
        public let failures: Int
        public let outageMs: Double
    }

    /// Timing is fixed rather than configured: these are the shape of a retry, not an
    /// environment-dependent value. The budget is the thing worth tuning, so it is the only
    /// parameter -- and it is passed in rather than read here, because this package must not
    /// depend on either app's `Config`.
    private static let initialBackoffMs: Double = 50
    private static let maxBackoffMs: Double = 500

    private var consecutiveFailures: Int = 0
    private var firstFailureUptimeNs: UInt64?

    public init() {}

    /// True while a failure run is open, so a caller can log the first failure and stay quiet
    /// for the rest of the run rather than emitting a line per retry.
    public var isFailing: Bool { consecutiveFailures > 0 }

    public mutating func noteFailure(nowNs: UInt64, budgetMs: Double) -> Outcome {
        consecutiveFailures += 1
        let startedNs = firstFailureUptimeNs ?? nowNs
        if firstFailureUptimeNs == nil { firstFailureUptimeNs = nowNs }
        let elapsedMs = Double(nowNs >= startedNs ? nowNs - startedNs : 0) / 1_000_000
        // Compared AFTER the elapsed time is known rather than by counting failures: an error
        // that throws instantly and one that throws after a second would otherwise get wildly
        // different amounts of real time to recover in.
        guard elapsedMs < budgetMs else {
            return .giveUp(failures: consecutiveFailures, elapsedMs: elapsedMs)
        }
        return .retry(backoffMs: backoffMs(forFailure: consecutiveFailures))
    }

    /// Clears the run. Returns what it was, but only if there was one, so the caller can log the
    /// recovery edge without checking a counter itself.
    public mutating func noteSuccess(nowNs: UInt64) -> Recovery? {
        guard consecutiveFailures > 0 else { return nil }
        let startedNs = firstFailureUptimeNs
        let outageMs = startedNs.map { Double(nowNs >= $0 ? nowNs - $0 : 0) / 1_000_000 } ?? 0
        let recovery = Recovery(failures: consecutiveFailures, outageMs: outageMs)
        consecutiveFailures = 0
        firstFailureUptimeNs = nil
        return recovery
    }

    /// Exponential from the first failure, capped. Capped rather than unbounded because the
    /// backoff is protecting a CPU, not a server: nothing upstream is helped by waiting longer
    /// than half a second, and a long sleep would delay noticing the recovery.
    private func backoffMs(forFailure failure: Int) -> Double {
        let exponent = max(0, failure - 1)
        let scaled = Self.initialBackoffMs * pow(2, Double(min(exponent, 16)))
        return min(scaled, Self.maxBackoffMs)
    }
}
