import CryptoKit
import XCTest
import AgentDeskWire
@testable import AgentDeskClient

// Phase 2 client side of the mixed-mode renderer (ADR-0025): reassembling the
// datagram carrier under loss and reordering, and the resend/keyframe-request
// recovery the host serves from its ring.
final class OwnedMediaFrameRepairBufferTests: XCTestCase {
    private func buffer(trackedFrameLimit: Int = 8) -> MediaDatagramFrameRepairBuffer {
        MediaDatagramFrameRepairBuffer(
            trackedFrameLimit: trackedFrameLimit,
            maxResendPackets: 64
        )
    }

    private func packet(
        frame: UInt64, index: UInt16, count: UInt16, payload: Data, keyframe: Bool = false,
        resync: Bool = false
    ) -> MediaDatagramFramePacket {
        MediaDatagramFramePacket(
            frameId: frame, packetIndex: index, packetCount: count,
            isKeyframe: keyframe, isLtrResync: resync, sentAtUptimeNs: 0, payload: payload
        )
    }

    func testInOrderPacketsCompleteFrame() {
        let buffer = buffer()
        let first = buffer.accept(packet(frame: 1, index: 0, count: 2, payload: Data([1])))
        XCTAssertTrue(first.completedFrames.isEmpty)
        let second = buffer.accept(packet(frame: 1, index: 1, count: 2, payload: Data([2])))
        XCTAssertEqual(second.completedFrames.map(\.frameId), [1])
        XCTAssertEqual(second.completedFrames.first?.data, Data([1, 2]))
        XCTAssertEqual(second.completedFrames.first?.wasRepaired, false)
    }

    func testOutOfOrderPacketsReassembleInIndexOrder() {
        let buffer = buffer()
        _ = buffer.accept(packet(frame: 1, index: 1, count: 2, payload: Data([2])))
        let result = buffer.accept(packet(frame: 1, index: 0, count: 2, payload: Data([1])))
        XCTAssertEqual(result.completedFrames.first?.data, Data([1, 2]))
    }

    func testMissingPacketRequestsResendWhileNewerFrameIsStillAssembling() {
        let buffer = buffer()
        _ = buffer.accept(packet(frame: 1, index: 0, count: 2, payload: Data([0])))
        let result = buffer.accept(packet(frame: 2, index: 0, count: 2, payload: Data([2])))
        XCTAssertEqual(result.resendRequests, [MediaDatagramRepairRequest(frameId: 1, packetIndexes: [1])])
        XCTAssertTrue(result.completedFrames.isEmpty)
        XCTAssertTrue(result.skippedFrames.isEmpty)
        XCTAssertEqual(result.pendingFrameCount, 2)
    }

    func testNewerCompleteFrameSkipsOlderIncompleteFrameWithoutWaiting() {
        let buffer = buffer()
        _ = buffer.accept(packet(frame: 1, index: 0, count: 2, payload: Data([0])))

        let result = buffer.accept(packet(frame: 2, index: 0, count: 1, payload: Data([2])))

        XCTAssertEqual(result.skippedFrames.map(\.frameId), [1])
        XCTAssertEqual(result.completedFrames.map(\.frameId), [2])
        XCTAssertTrue(result.resendRequests.isEmpty, "do not repair a frame already overtaken")
        XCTAssertEqual(result.pendingFrameCount, 0)
    }

    func testLatePacketForSkippedFrameIsRejected() {
        let buffer = buffer()
        _ = buffer.accept(packet(frame: 1, index: 0, count: 2, payload: Data([0])))
        _ = buffer.accept(packet(frame: 2, index: 0, count: 1, payload: Data([2])))

        let late = buffer.accept(packet(frame: 1, index: 1, count: 2, payload: Data([1])))

        XCTAssertEqual(late, .empty)
    }

    func testTrackedLimitEvictsBeforeRequestingResend() {
        let buffer = buffer(trackedFrameLimit: 1)
        _ = buffer.accept(packet(frame: 1, index: 0, count: 2, payload: Data([1])))
        let result = buffer.accept(packet(frame: 2, index: 0, count: 2, payload: Data([2])))
        XCTAssertEqual(result.skippedFrames.map(\.frameId), [1])
        XCTAssertEqual(result.resendRequests, [], "do not NACK a frame we already evicted locally")
    }

    func testRepairCompletesBeforeNewerFrameOvertakes() {
        let buffer = buffer()
        _ = buffer.accept(packet(frame: 1, index: 0, count: 2, payload: Data([10])))
        let request = buffer.accept(packet(frame: 2, index: 0, count: 2, payload: Data([20])))
        XCTAssertEqual(request.resendRequests.map(\.frameId), [1])

        let result = buffer.accept(packet(frame: 1, index: 1, count: 2, payload: Data([11])))

        XCTAssertEqual(result.completedFrames.map(\.frameId), [1])
        XCTAssertEqual(result.completedFrames.first?.wasRepaired, true)
        XCTAssertEqual(result.repairedFrameCount, 1)
    }

