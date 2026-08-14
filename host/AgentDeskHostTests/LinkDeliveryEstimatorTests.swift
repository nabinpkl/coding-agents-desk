import Testing
@testable import AgentDeskHost

// ADR-0098: the estimate that turns acked bytes into a statement about the link.
//
// The danger this suite is mostly about is not inaccuracy, it is a feedback loop. The estimate
// steers the pacer, the pacer decides what goes out, and what goes out is what the estimate is
// measured from. Every test below is really asking the same question: can this thing talk itself
// into believing a healthy link is slow?

private func estimator(sliceMs: Int = 250, windowMs: Int = 5_000) -> LinkDeliveryEstimator {
    LinkDeliveryEstimator(sliceMs: sliceMs, windowMs: windowMs)
}

private let ms: UInt64 = 1_000_000

// Nothing measured is not zero measured. A caller that reads nil as "the link is dead" would
// stop the sends that produce the acks the estimate needs, and there is no way back from that.
@Test func anUnprobedLinkReportsNothingRatherThanZero() {
    let idle = estimator()
    #expect(idle.deliveredBytesPerSecond == nil)
}

// The straightforward case: 25KB delivered over 250ms, with a backlog throughout, is 100KB/s.
@Test func aBackloggedSliceMeasuresTheLinksRate() {
    var e = estimator()
    e.noteDelivered(bytes: 5_000, backlogBytesAfter: 40_000, nowNs: 0)
    e.noteDelivered(bytes: 25_000, backlogBytesAfter: 20_000, nowNs: 250 * ms)
    #expect(e.deliveredBytesPerSecond == 100_000)
}

// The opening ack's own bytes are not part of the rate. They arrived over an interval that ended
// when the slice began and that nobody measured; dividing them by zero elapsed time would report
// a rate no link achieved, and it would be the FIRST thing the pacer ever saw.
@Test func theBytesThatOpenASliceAreNotCountedIntoIt() {
    var e = estimator()
    e.noteDelivered(bytes: 1_000_000, backlogBytesAfter: 40_000, nowNs: 0)
    e.noteDelivered(bytes: 25_000, backlogBytesAfter: 20_000, nowNs: 250 * ms)
    #expect(e.deliveredBytesPerSecond == 100_000)
}

// The loop-breaker. A calm screen delivers almost nothing because almost nothing was offered,
// and reading that as capacity would ratchet a good link to the floor and keep it there -- the
// lower rate producing even fewer bytes to measure with.
@Test func anEmptyBacklogDisqualifiesTheSlice() {
    var e = estimator()
    e.noteDelivered(bytes: 500, backlogBytesAfter: 0, nowNs: 0)
    e.noteDelivered(bytes: 500, backlogBytesAfter: 0, nowNs: 250 * ms)
    #expect(e.deliveredBytesPerSecond == nil)
}

// And one moment of emptiness is enough to disqualify it. The host having caught up at any point
// in the slice means the rate observed over that slice was bounded by the host, not the link.
@Test func aBacklogThatEmptiesMidSliceDisqualifiesIt() {
    var e = estimator()
    e.noteDelivered(bytes: 10_000, backlogBytesAfter: 30_000, nowNs: 0)
    e.noteDelivered(bytes: 30_000, backlogBytesAfter: 0, nowNs: 100 * ms)
    e.noteDelivered(bytes: 10_000, backlogBytesAfter: 5_000, nowNs: 250 * ms)
    #expect(e.deliveredBytesPerSecond == nil)
}

// A max filter, not an average: a single slow slice among fast ones says something about that
// slice (a coalesced ack, a scheduling gap), while a fast slice can only be the link.
@Test func theEstimateIsTheWindowMaximumNotTheAverage() {
    var e = estimator()
    e.noteDelivered(bytes: 25_000, backlogBytesAfter: 90_000, nowNs: 0)
    e.noteDelivered(bytes: 25_000, backlogBytesAfter: 80_000, nowNs: 250 * ms)   // 100KB/s
    e.noteDelivered(bytes: 2_500, backlogBytesAfter: 70_000, nowNs: 500 * ms)    // 10KB/s
    e.noteDelivered(bytes: 0, backlogBytesAfter: 70_000, nowNs: 500 * ms)
    #expect(e.deliveredBytesPerSecond == 100_000)
}

