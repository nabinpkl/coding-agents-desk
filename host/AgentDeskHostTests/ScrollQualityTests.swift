import Foundation
import Testing

@testable import AgentDeskHost

struct ScrollQualityTests {
    @Test func ownedMediaCeilingConfigParsesStrictChromaProfileAndMaxQP() {
        #expect(Config.OwnedMediaChroma(rawEnvironmentValue: "444") == .yuv444)
        #expect(Config.OwnedMediaChroma(rawEnvironmentValue: "bgra") == .bgra)
        #expect(Config.OwnedMediaChroma(rawEnvironmentValue: "unknown") == .yuv420)
        #expect(Config.OwnedMediaHEVCProfile(rawEnvironmentValue: "main444") == .main444)
        #expect(Config.OwnedMediaHEVCProfile(rawEnvironmentValue: "44410") == .main44410)
        #expect(Config.OwnedMediaHEVCProfile(rawEnvironmentValue: "unknown") == nil)
        #expect(Config.ownedMediaMaxQP(environment: ["AGENTDESK_OWNED_MEDIA_MAX_QP": "24"]) == 24)
        #expect(Config.ownedMediaMaxQP(environment: ["AGENTDESK_OWNED_MEDIA_MAX_QP": "0"]) == nil)
    }

    @Test func ownedMediaDatagramHeaderLengthMatchesVersionTwoWireShape() throws {
        func appendUInt16BE(_ value: UInt16, to data: inout Data) {
            data.append(UInt8((value >> 8) & 0xff))
            data.append(UInt8(value & 0xff))
        }
        func appendUInt32BE(_ value: UInt32, to data: inout Data) {
            data.append(UInt8((value >> 24) & 0xff))
            data.append(UInt8((value >> 16) & 0xff))
            data.append(UInt8((value >> 8) & 0xff))
            data.append(UInt8(value & 0xff))
        }
        func appendUInt64BE(_ value: UInt64, to data: inout Data) {
            for shift in stride(from: 56, through: 0, by: -8) {
                data.append(UInt8((value >> UInt64(shift)) & 0xff))
            }
        }

        let payloadLength = 1_050
        var header = Data()
        header.append(Data([0x41, 0x44, 0x4d, 0x44])) // ADMD
        header.append(2)
        header.append(3)
        header.append(1)
        appendUInt32BE(0, to: &header)
        appendUInt64BE(42, to: &header)
        appendUInt16BE(0, to: &header)
        appendUInt16BE(1, to: &header)
        appendUInt64BE(123_456, to: &header)
        appendUInt16BE(UInt16(payloadLength), to: &header)

        #expect(header.count == 33)
        #expect(header[4] == 2)
        #expect(header[6] == 1)
        #expect(header[31] == UInt8((payloadLength >> 8) & 0xff))
        #expect(header[32] == UInt8(payloadLength & 0xff))
        #expect(33 + 32 + payloadLength == 1_115)
    }

    @Test func ownedMediaQuicDatagramDefaultFitsAdmdVersionTwoPacketSize() {
        #expect(Config.ownedMediaQuicMaxDatagramBytes >= 1_115)
    }

    @Test func ownedMediaFreshnessDropsStaleQueuedFrames() {
        var freshness = OwnedMediaSendFreshness()

        freshness.noteEnqueued(frameId: 10, isKeyframe: false)
        freshness.noteEnqueued(frameId: 11, isKeyframe: false)

        #expect(!freshness.shouldSend(frameId: 10, isKeyframe: false))
        #expect(freshness.shouldSend(frameId: 11, isKeyframe: false))
    }

    @Test func ownedMediaFreshnessSupersedesOldKeyframesButKeepsLatestKeyframe() {
        var freshness = OwnedMediaSendFreshness()

        freshness.noteEnqueued(frameId: 20, isKeyframe: true)
        freshness.noteEnqueued(frameId: 21, isKeyframe: false)

        #expect(freshness.shouldSend(frameId: 20, isKeyframe: true))
        #expect(freshness.shouldSend(frameId: 21, isKeyframe: false))

        freshness.noteEnqueued(frameId: 22, isKeyframe: true)

        #expect(!freshness.shouldSend(frameId: 20, isKeyframe: true))
        #expect(freshness.shouldSend(frameId: 22, isKeyframe: true))
    }

    @Test func ownedMediaFreshnessAckClearsInflightFramesAndBytes() {
        var freshness = OwnedMediaSendFreshness()

        freshness.noteSent(frameId: 10, bytes: 120_000)
        freshness.noteSent(frameId: 11, bytes: 140_000)
        freshness.noteSent(frameId: 12, bytes: 160_000)
        freshness.noteAck(frameId: 11, renderGapMs: 10, clientBacklogFrames: 0, clientBacklogBytes: 0)

        #expect(freshness.latestAckedFrameId == 11)
        #expect(freshness.inFlightFrames == [12: 160_000])
    }