    private func gate(
        minGapNs: UInt64 = 300, escalationDiscards: Int = 6
    ) -> MediaFrameRecoveryGate {
        MediaFrameRecoveryGate(
            keyframeRequestMinGapNs: minGapNs,
            escalationDiscardLimit: escalationDiscards
        )
    }

    private func decide(
        _ gate: inout MediaFrameRecoveryGate, keyframe: Bool = false, resync: Bool = false,
        nowNs: UInt64 = 0
    ) -> MediaFrameRecoveryGate.CompletedFrameDecision {
        gate.decideCompletedFrame(isKeyframe: keyframe, isLtrResync: resync, nowNs: nowNs).decision
    }

    func testRecoveryGateCoalescesRequestsAndRetriesAfterGap() {
        var gate = gate()
        gate.noteGapSkip(nowNs: 0)
        gate.noteGapSkip(nowNs: 0)

        XCTAssertNotNil(gate.takeKeyframeRequestIfNeeded(nowNs: 1_000))
        XCTAssertNil(gate.takeKeyframeRequestIfNeeded(nowNs: 1_100))
        XCTAssertEqual(decide(&gate), .discardRecoveryDelta)
        XCTAssertNil(gate.takeKeyframeRequestIfNeeded(nowNs: 1_299))
        XCTAssertNotNil(gate.takeKeyframeRequestIfNeeded(nowNs: 1_300))
    }

    func testRecoveryKeyframeResumesRendering() {
        var gate = gate()
        gate.noteGapSkip(nowNs: 0)

        XCTAssertEqual(decide(&gate), .discardRecoveryDelta)
        XCTAssertEqual(decide(&gate, keyframe: true), .renderRecoveryKeyframe)
        XCTAssertFalse(gate.awaitingKeyframe)
        XCTAssertNil(gate.takeKeyframeRequestIfNeeded(nowNs: 1_000))
        XCTAssertEqual(decide(&gate), .render)
    }

    // The livelock fix. Before the resync mark, the host answered every gap-recovery request
    // with an LTR-refresh delta -- correct under ADR-0090 -- and this gate discarded all of
    // them while waiting for a keyframe that was never coming: 763 cheap answers thrown away
    // in one measured LTE session, picture frozen throughout. A marked resync delta must
    // resolve the gate exactly as a keyframe does.
    func testMarkedResyncDeltaResolvesTheGate() {
        var gate = gate()
        gate.noteGapSkip(nowNs: 0)

        XCTAssertEqual(decide(&gate), .discardRecoveryDelta)
        XCTAssertEqual(decide(&gate, resync: true), .renderRecoveryResync)
        XCTAssertFalse(gate.awaitingKeyframe)
        XCTAssertNil(gate.takeKeyframeRequestIfNeeded(nowNs: 1_000))
        XCTAssertEqual(decide(&gate), .render, "ordinary deltas render again after the resync")
    }

    func testUnmarkedDeltaIsStillDiscardedWhileArmed() {
        var gate = gate()
        gate.noteGapSkip(nowNs: 0)
        for _ in 0..<3 {
            XCTAssertEqual(decide(&gate), .discardRecoveryDelta)
        }
        XCTAssertTrue(gate.awaitingKeyframe)
    }

    // The backstop for references that are genuinely unusable: once enough cheap answers have
    // been discarded, the next request must declare no references and force a true keyframe,
    // converting an unbounded discard loop into one bounded IDR.
    func testEscalationDeclaresNoReferencesAfterTheDiscardLimit() {
        var gate = gate(escalationDiscards: 3)
        gate.noteGapSkip(nowNs: 0)

        XCTAssertEqual(gate.takeKeyframeRequestIfNeeded(nowNs: 1_000)?.declareNoReferences, false)
        _ = decide(&gate)
        _ = decide(&gate)
        XCTAssertEqual(
            gate.takeKeyframeRequestIfNeeded(nowNs: 2_000)?.declareNoReferences, false,
            "below the limit the request stays cheap"
        )
        _ = decide(&gate)
        XCTAssertEqual(gate.takeKeyframeRequestIfNeeded(nowNs: 3_000)?.declareNoReferences, true)
    }

    func testResolutionResetsTheEscalationCount() {
        var gate = gate(escalationDiscards: 2)
        gate.noteGapSkip(nowNs: 0)
        _ = decide(&gate)
        _ = decide(&gate)
        XCTAssertEqual(decide(&gate, resync: true), .renderRecoveryResync)

        gate.noteGapSkip(nowNs: 10_000)
        XCTAssertEqual(
            gate.takeKeyframeRequestIfNeeded(nowNs: 11_000)?.declareNoReferences, false,
            "a fresh gap must not inherit the previous run's discard count"
        )
    }

