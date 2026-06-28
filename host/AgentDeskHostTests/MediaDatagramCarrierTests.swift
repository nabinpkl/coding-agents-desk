import CryptoKit
import XCTest
@testable import AgentDeskHost

// Phase 2 of the mixed-mode renderer (ADR-0025): the QUIC datagram carrier core.
// These exercise the packet wire format, the host resend ring, and the control
// message codec without a live socket; the round-trips are what the device path
// relies on.
final class MediaDatagramCarrierTests: XCTestCase {
    private let key = MediaDatagramCrypto.key(
        mediaCapability: "owned-hevc",
        clientNonce: Data([1, 2, 3, 4]),
        serverNonce: Data([5, 6, 7, 8])
    )

    private func reassemble(_ packets: [Data]) throws -> Data {
        var decoded = packets.map { try! MediaDatagramFramePacket.decode($0, key: key) }
        decoded.sort { $0.packetIndex < $1.packetIndex }
        return decoded.reduce(Data()) { $0 + $1.payload }
    }

    func testPacketizeThenDecodeRoundTripsASmallFrame() throws {
        let payload = Data((0..<300).map { UInt8($0 % 256) })
        let packets = try MediaDatagramFramePacket.packetize(
            frameId: 42, isKeyframe: true, sentAtUptimeNs: 1_000, payload: payload, key: key
        )
        XCTAssertEqual(packets.count, 1, "300 bytes fits one packet")
        let packet = try MediaDatagramFramePacket.decode(packets[0], key: key)
        XCTAssertEqual(packet.frameId, 42)
        XCTAssertEqual(packet.packetIndex, 0)
        XCTAssertEqual(packet.packetCount, 1)
        XCTAssertTrue(packet.isKeyframe)
        XCTAssertEqual(packet.payload, payload)
    }

    func testLargeFrameFragmentsAndReassembles() throws {
        let payload = Data((0..<(MediaDatagramFramePacket.maxPayloadBytes * 3 + 17)).map { UInt8($0 % 251) })
        let packets = try MediaDatagramFramePacket.packetize(
            frameId: 7, isKeyframe: false, sentAtUptimeNs: 99, payload: payload, key: key
        )
        XCTAssertEqual(packets.count, 4, "three full packets plus a remainder")
        XCTAssertEqual(try reassemble(packets), payload)
        for raw in packets {
            let packet = try MediaDatagramFramePacket.decode(raw, key: key)
            XCTAssertEqual(packet.packetCount, 4)
            XCTAssertFalse(packet.isKeyframe)
        }
    }

    func testWrongKeyFailsAuthentication() throws {
        let packets = try MediaDatagramFramePacket.packetize(
            frameId: 1, isKeyframe: true, sentAtUptimeNs: 0, payload: Data([9, 9, 9]), key: key
        )
        let otherKey = SymmetricKey(data: Data(repeating: 0xAB, count: 32))
        XCTAssertThrowsError(try MediaDatagramFramePacket.decode(packets[0], key: otherKey)) { error in
            XCTAssertEqual(error as? MediaDatagramPacketError, .authenticationFailed)
        }
    }

    func testTruncatedPacketIsMalformed() throws {
        let packets = try MediaDatagramFramePacket.packetize(
            frameId: 1, isKeyframe: true, sentAtUptimeNs: 0, payload: Data([1, 2, 3]), key: key
        )
        let truncated = packets[0].prefix(10)
        XCTAssertThrowsError(try MediaDatagramFramePacket.decode(truncated, key: key)) { error in
            XCTAssertEqual(error as? MediaDatagramPacketError, .malformed)
        }
    }

    func testResendRingServesRememberedPacketsAndReportsMisses() {
        var ring = OwnedMediaResendRing(capacityFrames: 4)
        let packets = [Data([0]), Data([1]), Data([2])]
        ring.remember(frameId: 5, packets: packets)
        let served = ring.packets(frameId: 5, indexes: [0, 2, 9], maxCount: 8)
        XCTAssertEqual(served.packets.map(\.0), [0, 2])
        XCTAssertEqual(served.packets.map(\.1), [Data([0]), Data([2])])
        XCTAssertEqual(served.misses, [9])
    }

    func testResendRingEvictsOldestPastCapacity() {
        var ring = OwnedMediaResendRing(capacityFrames: 2)
        ring.remember(frameId: 1, packets: [Data([1])])
        ring.remember(frameId: 2, packets: [Data([2])])
        ring.remember(frameId: 3, packets: [Data([3])]) // evicts frame 1
        XCTAssertTrue(ring.packets(frameId: 1, indexes: [0], maxCount: 4).packets.isEmpty)
        XCTAssertEqual(ring.packets(frameId: 3, indexes: [0], maxCount: 4).packets.count, 1)
    }

    func testControlMessageRoundTrips() throws {
        for message in [
            OwnedMediaControlMessage(kind: .keyframeRequest, frameId: 12),
            OwnedMediaControlMessage(kind: .packetResendRequest, frameId: 12, packetIndexes: [1, 4, 9])
        ] {
            let data = try JSONEncoder().encode(message)
            let decoded = try JSONDecoder().decode(OwnedMediaControlMessage.self, from: data)
            XCTAssertEqual(decoded.kind, message.kind)
            XCTAssertEqual(decoded.frameId, message.frameId)
            XCTAssertEqual(decoded.packetIndexes, message.packetIndexes)
        }
    }

    // ADR-0027 R87: the link-health message carries the window's completed/expired
    // counts through the same JSON control codec.
    func testLinkHealthMessageRoundTrips() throws {
        let message = OwnedMediaControlMessage(
            kind: .linkHealth, frameId: 0,
            linkHealthCompletedFrames: 142, linkHealthExpiredFrames: 7
        )
        let decoded = try JSONDecoder().decode(
            OwnedMediaControlMessage.self, from: JSONEncoder().encode(message)
        )
        XCTAssertEqual(decoded.kind, .linkHealth)
        XCTAssertEqual(decoded.linkHealthCompletedFrames, 142)
        XCTAssertEqual(decoded.linkHealthExpiredFrames, 7)
    }
}
