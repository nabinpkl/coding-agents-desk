import Testing
@testable import AgentDeskWire

/// The behaviour that had to change: a receive loop that ended on the first thrown error turned
/// every transient network fault into a permanent deafness. These pin the two bounds that make
/// retrying safe -- it must outlast a real stall, and it must still give up on a dead connection.
@Suite struct DatagramReceiveRetryTests {
    private let budgetMs: Double = 30_000
    private let ms: UInt64 = 1_000_000

    /// The regression, stated as the measured case: a ~6s LTE stall must not end the loop. This
    /// is the whole point -- probes sent 2s apart arrived at the host within 5ms of each other
    /// after such a stall, so the recovery was there to be had and the old loop had already quit.
    @Test func aSixSecondStallDoesNotEndTheLoop() {
        var retry = DatagramReceiveRetry()
        var now: UInt64 = 0
        var elapsedMs: Double = 0
        while elapsedMs < 6_000 {
            let outcome = retry.noteFailure(nowNs: now, budgetMs: budgetMs)
            guard case .retry(let backoffMs) = outcome else {
                Issue.record("gave up \(elapsedMs)ms into a stall it must survive")
                return
            }
            elapsedMs += backoffMs
            now += UInt64(backoffMs) * ms
        }
        #expect(retry.isFailing)
    }

    /// The other bound. A loop that never gives up hides a dead connection instead of reporting
    /// it, so the budget has to actually end the run.
    @Test func aFailureRunPastTheBudgetGivesUp() {
        var retry = DatagramReceiveRetry()
        _ = retry.noteFailure(nowNs: 0, budgetMs: budgetMs)
        let outcome = retry.noteFailure(nowNs: UInt64(31_000) * ms, budgetMs: budgetMs)
        guard case .giveUp(let failures, let elapsedMs) = outcome else {
            Issue.record("expected giveUp past the budget, got \(outcome)")
            return
        }
        #expect(failures == 2)
        #expect(elapsedMs == 31_000)
    }

    /// The budget is spent in real time, not in failures. An error that throws instantly and one
    /// that throws after a second would otherwise get wildly different amounts of time to
    /// recover in, which makes the budget mean nothing.
    @Test func theBudgetIsMeasuredInElapsedTimeNotFailureCount() {
        var retry = DatagramReceiveRetry()
        for i in 1...500 {
            let outcome = retry.noteFailure(nowNs: UInt64(i) * ms, budgetMs: budgetMs)
            #expect(outcome != .giveUp(failures: i, elapsedMs: Double(i - 1)))
        }
        #expect(retry.isFailing)
    }

    /// Backoff exists to protect a core from a connection that throws instantly, and is capped
    /// because waiting longer helps nothing and delays noticing the recovery.
    @Test func backoffGrowsFromTheFirstFailureAndIsCapped() {
        var retry = DatagramReceiveRetry()
        var backoffs: [Double] = []
        for i in 0..<10 {
            guard case .retry(let backoffMs) = retry.noteFailure(nowNs: UInt64(i) * ms, budgetMs: budgetMs) else {
                Issue.record("unexpected giveUp inside the budget")
                return
            }
            backoffs.append(backoffMs)
        }
        #expect(backoffs.first == 50)
        #expect(backoffs.allSatisfy { $0 <= 500 })
        #expect(backoffs.last == 500)
        #expect(zip(backoffs, backoffs.dropFirst()).allSatisfy { $0 <= $1 }, "backoff must never shrink mid-run")
    }

    /// A success closes the run and reports it once, so the caller can log the recovery edge
    /// rather than a line per retry.
    @Test func successReportsTheRunItClosedThenStaysQuiet() {
        var retry = DatagramReceiveRetry()
        _ = retry.noteFailure(nowNs: 0, budgetMs: budgetMs)
        _ = retry.noteFailure(nowNs: UInt64(200) * ms, budgetMs: budgetMs)
        let recovered = retry.noteSuccess(nowNs: UInt64(900) * ms)
        #expect(recovered == DatagramReceiveRetry.Recovery(failures: 2, outageMs: 900))
        #expect(!retry.isFailing)
        #expect(retry.noteSuccess(nowNs: UInt64(1_000) * ms) == nil, "a healthy loop must not report a recovery every datagram")
    }

    /// A recovered loop starts its next run from scratch, or a link that flaps would inherit the
    /// previous outage's budget and give up early on a fault it should survive.
    @Test func aRunAfterARecoveryStartsFresh() {
        var retry = DatagramReceiveRetry()
        _ = retry.noteFailure(nowNs: 0, budgetMs: budgetMs)
        _ = retry.noteSuccess(nowNs: UInt64(20_000) * ms)
        let outcome = retry.noteFailure(nowNs: UInt64(25_000) * ms, budgetMs: budgetMs)
        #expect(outcome == .retry(backoffMs: 50))
    }
}
