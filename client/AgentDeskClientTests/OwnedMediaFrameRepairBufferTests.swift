import CryptoKit
import XCTest
import AgentDeskWire
@testable import AgentDeskClient

// Phase 2 client side of the mixed-mode renderer (ADR-0025): reassembling the
// datagram carrier under loss and reordering, and the resend/keyframe-request
// recovery the host serves from its ring.
final class OwnedMediaFrameRepairBufferTests: XCTestCase {
    private func packet(
        frame: UInt64, index: UInt16, count: UInt16, payload: Data, keyframe: Bool = false
    ) -> MediaDatagramFramePacket {
        MediaDatagramFramePacket(
            frameId: frame, packetIndex: index, packetCount: count,
            isKeyframe: keyframe, sentAtUptimeNs: 0, payload: payload
        )
    }

    func testInOrderPacketsCompleteFrame() {
        let buffer = MediaDatagramFrameRepairBuffer(repairDeadlineNs: 1_000, trackedFrameLimit: 8, maxResendPackets: 64)
        let first = buffer.accept(packet(frame: 1, index: 0, count: 2, payload: Data([1])), now: 0)
        XCTAssertTrue(first.completedFrames.isEmpty)
        let second = buffer.accept(packet(frame: 1, index: 1, count: 2, payload: Data([2])), now: 0)
        XCTAssertEqual(second.completedFrames.map(\.frameId), [1])
        XCTAssertEqual(second.completedFrames.first?.data, Data([1, 2]))
        XCTAssertEqual(second.completedFrames.first?.wasRepaired, false)
    }

    func testOutOfOrderPacketsReassembleInIndexOrder() {
        let buffer = MediaDatagramFrameRepairBuffer(repairDeadlineNs: 1_000, trackedFrameLimit: 8, maxResendPackets: 64)
        _ = buffer.accept(packet(frame: 1, index: 1, count: 2, payload: Data([2])), now: 0)
        let result = buffer.accept(packet(frame: 1, index: 0, count: 2, payload: Data([1])), now: 0)
        XCTAssertEqual(result.completedFrames.first?.data, Data([1, 2]))
    }

    func testMissingPacketRequestsResendOnceNewerFrameArrives() {
        let buffer = MediaDatagramFrameRepairBuffer(repairDeadlineNs: 1_000, trackedFrameLimit: 8, maxResendPackets: 64)
        _ = buffer.accept(packet(frame: 1, index: 0, count: 2, payload: Data([0])), now: 0)
        let result = buffer.accept(packet(frame: 2, index: 0, count: 1, payload: Data([2])), now: 10)
        XCTAssertEqual(result.resendRequests, [MediaDatagramRepairRequest(frameId: 1, packetIndexes: [1])])
        XCTAssertTrue(result.completedFrames.isEmpty, "frame 2 is blocked behind the incomplete frame 1")
    }

    func testUnrepairedFrameExpiresPastDeadlineThenLaterFramesDrain() {
        let buffer = MediaDatagramFrameRepairBuffer(repairDeadlineNs: 1_000, trackedFrameLimit: 8, maxResendPackets: 64)
        _ = buffer.accept(packet(frame: 1, index: 0, count: 2, payload: Data([0])), now: 0)
        _ = buffer.accept(packet(frame: 2, index: 0, count: 1, payload: Data([2])), now: 10) // arms frame 1 deadline at 1010
        let result = buffer.accept(packet(frame: 3, index: 0, count: 1, payload: Data([3])), now: 2_000)
        XCTAssertTrue(result.expiredFrames.contains { $0.frameId == 1 }, "frame 1 dropped past its repair deadline")
        XCTAssertEqual(result.completedFrames.map(\.frameId), [2, 3], "frames 2 and 3 drain once the gap is dropped")
    }

    func testTrackedLimitEvictsBeforeRequestingResend() {
        let buffer = MediaDatagramFrameRepairBuffer(repairDeadlineNs: 100_000, trackedFrameLimit: 1, maxResendPackets: 64)
        _ = buffer.accept(packet(frame: 1, index: 0, count: 2, payload: Data([1])), now: 0)
        let result = buffer.accept(packet(frame: 2, index: 0, count: 2, payload: Data([2])), now: 10)
        XCTAssertEqual(result.expiredFrames.map(\.frameId), [1])
        XCTAssertEqual(result.resendRequests, [], "do not NACK a frame we already evicted locally")
    }

    func testLatePacketBeforeDeadlineCompletesAsRepaired() {
        let buffer = MediaDatagramFrameRepairBuffer(repairDeadlineNs: 100_000, trackedFrameLimit: 8, maxResendPackets: 64)
        _ = buffer.accept(packet(frame: 1, index: 0, count: 2, payload: Data([10])), now: 0)
        _ = buffer.accept(packet(frame: 2, index: 0, count: 1, payload: Data([20])), now: 5) // requests resend, arms deadline
        let result = buffer.accept(packet(frame: 1, index: 1, count: 2, payload: Data([11])), now: 10)
        XCTAssertEqual(result.completedFrames.map(\.frameId), [1, 2])
        XCTAssertEqual(result.completedFrames.first { $0.frameId == 1 }?.wasRepaired, true)
        XCTAssertEqual(result.repairedFrameCount, 1)
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
