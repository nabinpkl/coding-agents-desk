import XCTest
@testable import AgentDeskWire

final class LivenessLaneTests: XCTestCase {
    private let sessionId = "B0x1CTNAviAUzADKxVH0oIVMv_bHuMGOUMoMB8I_OGc"

    func testFrameRoundTripsThroughItsWire() {
        let ping = SessionLivenessFrame(kind: .ping, sequence: 0x0102_0304_0506_0708, sessionId: sessionId)

        XCTAssertEqual(SessionLivenessFrame.decode(ping.encode()), ping)
    }

    func testPingAndPongAreDistinguishable() {
        let ping = SessionLivenessFrame(kind: .ping, sequence: 7, sessionId: sessionId)
        let pong = SessionLivenessFrame(kind: .pong, sequence: 7, sessionId: sessionId)

        XCTAssertNotEqual(ping.encode(), pong.encode())
        XCTAssertEqual(SessionLivenessFrame.decode(pong.encode())?.kind, .pong)
    }

    // The frame has no length prefix ahead of its magic, so the reader's only defence against
    // landing on the wrong bytes is the magic itself. A silently-accepted mis-decode would show
    // up as a phantom pong keeping a dead session alive.
    func testDecodeRejectsForeignBytes() {
        var wrong = SessionLivenessFrame(kind: .ping, sequence: 1, sessionId: sessionId).encode()
        wrong[wrong.startIndex] = 0x00

        XCTAssertNil(SessionLivenessFrame.decode(wrong))
    }

    func testDecodeRejectsAnUnknownKind() {
        var wrong = SessionLivenessFrame(kind: .ping, sequence: 1, sessionId: sessionId).encode()
        wrong[wrong.startIndex + 4] = 0x7F

        XCTAssertNil(SessionLivenessFrame.decode(wrong))
    }

    // The reader asks for `bodyLength` bytes after the head. A zero or oversized length would
    // park it on a receive that never completes, which presents as a hung lane rather than a
    // protocol error -- the worst possible failure for the one lane that reports hangs.
    func testBodyLengthRejectsLengthsThatWouldStallTheReader() {
        var frame = SessionLivenessFrame(kind: .ping, sequence: 1, sessionId: sessionId).encode()
        let lengthIndex = frame.startIndex + SessionLivenessFrame.headByteCount - 1

        frame[lengthIndex] = 0
        XCTAssertNil(SessionLivenessFrame.bodyLength(ofHead: frame.prefix(SessionLivenessFrame.headByteCount)))

        frame[lengthIndex] = UInt8(SessionLivenessFrame.maxSessionIdByteCount + 1)
        XCTAssertNil(SessionLivenessFrame.bodyLength(ofHead: frame.prefix(SessionLivenessFrame.headByteCount)))
    }

    func testDecodeRejectsABodyThatDoesNotMatchItsDeclaredLength() {
        let frame = SessionLivenessFrame(kind: .ping, sequence: 1, sessionId: sessionId).encode()
        let head = Data(frame.prefix(SessionLivenessFrame.headByteCount))
        let body = Data(frame.dropFirst(SessionLivenessFrame.headByteCount))

        XCTAssertNil(SessionLivenessFrame.decode(head: head, body: body.dropLast()))
        XCTAssertNil(SessionLivenessFrame.decode(head: head, body: body + Data([0x41])))
    }

    func testSequenceSurvivesTheFullWidth() {
        let frame = SessionLivenessFrame(kind: .pong, sequence: UInt64.max, sessionId: sessionId)

        XCTAssertEqual(SessionLivenessFrame.decode(frame.encode()), frame)
    }

    // The session id is what makes a pong that arrives over a DIFFERENT connection than its ping
    // still count. If it did not survive the wire intact there would be nothing to match on.
    func testTheSessionIdSurvivesTheWireExactly() {
        let decoded = SessionLivenessFrame.decode(
            SessionLivenessFrame(kind: .pong, sequence: 3, sessionId: sessionId).encode()
        )

        XCTAssertEqual(decoded?.sessionId, sessionId)
    }

    // The limit sits above the 2-3s cellular stalls measured to self-heal, and below the 9s
    // freeze that did not. Both bounds are the point of the number, so both are asserted.
    func testSilenceLimitRidesOutSelfHealingStallsButNotARealFreeze() {
        XCTAssertFalse(SessionLivenessPolicy.shouldDeclareSessionGone(msSinceLastRoundTrip: 3_000))
        XCTAssertTrue(SessionLivenessPolicy.shouldDeclareSessionGone(msSinceLastRoundTrip: 9_000))
    }

    func testSilenceLimitIsInclusiveAtItsBoundary() {
        let limit = SessionLivenessPolicy.defaultSilenceLimitMs

        XCTAssertFalse(SessionLivenessPolicy.shouldDeclareSessionGone(msSinceLastRoundTrip: limit - 1))
        XCTAssertTrue(SessionLivenessPolicy.shouldDeclareSessionGone(msSinceLastRoundTrip: limit))
    }

    // A ping every second against a six second limit means five round trips may be lost or late
    // before anything is declared. That ratio is the safety margin; collapsing it would rebuild
    // the fragility this lane was created to remove.
    func testPingCadenceLeavesRoomForSeveralMissedRoundTrips() {
        XCTAssertGreaterThanOrEqual(
            SessionLivenessPolicy.defaultSilenceLimitMs / SessionLivenessPolicy.pingIntervalMs,
            4
        )
    }
}
