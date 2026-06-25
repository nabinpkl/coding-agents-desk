import Testing
@testable import AgentDeskHost

@Test func backpressureStallsAtCapAndResumesOnAck() {
    var bp = GraphicsBackpressure(maxUnacked: 2)
    #expect(bp.canProduce())
    bp.noteSent(frameId: 1); bp.noteSent(frameId: 2)
    #expect(!bp.canProduce())          // at cap
    bp.noteAck(frameId: 1)
    #expect(bp.canProduce())           // one slot freed
}

// B2: across a reconnect the frameId counter keeps climbing while reset() drops
// the in-flight count to zero. The cap must reflect a true in-flight COUNT, not
// a lastSent-minus-lastAcked frameId delta, otherwise the first post-reset send
// would report inFlight equal to the (large) frameId and stall the channel.
@Test func backpressureSurvivesResetWithContinuingFrameIds() {
    var bp = GraphicsBackpressure(maxUnacked: 2)
    bp.noteSent(frameId: 100); bp.noteSent(frameId: 101)
    #expect(!bp.canProduce())          // at cap before the reconnect
    bp.reset()                         // reconnect abandons in-flight frames
    #expect(bp.canProduce())           // clean slate
    bp.noteSent(frameId: 102)          // frameId continues high, not from 1
    #expect(bp.inFlight == 1)          // a count of 1, not 102
    #expect(bp.canProduce())
    bp.noteAck(frameId: 102)
    #expect(bp.inFlight == 0)
}

// A duplicate or out-of-order ack must not double-decrement the in-flight count.
@Test func backpressureIgnoresStaleAndDuplicateAcks() {
    var bp = GraphicsBackpressure(maxUnacked: 4)
    bp.noteSent(frameId: 10); bp.noteSent(frameId: 11)
    bp.noteAck(frameId: 11)            // newest ack clears one
    #expect(bp.inFlight == 1)
    bp.noteAck(frameId: 10)            // stale, ignored
    bp.noteAck(frameId: 11)            // duplicate, ignored
    #expect(bp.inFlight == 1)
}

// A2: the in-flight BYTE ceiling keeps the send buffer shallow. A single fast-scroll
// frame over the ceiling closes the gate even though the frame-count cap is nowhere
// near, so the reliable buffer never deepens past ~one big frame and a reset stripe
// can drain fast. The first frame is always admitted, so a single large frame cannot
// permanently stall. (canProduce results are bound to locals: a Testing #expect
// autoclosure rejects an arg-bearing call on a mutable value-type local, and these
// reads sit between mutations of bp.)
@Test func backpressureStallsOnInFlightByteCeiling() {
    var bp = GraphicsBackpressure(maxUnacked: 8, maxUnackedBytes: 100_000)
    let emptyAdmits = bp.canProduce()              // empty: first frame always admitted
    #expect(emptyAdmits)
    bp.noteSent(frameId: 1, bytes: 120_000)        // one big frame, over the 100KB ceiling
    #expect(bp.bytesInFlight == 120_000)
    let afterBig = bp.canProduce()                 // gate closes though only 1 of 8 frames
    #expect(!afterBig)
    bp.noteAck(frameId: 1)                          // bytes released
    #expect(bp.bytesInFlight == 0)
    let drained = bp.canProduce()
    #expect(drained)
}

// Small frames flow freely under the byte ceiling until the frame-count cap binds.
@Test func backpressureByteCeilingAdmitsSmallFrames() {
    var bp = GraphicsBackpressure(maxUnacked: 3, maxUnackedBytes: 131_072)
    bp.noteSent(frameId: 1, bytes: 4_000)
    let after1 = bp.canProduce()                   // bytes far under ceiling
    #expect(after1)
    bp.noteSent(frameId: 2, bytes: 4_000)
    let after2 = bp.canProduce()                   // still 2 < 3 frames, bytes tiny
    #expect(after2)
    bp.noteSent(frameId: 3, bytes: 4_000)
    let after3 = bp.canProduce()                   // frame-count cap binds first
    #expect(!after3)
    #expect(bp.bytesInFlight == 12_000)
}

// A1: the token bucket paces to the budget. Overspending drives the balance negative,
// and the gate stays closed until elapsed time has refilled a positive balance, so a
// big frame forces a proportionally longer wait before the next admission.
@Test func sendPacerPacesToBudget() {
    var pacer = GraphicsSendPacer(bytesPerSecond: 1_000, burstBytes: 1_000)
    let full = pacer.canSend(nowNs: 0)             // full bucket
    #expect(full)
    pacer.consume(bytes: 1_500, nowNs: 0)          // overspend: tokens -> -500
    let spent = pacer.canSend(nowNs: 0)            // negative balance, must wait
    #expect(!spent)
    let quarter = pacer.canSend(nowNs: 250_000_000)  // -500 + 250 = -250, still negative
    #expect(!quarter)
    let recovered = pacer.canSend(nowNs: 600_000_000)  // -500 + 600 = +100 > 0
    #expect(recovered)
}

// A big frame drives tokens negative and the debt is repaid over time, so the next
// frame waits longer than a small frame would, pacing the average to budget.
@Test func sendPacerRepaysBigFrameDebtOverTime() {
    var pacer = GraphicsSendPacer(bytesPerSecond: 1_000, burstBytes: 1_000)
    pacer.consume(bytes: 1_000, nowNs: 0)          // empty the bucket
    pacer.consume(bytes: 2_000, nowNs: 0)          // a 2KB frame: tokens to -2000, clamped to -burst
    let debt = pacer.availableTokens(nowNs: 0)     // debt bounded at -burstBytes
    #expect(debt == -1_000)
    let halfSecond = pacer.canSend(nowNs: 500_000_000)  // 0.5s refills 500 -> still negative
    #expect(!halfSecond)
    let oneSecond = pacer.canSend(nowNs: 1_000_000_001) // ~1s repays the bounded debt
    #expect(oneSecond)
}
