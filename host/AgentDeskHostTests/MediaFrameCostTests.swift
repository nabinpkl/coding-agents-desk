import Foundation
import Testing

@testable import AgentDeskHost

/// The live delta-frame wire-cost EWMA that turns a bitrate into a cadence. The floor work
/// (3fde94c1) proved cadence must be sized from measured frame cost; this is that measurement
/// made continuous, so it has to ignore keyframes (session-start events two orders of
/// magnitude off) and track only what a delta of the current content costs.
struct MediaFrameCostTests {
    @Test func firstDeltaSeedsTheEwmaExactly() throws {
        var state = makeState()
        try sendFrame(&state, at: 0, bytes: 8_000)
        #expect(state.deltaFrameBytesEwma == 8_000)
    }

    @Test func keyframesDoNotFeedTheEwma() throws {
        var state = makeState()
        try sendFrame(&state, at: 0, bytes: 90_000, isKeyframe: true)
        #expect(state.deltaFrameBytesEwma == nil)

        try sendFrame(&state, at: 100_000_000, bytes: 5_000)
        try sendFrame(&state, at: 200_000_000, bytes: 120_000, isKeyframe: true)
        #expect(state.deltaFrameBytesEwma == 5_000)
    }

    @Test func deltasMoveTheEwmaByAlpha() throws {
        var state = makeState(frameBytesEwmaAlpha: 0.1)
        try sendFrame(&state, at: 0, bytes: 10_000)
        try sendFrame(&state, at: 100_000_000, bytes: 20_000)
        // 10_000 + 0.1 * (20_000 - 10_000)
        #expect(state.deltaFrameBytesEwma == 11_000)
    }

    private func sendFrame(
        _ state: inout QuicSessionHostMediaState,
        at nowNs: UInt64,
        bytes: Int,
        isKeyframe: Bool = false
    ) throws {
        guard case .ready(let updateId, _) = state.reserveUpdateId(nowNs: nowNs) else {
            throw FrameCostTestError.admissionRefused
        }
        state.noteSent(
            frameId: updateId.frameId,
            encodedBytes: bytes,
            packets: [Data([0])],
            isKeyframe: isKeyframe,
            sentAtUptimeNs: nowNs
        )
    }

    private func makeState(frameBytesEwmaAlpha: Double = 0.1) -> QuicSessionHostMediaState {
        QuicSessionHostMediaState(
            maxInflightFrames: 8,
            maxInflightBytes: 1_000_000,
            expectedFrameRate: 30,
            resendRingFrames: 4,
            frameBytesEwmaAlpha: frameBytesEwmaAlpha
        )
    }

    private enum FrameCostTestError: Error {
        case admissionRefused
    }
}