// But it must be able to fall, or a link that genuinely got slower keeps being paced at a rate
// it can no longer carry. Expiry is the only way a max filter goes down.
@Test func anAgedOutMaximumStopsCountingAndTheEstimateFalls() {
    var e = estimator(windowMs: 1_000)
    e.noteDelivered(bytes: 25_000, backlogBytesAfter: 90_000, nowNs: 0)
    e.noteDelivered(bytes: 25_000, backlogBytesAfter: 80_000, nowNs: 250 * ms)
    #expect(e.deliveredBytesPerSecond == 100_000)

    e.noteDelivered(bytes: 2_500, backlogBytesAfter: 70_000, nowNs: 2_000 * ms)
    e.noteDelivered(bytes: 2_500, backlogBytesAfter: 60_000, nowNs: 2_250 * ms)
    #expect(e.deliveredBytesPerSecond == 10_000)
}

// The freeze case, and the reason expiry cannot live only inside `noteDelivered`. A stalled link
// delivers nothing at all, so nothing calls the estimator -- and a stale maximum would report
// the pre-freeze capacity for as long as the freeze lasted.
@Test func aSilentStretchExpiresTheMaximumOnItsOwn() {
    var e = estimator(windowMs: 1_000)
    e.noteDelivered(bytes: 25_000, backlogBytesAfter: 90_000, nowNs: 0)
    e.noteDelivered(bytes: 25_000, backlogBytesAfter: 80_000, nowNs: 250 * ms)
    #expect(e.deliveredBytesPerSecond == 100_000)

    e.expire(nowNs: 5_000 * ms)
    #expect(e.deliveredBytesPerSecond == nil)
}

// A flush throws away a backlog the link never carried, so the slice measuring against it is no
// longer a link-limited sample. What the link already proved it could do stays.
@Test func discardingThePendingSliceKeepsWhatWasAlreadyMeasured() {
    var e = estimator()
    e.noteDelivered(bytes: 25_000, backlogBytesAfter: 90_000, nowNs: 0)
    e.noteDelivered(bytes: 25_000, backlogBytesAfter: 80_000, nowNs: 250 * ms)

    e.noteDelivered(bytes: 1_000, backlogBytesAfter: 50_000, nowNs: 300 * ms)
    e.discardPendingSlice()
    e.noteDelivered(bytes: 1_000, backlogBytesAfter: 50_000, nowNs: 600 * ms)

    #expect(e.deliveredBytesPerSecond == 100_000)
}

// --- what the pacer does with it ---

// Unknown means pace to the rung. Anything else stops the sends that would make it known.
@Test func theUnmeasuredPacerBudgetIsTheRungsBudget() {
    let paced = LinkSendPacer.bytesPerSecond(
        forKbps: 2_500,
        headroom: 1.5,
        deliveredBytesPerSecond: nil,
        floorKbps: 180,
        deliveryHeadroom: 1.25
    )
    #expect(paced == LinkSendPacer.bytesPerSecond(forKbps: 2_500, headroom: 1.5))
}

// The measured case, and the point of the whole slice: the ladder is asking for 2500kbps, the
// link is carrying 300, so the wire is paced at 300 plus a probing margin -- not at 2500.
@Test func aMeasuredLinkPacesTheWireBelowTheRung() {
    let delivered = 300.0 * 1_000.0 / 8.0
    let paced = LinkSendPacer.bytesPerSecond(
        forKbps: 2_500,
        headroom: 1.5,
        deliveredBytesPerSecond: delivered,
        floorKbps: 180,
        deliveryHeadroom: 1.25
    )
    #expect(paced == delivered * 1.25)
}

// It only paces down. The measurement is a lower bound on capacity, not permission to exceed the
// quality decision -- and the encoder is not producing more than the rung anyway.
@Test func aFastLinkNeverPacesAboveTheRung() {
    let paced = LinkSendPacer.bytesPerSecond(
        forKbps: 300,
        headroom: 1.5,
        deliveredBytesPerSecond: 10_000_000,
        floorKbps: 180,
        deliveryHeadroom: 1.25
    )
    #expect(paced == LinkSendPacer.bytesPerSecond(forKbps: 300, headroom: 1.5))
}

// The floor is what makes the loop reversible. Without it a hard stall walks the estimate toward
// nothing, the pacer stops sending, the acks stop, and the estimate can never recover.
@Test func aCollapsedEstimateStillLeavesTheFloorToProbeWith() {
    let paced = LinkSendPacer.bytesPerSecond(
        forKbps: 2_500,
        headroom: 1.5,
        deliveredBytesPerSecond: 1.0,
        floorKbps: 180,
        deliveryHeadroom: 1.25
    )
    #expect(paced == LinkSendPacer.bytesPerSecond(forKbps: 180, headroom: 1.0))
}