    // The mark travels on the packet because this gate decides before envelope decode; a frame
    // whose packets disagree about it is inconsistent and must be skipped like any other
    // header mismatch.
    func testResyncFlagMismatchAcrossPacketsSkipsTheFrame() {
        let buffer = buffer()
        _ = buffer.accept(packet(frame: 1, index: 0, count: 2, payload: Data([1]), resync: true))
        let result = buffer.accept(packet(frame: 1, index: 1, count: 2, payload: Data([2]), resync: false))
        XCTAssertEqual(result.skippedFrames.map(\.frameId), [1])
        XCTAssertTrue(result.completedFrames.isEmpty)
    }

    func testCompletedFrameCarriesTheResyncMark() {
        let buffer = buffer()
        _ = buffer.accept(packet(frame: 1, index: 0, count: 2, payload: Data([1]), resync: true))
        let result = buffer.accept(packet(frame: 1, index: 1, count: 2, payload: Data([2]), resync: true))
        XCTAssertEqual(result.completedFrames.first?.isLtrResync, true)
    }

    func testPacketWireRoundTripsOnClient() throws {
        let key = MediaDatagramCrypto.sessionKey(
            sessionId: "session-test",
            clientNonce: Data([1]),
            hostNonce: Data([2]),
            mediaKeySalt: Data([3])
        )
        let payload = Data((0..<500).map { UInt8($0 % 256) })
        let packets = try MediaDatagramFramePacket.packetize(
            frameId: 3, isKeyframe: true, isLtrResync: false, sentAtUptimeNs: 7,
            payload: payload, key: key
        )
        let decoded = try MediaDatagramFramePacket.decode(packets[0], key: key)
        XCTAssertEqual(decoded.payload, payload)
        XCTAssertTrue(decoded.isKeyframe)
        XCTAssertFalse(decoded.isLtrResync)
    }

    func testResyncFlagRoundTripsAndIsAuthenticated() throws {
        let key = MediaDatagramCrypto.sessionKey(
            sessionId: "session-test",
            clientNonce: Data([1]),
            hostNonce: Data([2]),
            mediaKeySalt: Data([3])
        )
        let packets = try MediaDatagramFramePacket.packetize(
            frameId: 4, isKeyframe: false, isLtrResync: true, sentAtUptimeNs: 7,
            payload: Data([9, 9]), key: key
        )
        let decoded = try MediaDatagramFramePacket.decode(packets[0], key: key)
        XCTAssertTrue(decoded.isLtrResync)
        XCTAssertFalse(decoded.isKeyframe)

        // The flags byte is inside the HMAC: stripping the mark in flight must fail
        // authentication, not silently demote the resync back into an ordinary delta.
        var tampered = packets[0]
        tampered[tampered.startIndex + 6] = 0
        XCTAssertThrowsError(try MediaDatagramFramePacket.decode(tampered, key: key))
    }

    func testControlMessageRoundTripsOnClient() throws {
        let message = OwnedMediaControlMessage(kind: .packetResendRequest, frameId: 9, packetIndexes: [2, 5])
        let decoded = try JSONDecoder().decode(
            OwnedMediaControlMessage.self, from: JSONEncoder().encode(message)
        )
        XCTAssertEqual(decoded.kind, .packetResendRequest)
        XCTAssertEqual(decoded.packetIndexes, [2, 5])
    }

    func testFrameAckMessageRoundTripsOnClient() throws {
        let message = OwnedMediaControlMessage(kind: .frameAck, frameId: 42)
        let decoded = try JSONDecoder().decode(
            OwnedMediaControlMessage.self, from: JSONEncoder().encode(message)
        )

        XCTAssertEqual(decoded.kind, .frameAck)
        XCTAssertEqual(decoded.frameId, 42)
    }

    // ADR-0027 R87: the client encodes link-health reports the host decodes.
    func testLinkHealthMessageRoundTripsOnClient() throws {
        let message = OwnedMediaControlMessage(
            kind: .linkHealth, frameId: 0,
            linkHealthCompletedFrames: 88, linkHealthExpiredFrames: 12
        )
        let decoded = try JSONDecoder().decode(
            OwnedMediaControlMessage.self, from: JSONEncoder().encode(message)
        )
        XCTAssertEqual(decoded.kind, .linkHealth)
        XCTAssertEqual(decoded.linkHealthCompletedFrames, 88)
        XCTAssertEqual(decoded.linkHealthExpiredFrames, 12)
    }
}
