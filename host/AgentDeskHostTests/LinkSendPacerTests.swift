import Testing
@testable import AgentDeskHost

// ADR-0098. What the wire's rate governor promises: bytes leave at the rung's budget, a burst
// larger than the bucket is spread rather than dumped, and a rung change moves the budget
// without handing back a full bucket.
//
// The arithmetic is tested here rather than through the scheduler because it is pure and takes
// its clock as a parameter -- a timing-dependent test of the same claims would be both slower
// and less exact. OwnedMediaSendSchedulerTests covers that the scheduler actually consults it.

// The token bucket paces to the budget. Overspending drives the balance negative, and it only
// refills at the budget rate, so a big packet forces a proportionally longer wait before the
// next one.
@Test func sendPacerPacesToBudget() {
    var pacer = LinkSendPacer(bytesPerSecond: 1_000, burstBytes: 1_000)
    #expect(pacer.availableTokens(nowNs: 0) == 1_000)     // full bucket
    pacer.consume(bytes: 1_500, nowNs: 0)                 // overspend: tokens -> -500
    #expect(pacer.availableTokens(nowNs: 0) == -500)
    #expect(pacer.availableTokens(nowNs: 250_000_000) == -250)  // 0.25s refills 250
    #expect(pacer.availableTokens(nowNs: 600_000_000) == 100)   // 0.6s clears the debt
}

// A big packet drives tokens negative and the debt is repaid over time, so the next one waits
// longer than a small one would, pacing the average to budget. The debt is bounded so that one
// oversized packet cannot stall the pump for many seconds.
@Test func sendPacerRepaysBigPacketDebtOverTime() {
    var pacer = LinkSendPacer(bytesPerSecond: 1_000, burstBytes: 1_000)
    pacer.consume(bytes: 1_000, nowNs: 0)          // empty the bucket
    pacer.consume(bytes: 2_000, nowNs: 0)          // tokens to -2000, clamped to -burst
    #expect(pacer.availableTokens(nowNs: 0) == -1_000)
    #expect(pacer.availableTokens(nowNs: 500_000_000) == -500)   // 0.5s refills 500
    #expect(pacer.availableTokens(nowNs: 1_000_000_000) == 0)    // ~1s repays the bounded debt
}

// The wait is exact, not a fixed pause. This is the whole reason the fixed 32-packet/1ms
// grouping was replaced: it could not know what it was pausing for.
@Test func sendPacerWaitsExactlyLongEnoughForTheBytes() {
    var pacer = LinkSendPacer(bytesPerSecond: 1_000, burstBytes: 1_000)
    // A full bucket affords a packet it already covers, with no wait at all.
    #expect(pacer.waitNanos(forBytes: 500, nowNs: 0) == 0)
    pacer.consume(bytes: 1_000, nowNs: 0)          // bucket now empty
    // 250 bytes at 1000 B/s is a quarter second.
    #expect(pacer.waitNanos(forBytes: 250, nowNs: 0) == 250_000_000)
    // And the wait shrinks as the bucket refills: 100ms of credit leaves 150ms owed.
    #expect(pacer.waitNanos(forBytes: 250, nowNs: 100_000_000) == 150_000_000)
}

// A packet larger than the bucket must not be able to deadlock the pump waiting for a balance
// the bucket can never hold. It waits one full bucket and goes.
@Test func sendPacerCannotDeadlockOnAnOversizedPacket() {
    var pacer = LinkSendPacer(bytesPerSecond: 1_000, burstBytes: 500)
    pacer.consume(bytes: 500, nowNs: 0)
    let wait = pacer.waitNanos(forBytes: 5_000, nowNs: 0)
    #expect(wait == 500_000_000)                    // burstBytes / rate, not 5000 / rate
    #expect(pacer.waitNanos(forBytes: 5_000, nowNs: 500_000_000) == 0)
}

// A rung change adopts the new budget without discarding the balance, and credits elapsed time
// at the rate that was in force for it. Rebuilding the bucket instead would hand back a full one
// on every step of a descent, which is the stretch where the pacing matters most.
@Test func sendPacerRetargetKeepsTheBalanceItEarned() {
    var pacer = LinkSendPacer(bytesPerSecond: 1_000, burstBytes: 1_000)
    pacer.consume(bytes: 1_000, nowNs: 0)                  // empty at the old rate
    pacer.retarget(bytesPerSecond: 100, nowNs: 500_000_000) // 0.5s at 1000 B/s credited: 500
    #expect(pacer.availableTokens(nowNs: 500_000_000) == 500)
    #expect(pacer.bytesPerSecond == 100)
    // And the new, slower rate governs from here: 100 more bytes is a full second.
    #expect(pacer.waitNanos(forBytes: 600, nowNs: 500_000_000) == 1_000_000_000)
}

// The wire's budget is the encoder's budget. Pacing tighter than what the encoder is allowed to
// emit would move the queue onto the host rather than remove it.
@Test func sendPacerBudgetMatchesTheEncoderAllowance() {
    // 300kbps = 37,500 B/s average; the encoder's 1.5x DataRateLimits window allows 56,250.
    #expect(LinkSendPacer.bytesPerSecond(forKbps: 300, headroom: 1.5) == 56_250)
    // Headroom below 1 would starve the encoder's own allowance, so it is clamped away.
    #expect(LinkSendPacer.bytesPerSecond(forKbps: 300, headroom: 0.5) == 37_500)
}
