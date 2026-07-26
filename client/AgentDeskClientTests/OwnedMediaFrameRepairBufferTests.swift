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
        frame: UInt64, index: UInt16, count: UInt16, payload: Data, keyframe: Bool = false
    ) -> MediaDatagramFramePacket {
        MediaDatagramFramePacket(
            frameId: frame, packetIndex: index, packetCount: count,
            isKeyframe: keyframe, sentAtUptimeNs: 0, payload: payload
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
    }

    func testNewerCompleteFrameSkipsOlderIncompleteFrameWithoutWaiting() {
        let buffer = buffer()
        _ = buffer.accept(packet(frame: 1, index: 0, count: 2, payload: Data([0])))

        let result = buffer.accept(packet(frame: 2, index: 0, count: 1, payload: Data([2])))

        XCTAssertEqual(result.skippedFrames.map(\.frameId), [1])
        XCTAssertEqual(result.completedFrames.map(\.frameId), [2])
        XCTAssertTrue(result.resendRequests.isEmpty, "do not repair a frame already overtaken")
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

    func testRecoveryGateCoalescesRequestsAndRetriesAfterGap() {
        var gate = MediaFrameRecoveryGate(keyframeRequestMinGapNs: 300)
        gate.noteGapSkip()
        gate.noteGapSkip()

        XCTAssertTrue(gate.takeKeyframeRequestIfNeeded(nowNs: 1_000))
        XCTAssertFalse(gate.takeKeyframeRequestIfNeeded(nowNs: 1_100))
        XCTAssertEqual(gate.decideCompletedFrame(isKeyframe: false), .discardRecoveryDelta)
        XCTAssertFalse(gate.takeKeyframeRequestIfNeeded(nowNs: 1_299))
        XCTAssertTrue(gate.takeKeyframeRequestIfNeeded(nowNs: 1_300))
    }

    func testRecoveryKeyframeResumesRendering() {
        var gate = MediaFrameRecoveryGate(keyframeRequestMinGapNs: 300)
        gate.noteGapSkip()

        XCTAssertEqual(gate.decideCompletedFrame(isKeyframe: false), .discardRecoveryDelta)
        XCTAssertEqual(gate.decideCompletedFrame(isKeyframe: true), .renderRecoveryKeyframe)
        XCTAssertFalse(gate.awaitingKeyframe)
        XCTAssertFalse(gate.takeKeyframeRequestIfNeeded(nowNs: 1_000))
        XCTAssertEqual(gate.decideCompletedFrame(isKeyframe: false), .render)
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
            frameId: 3, isKeyframe: true, sentAtUptimeNs: 7, payload: payload, key: key
        )
        let decoded = try MediaDatagramFramePacket.decode(packets[0], key: key)
        XCTAssertEqual(decoded.payload, payload)
        XCTAssertTrue(decoded.isKeyframe)
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
