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
