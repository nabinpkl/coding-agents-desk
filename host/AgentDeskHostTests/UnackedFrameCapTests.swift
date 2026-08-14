import Testing
@testable import AgentDeskHost

@Test func backpressureAtCapAbandonsOldestForFreshVideo() {
    var bp = GraphicsBackpressure(maxUnacked: 2)
    #expect(bp.canProduce())
    bp.noteSent(frameId: 1); bp.noteSent(frameId: 2)
    #expect(!bp.canProduce())

    let abandoned = bp.abandonUntilCanProduce()

    #expect(abandoned.map(\.id) == [1])
    #expect(bp.inFlight == 1)
    #expect(bp.canProduce())
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

// An ACK is a cumulative applied-frame watermark.
@Test func backpressureCumulativeAckRetiresEveryOlderTrackedFrame() {
    var bp = GraphicsBackpressure(maxUnacked: 4)
    bp.noteSent(frameId: 10, bytes: 20, sentAtUptimeNs: 100)
    bp.noteSent(frameId: 11, bytes: 30, sentAtUptimeNs: 200)

    let retirement = bp.noteAck(frameId: 11)

    #expect(retirement?.ackedSentAtUptimeNs == 200)
    // ADR-0098: both frames' bytes, not just the ACKed one's. The watermark retired 10 as well,
    // and 10's twenty bytes reached the client exactly as surely as 11's thirty did.
    #expect(retirement?.bytes == 50)
    #expect(retirement?.frames == 2)
    #expect(bp.inFlight == 0)
    #expect(bp.bytesInFlight == 0)
    // An ACK that does not advance the watermark retired nothing and is reported as nothing.
    #expect(bp.noteAck(frameId: 10) == nil)
    #expect(bp.noteAck(frameId: 11) == nil)
}

@Test func lateAckForAbandonedFrameCannotRetireNewerFrame() {
    var bp = GraphicsBackpressure(maxUnacked: 1)
    bp.noteSent(frameId: 10, bytes: 20, sentAtUptimeNs: 100)
    #expect(bp.abandonOldest()?.id == 10)
    bp.noteSent(frameId: 11, bytes: 30, sentAtUptimeNs: 200)

    // ADR-0098 split the two questions this used to answer with one nil. The ACK DOES advance
    // the watermark, so it is reported -- but it retired nothing, and carries no timestamp,
    // because the frame it names was abandoned. Only the timestamp guards the round-trip
    // sample, so a late ACK still cannot be misread as the age of a newer frame.
    let late = bp.noteAck(frameId: 10)
    #expect(late?.ackedSentAtUptimeNs == nil)
    #expect(late?.bytes == 0)
    #expect(late?.frames == 0)
    #expect(bp.inFlight == 1)
    #expect(bp.bytesInFlight == 30)
    #expect(bp.noteAck(frameId: 11)?.ackedSentAtUptimeNs == 200)
    #expect(bp.inFlight == 0)
}

// A2: the in-flight BYTE ceiling keeps the send buffer shallow. A single fast-scroll
// frame over the ceiling closes the gate even though the frame-count cap is nowhere
// near, so the reliable buffer never deepens past ~one big frame and a reset stripe
// can drain fast. The first frame is always admitted, so a single large frame cannot
// permanently stall. (canProduce results are bound to locals: a Testing #expect
// autoclosure rejects an arg-bearing call on a mutable value-type local, and these
// reads sit between mutations of bp.)
@Test func backpressureAbandonsFrameAtInFlightByteCeiling() {
    var bp = GraphicsBackpressure(maxUnacked: 8, maxUnackedBytes: 100_000)
    let emptyAdmits = bp.canProduce()              // empty: first frame always admitted
    #expect(emptyAdmits)
    bp.noteSent(frameId: 1, bytes: 120_000)        // one big frame, over the 100KB ceiling
    #expect(bp.bytesInFlight == 120_000)
    let afterBig = bp.canProduce()                 // gate closes though only 1 of 8 frames
    #expect(!afterBig)
    let abandoned = bp.abandonUntilCanProduce()
    #expect(abandoned.map(\.id) == [1])
    #expect(abandoned.map(\.bytes) == [120_000])
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

// The token-bucket tests that lived here moved to LinkSendPacerTests.swift with the type
// itself (ADR-0098). They were the only exercise it had while it sat here with no caller.
