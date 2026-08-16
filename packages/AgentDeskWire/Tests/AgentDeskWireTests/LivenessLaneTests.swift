import XCTest
@testable import AgentDeskWire

final class LivenessLaneTests: XCTestCase {
    func testHeartbeatRoundTripsThroughItsFixedFrame() {
        let beat = LivenessHeartbeat(sequence: 0x0102_0304_0506_0708, hostUptimeMs: 0x0A0B_0C0D)

        let encoded = beat.encode()

        XCTAssertEqual(encoded.count, LivenessHeartbeat.byteCount)
        XCTAssertEqual(LivenessHeartbeat.decode(encoded), beat)
    }

    // The frame is fixed-width with no length prefix, so the reader's only defence against
    // landing on the wrong bytes is the magic. A silently-accepted mis-decode would show up as
    // a phantom heartbeat keeping a dead session alive.
    func testDecodeRejectsForeignBytes() {
        var wrong = LivenessHeartbeat(sequence: 1, hostUptimeMs: 1).encode()
        wrong[wrong.startIndex] = 0x00

        XCTAssertNil(LivenessHeartbeat.decode(wrong))
    }

    func testDecodeRejectsShortAndLongFrames() {
        let beat = LivenessHeartbeat(sequence: 7, hostUptimeMs: 7).encode()

        XCTAssertNil(LivenessHeartbeat.decode(beat.dropLast()))
        XCTAssertNil(LivenessHeartbeat.decode(beat + Data([0])))
    }

    func testSequenceSurvivesTheFullWidth() {
        let beat = LivenessHeartbeat(sequence: UInt64.max, hostUptimeMs: UInt32.max)

        XCTAssertEqual(LivenessHeartbeat.decode(beat.encode()), beat)
    }

    // The limit sits above the 2-3s cellular stalls measured to self-heal, and below the 9s
    // freeze that did not. Both bounds are the point of the number, so both are asserted.
    func testSilenceLimitRidesOutSelfHealingStallsButNotARealFreeze() {
        XCTAssertFalse(LivenessLanePolicy.shouldDeclareHostGone(msSinceLastHeartbeat: 3_000))
        XCTAssertTrue(LivenessLanePolicy.shouldDeclareHostGone(msSinceLastHeartbeat: 9_000))
    }

    func testSilenceLimitIsInclusiveAtItsBoundary() {
        let limit = LivenessLanePolicy.defaultSilenceLimitMs

        XCTAssertFalse(LivenessLanePolicy.shouldDeclareHostGone(msSinceLastHeartbeat: limit - 1))
        XCTAssertTrue(LivenessLanePolicy.shouldDeclareHostGone(msSinceLastHeartbeat: limit))
    }

    // A heartbeat every second against a six second limit means five may be lost or late before
    // anything is declared. That ratio is the safety margin; collapsing it would rebuild the
    // fragility this lane was created to remove.
    func testHeartbeatCadenceLeavesRoomForSeveralMissedBeats() {
        let intervalMs = 1_000.0

        XCTAssertGreaterThanOrEqual(LivenessLanePolicy.defaultSilenceLimitMs / intervalMs, 4)
    }
}