    @Test func ownedMediaFreshnessDropsNonKeyframesWhenRenderGapExceedsBudget() {
        var freshness = OwnedMediaSendFreshness()
        let backpressure = OwnedMediaBackpressureConfig(
            renderGapMs: 80,
            maxInflightFrames: 2,
            maxInflightBytes: 300_000
        )

        freshness.noteEnqueued(frameId: 20, isKeyframe: false)
        freshness.noteAck(frameId: 19, renderGapMs: 81, clientBacklogFrames: 0, clientBacklogBytes: 0)

        #expect(!freshness.shouldSend(frameId: 20, isKeyframe: false, backpressure: backpressure))
    }

    @Test func ownedMediaFreshnessDropsNonKeyframesWhenInflightFramesExceedLimit() {
        var freshness = OwnedMediaSendFreshness()
        let backpressure = OwnedMediaBackpressureConfig(
            renderGapMs: 80,
            maxInflightFrames: 2,
            maxInflightBytes: 300_000
        )

        freshness.noteSent(frameId: 10, bytes: 10_000)
        freshness.noteSent(frameId: 11, bytes: 10_000)
        freshness.noteSent(frameId: 12, bytes: 10_000)
        freshness.noteAck(frameId: 9, renderGapMs: 10, clientBacklogFrames: 0, clientBacklogBytes: 0)
        freshness.noteEnqueued(frameId: 13, isKeyframe: false)

        #expect(!freshness.shouldSend(frameId: 13, isKeyframe: false, backpressure: backpressure))
    }

    @Test func ownedMediaFreshnessDropsNonKeyframesWhenInflightBytesExceedLimit() {
        var freshness = OwnedMediaSendFreshness()
        let backpressure = OwnedMediaBackpressureConfig(
            renderGapMs: 80,
            maxInflightFrames: 2,
            maxInflightBytes: 300_000
        )

        freshness.noteSent(frameId: 10, bytes: 200_000)
        freshness.noteSent(frameId: 11, bytes: 200_000)
        freshness.noteAck(frameId: 9, renderGapMs: 10, clientBacklogFrames: 0, clientBacklogBytes: 0)
        freshness.noteEnqueued(frameId: 12, isKeyframe: false)

        #expect(!freshness.shouldSend(frameId: 12, isKeyframe: false, backpressure: backpressure))
    }

    @Test func ownedMediaFreshnessKeepsKeyframesUnderBackpressure() {
        var freshness = OwnedMediaSendFreshness()
        let backpressure = OwnedMediaBackpressureConfig(
            renderGapMs: 80,
            maxInflightFrames: 2,
            maxInflightBytes: 300_000
        )

        freshness.noteAck(frameId: 30, renderGapMs: 200, clientBacklogFrames: 3, clientBacklogBytes: 240_000)
        freshness.noteEnqueued(frameId: 31, isKeyframe: true)

        #expect(freshness.shouldSend(frameId: 31, isKeyframe: true, backpressure: backpressure))
    }

    @Test func ownedMediaDatagramPacingSwitchesUnderBackpressure() {
        let normal = OwnedMediaDatagramPacing(burstPacketCount: 32, burstPauseUs: 1_000)
        let backpressure = OwnedMediaDatagramPacing(burstPacketCount: 16, burstPauseUs: 2_500)

        #expect(OwnedMediaDatagramPacing.choose(
            isBackpressured: false,
            normal: normal,
            backpressure: backpressure
        ) == normal)
        #expect(OwnedMediaDatagramPacing.choose(
            isBackpressured: true,
            normal: normal,
            backpressure: backpressure
        ) == backpressure)
    }

    @Test func ownedMediaResendRingReturnsExactStoredDatagrams() {
        var ring = OwnedMediaResendRing(capacityFrames: 8)
        let packet0 = Data([0x41, 0x44, 0x4d, 0x44, 0x00])
        let packet1 = Data([0x41, 0x44, 0x4d, 0x44, 0x01])
        let packet2 = Data([0x41, 0x44, 0x4d, 0x44, 0x02])

        ring.remember(frameId: 10, packets: [packet0, packet1, packet2])
        let result = ring.packets(frameId: 10, indexes: [2, 0], maxCount: 256)

        #expect(result.packets.map(\.0) == [0, 2])
        #expect(result.packets.map(\.1) == [packet0, packet2])
        #expect(result.misses.isEmpty)
    }

    @Test func ownedMediaResendRingEvictsOlderFrames() {
        var ring = OwnedMediaResendRing(capacityFrames: 2)

        ring.remember(frameId: 1, packets: [Data([1])])
        ring.remember(frameId: 2, packets: [Data([2])])
        ring.remember(frameId: 3, packets: [Data([3])])

        let evicted = ring.packets(frameId: 1, indexes: [0], maxCount: 256)
        let retained = ring.packets(frameId: 3, indexes: [0], maxCount: 256)

        #expect(evicted.packets.isEmpty)
        #expect(evicted.misses == [0])
        #expect(retained.packets.map(\.1) == [Data([3])])
    }

    @Test func ownedCaptureSizingSupportsConfiguredScaleDown() {
        let size = CaptureSizing.pixelSize(
            displayWidthPoints: 1800,
            displayHeightPoints: 1169,
            backingScale: 2.0,
            scaleDownBy: 2.0
        )

        #expect(size.width == 1800)
        #expect(size.height == 1168)
        #expect(size.width.isMultiple(of: 2))
        #expect(size.height.isMultiple(of: 2))
    }
}
