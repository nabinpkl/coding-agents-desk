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
