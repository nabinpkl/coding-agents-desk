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

    @Test func ownedMediaFreshnessAckClearsInflightFramesAndBytes() {
        var freshness = OwnedMediaSendFreshness()

        freshness.noteSent(frameId: 10, bytes: 120_000, capturedAtUptimeNs: 1_000_000_000)
        freshness.noteSent(frameId: 11, bytes: 140_000, capturedAtUptimeNs: 1_010_000_000)
        freshness.noteSent(frameId: 12, bytes: 160_000, capturedAtUptimeNs: 1_020_000_000)
        let frameAgeMs = freshness.noteAck(
            frameId: 11,
            renderGapMs: 10,
            clientBacklogFrames: 0,
            clientBacklogBytes: 0,
            nowUptimeNs: 1_050_000_000
        )

        #expect(freshness.latestAckedFrameId == 11)
        #expect(frameAgeMs == 40)
        #expect(freshness.inFlightFrames[12]?.bytes == 160_000)
        #expect(freshness.inFlightBytes == 160_000)
    }

    @Test func ownedMediaFreshnessUsesFrameAgeForBackpressure() {
        var freshness = OwnedMediaSendFreshness()
        let backpressure = Self.backpressureConfig()

        freshness.noteAck(
            frameId: 19,
            renderGapMs: 200,
            clientBacklogFrames: 0,
            clientBacklogBytes: 0,
            nowUptimeNs: 1_040_000_000
        )
        #expect(!freshness.isClientBehind(backpressure: backpressure))

        freshness.noteSent(frameId: 20, bytes: 120_000, capturedAtUptimeNs: 1_000_000_000)
        freshness.noteAck(
            frameId: 20,
            renderGapMs: 10,
            clientBacklogFrames: 0,
            clientBacklogBytes: 0,
            nowUptimeNs: 1_081_000_000
        )
        #expect(freshness.isClientBehind(backpressure: backpressure))
    }

    @Test func ownedMediaFreshnessBackpressuresWhenInflightFramesExceedLimit() {
        var freshness = OwnedMediaSendFreshness()
        let backpressure = Self.backpressureConfig()

        freshness.noteSent(frameId: 10, bytes: 10_000, capturedAtUptimeNs: 1_000_000_000)
        freshness.noteSent(frameId: 11, bytes: 10_000, capturedAtUptimeNs: 1_010_000_000)
        freshness.noteSent(frameId: 12, bytes: 10_000, capturedAtUptimeNs: 1_020_000_000)
        freshness.noteAck(
            frameId: 9,
            renderGapMs: 10,
            clientBacklogFrames: 0,
            clientBacklogBytes: 0,
            nowUptimeNs: 1_040_000_000
        )

        #expect(freshness.isClientBehind(backpressure: backpressure))
    }

    @Test func ownedMediaFreshnessBackpressuresWhenInflightBytesExceedLimit() {
        var freshness = OwnedMediaSendFreshness()
        let backpressure = Self.backpressureConfig()

        freshness.noteSent(frameId: 10, bytes: 200_000, capturedAtUptimeNs: 1_000_000_000)
        freshness.noteSent(frameId: 11, bytes: 200_000, capturedAtUptimeNs: 1_010_000_000)
        freshness.noteAck(
            frameId: 9,
            renderGapMs: 10,
            clientBacklogFrames: 0,
            clientBacklogBytes: 0,
            nowUptimeNs: 1_040_000_000
        )

        #expect(freshness.isClientBehind(backpressure: backpressure))
    }

    @Test func ownedMediaAdmissionChoosesCadenceFromFrameAge() {
        var admission = OwnedMediaEncodeAdmission()
        let backpressure = Self.backpressureConfig()

        #expect(admission.mode == .normal)
        #expect(admission.encodeIntervalMs(config: backpressure) == 34)

        _ = admission.noteAck(
            frameId: 30,
            renderGapMs: 10,
            frameAgeMs: 120,
            clientBacklogFrames: 0,
            clientBacklogBytes: 0,
            nowUptimeNs: 1_000_000_000,
            config: backpressure
        )
        #expect(admission.mode == .behind)
        #expect(admission.encodeIntervalMs(config: backpressure) == 67)

        _ = admission.noteAck(
            frameId: 31,
            renderGapMs: 10,
            frameAgeMs: 600,
            clientBacklogFrames: 0,
            clientBacklogBytes: 0,
            nowUptimeNs: 1_010_000_000,
            config: backpressure
        )
        #expect(admission.mode == .draining)
        #expect(admission.encodeIntervalMs(config: backpressure) == 200)
    }

    @Test func ownedMediaCadenceSchedulerUsesAdmissionStartNotSendEnd() {
        var scheduler = OwnedMediaCadenceScheduler()
        scheduler.noteAdmissionStarted(atUptimeNs: 1_000_000_000)

        let delay = scheduler.delayBeforeNextAdmission(
            nowUptimeNs: 1_042_000_000,
            intervalMs: 67
        )

        #expect(delay == 25_000_000)
    }

    @Test func ownedMediaCadenceSchedulerDoesNotDelayWhenSlotAlreadyPassed() {
        var scheduler = OwnedMediaCadenceScheduler()
        scheduler.noteAdmissionStarted(atUptimeNs: 1_000_000_000)

        let delay = scheduler.delayBeforeNextAdmission(
            nowUptimeNs: 1_080_000_000,
            intervalMs: 67
        )

        #expect(delay == 0)
    }

    @Test func ownedMediaAdmissionEntersDrainInsteadOfImmediateKeyframe() {
        var admission = OwnedMediaEncodeAdmission()
        let backpressure = Self.backpressureConfig()

        let firstSevere = admission.noteAck(
            frameId: 40,
            renderGapMs: 10,
            frameAgeMs: 600,
            clientBacklogFrames: 0,
            clientBacklogBytes: 0,
            nowUptimeNs: 1_000_000_000,
            config: backpressure
        )
        let stillSevere = admission.noteAck(
            frameId: 41,
            renderGapMs: 10,
            frameAgeMs: 700,
            clientBacklogFrames: 0,
            clientBacklogBytes: 0,
            nowUptimeNs: 1_100_000_000,
            config: backpressure
        )

        #expect(firstSevere.enteredDrain)
        #expect(!stillSevere.enteredDrain)
        #expect(admission.decision(nowUptimeNs: 1_200_000_000, config: backpressure).shouldEncode == false)
    }

    @Test func ownedMediaAdmissionNormalModeHonorsUnackedBudget() {
        var admission = OwnedMediaEncodeAdmission()
        let backpressure = Self.backpressureConfig()

        admission.noteSent(
            frameId: 1,
            bytes: 10_000,
            capturedAtUptimeNs: 1_000_000_000,
            isKeyframe: true,
            nowUptimeNs: 1_010_000_000,
            config: backpressure
        )
        #expect(admission.decision(nowUptimeNs: 1_020_000_000, config: backpressure).shouldEncode)

        admission.noteSent(
            frameId: 2,
            bytes: 10_000,
            capturedAtUptimeNs: 1_020_000_000,
            isKeyframe: false,
            nowUptimeNs: 1_030_000_000,
            config: backpressure
        )
        let held = admission.decision(nowUptimeNs: 1_040_000_000, config: backpressure)
        #expect(!held.shouldEncode)
        #expect(held.holdReason == "unacked-normal")
    }

    @Test func ownedMediaAdmissionBehindModeAllowsOneUnackedFrame() {
        var admission = OwnedMediaEncodeAdmission()
        let backpressure = Self.backpressureConfig()

        _ = admission.noteAck(
            frameId: 10,
            renderGapMs: 90,
            frameAgeMs: 120,
            clientBacklogFrames: 1,
            clientBacklogBytes: 10_000,
            nowUptimeNs: 1_000_000_000,
            config: backpressure
        )
        #expect(admission.mode == .behind)
        #expect(admission.decision(nowUptimeNs: 1_010_000_000, config: backpressure).shouldEncode)

        admission.noteSent(
            frameId: 11,
            bytes: 10_000,
            capturedAtUptimeNs: 1_010_000_000,
            isKeyframe: false,
            nowUptimeNs: 1_020_000_000,
            config: backpressure
        )
        let held = admission.decision(nowUptimeNs: 1_030_000_000, config: backpressure)
        #expect(!held.shouldEncode)
        #expect(held.holdReason == "unacked-behind")
    }

    @Test func ownedMediaAdmissionBehindModeKeepsYoungUnackedFrameHeld() {
        var admission = OwnedMediaEncodeAdmission()
        let backpressure = Self.backpressureConfig()

        _ = admission.noteAck(
            frameId: 10,
            renderGapMs: 90,
            frameAgeMs: 120,
            clientBacklogFrames: 1,
            clientBacklogBytes: 10_000,
            nowUptimeNs: 1_000_000_000,
            config: backpressure
        )
        admission.noteSent(
            frameId: 11,
            bytes: 10_000,
            capturedAtUptimeNs: 1_010_000_000,
            isKeyframe: false,
            nowUptimeNs: 1_020_000_000,
            config: backpressure
        )

        let held = admission.decision(nowUptimeNs: 1_250_000_000, config: backpressure)

        #expect(!held.shouldEncode)
        #expect(held.holdReason == "unacked-behind")
        #expect(admission.unacknowledgedFrameCount == 1)
    }

    @Test func ownedMediaAdmissionAbandonsStaleUnackedWithoutForcingKeyframe() {
        var admission = OwnedMediaEncodeAdmission()
        let backpressure = Self.backpressureConfig()

        _ = admission.noteAck(
            frameId: 10,
            renderGapMs: 90,
            frameAgeMs: 120,
            clientBacklogFrames: 1,
            clientBacklogBytes: 10_000,
            nowUptimeNs: 1_000_000_000,
            config: backpressure
        )
        admission.noteSent(
            frameId: 11,
            bytes: 10_000,
            capturedAtUptimeNs: 1_010_000_000,
            isKeyframe: false,
            nowUptimeNs: 1_020_000_000,
            config: backpressure
        )

        let decision = admission.decision(nowUptimeNs: 1_370_000_000, config: backpressure)

        #expect(!decision.shouldEncode)
        #expect(!decision.forceKeyframe)
        #expect(!decision.allowPeriodicKeyframe)
        #expect(decision.keyframeReason == nil)
        #expect(decision.holdReason == "stale-unacked")
        #expect(decision.abandonedStaleUnackedCount == 1)
        #expect(decision.abandonedStaleUnackedBytes == 10_000)
        #expect(decision.abandonedStaleUnackedOldestFrameId == 11)
        #expect(admission.unacknowledgedFrameCount == 0)
    }

    @Test func ownedMediaAdmissionAbandoningStaleKeyframeClearsInflightWithoutImmediateReplacement() {
        var admission = OwnedMediaEncodeAdmission()
        let backpressure = Self.backpressureConfig()

        admission.noteKeyframeRequested()
        let keyframe = admission.decision(nowUptimeNs: 1_000_000_000, config: backpressure)
        #expect(keyframe.forceKeyframe)
        admission.noteSent(
            frameId: 11,
            bytes: 220_000,
            capturedAtUptimeNs: 1_000_000_000,
            isKeyframe: true,
            nowUptimeNs: 1_010_000_000,
            config: backpressure
        )
        _ = admission.noteAck(
            frameId: 10,
            renderGapMs: 90,
            frameAgeMs: 120,
            clientBacklogFrames: 1,
            clientBacklogBytes: 10_000,
            nowUptimeNs: 1_020_000_000,
            config: backpressure
        )

        let decision = admission.decision(nowUptimeNs: 1_360_000_000, config: backpressure)

        #expect(!decision.shouldEncode)
        #expect(!decision.forceKeyframe)
        #expect(decision.keyframeReason == nil)
        #expect(decision.holdReason == "stale-unacked")
        #expect(decision.abandonedStaleUnackedCount == 1)
        #expect(admission.keyframeInFlightFrameId == nil)
    }

    @Test func ownedMediaAdmissionAllowsExplicitClientKeyframeAfterStaleAbandonment() {
        var admission = OwnedMediaEncodeAdmission()
        let backpressure = Self.backpressureConfig()

        _ = admission.noteAck(
            frameId: 10,
            renderGapMs: 90,
            frameAgeMs: 120,
            clientBacklogFrames: 1,
            clientBacklogBytes: 10_000,
            nowUptimeNs: 1_000_000_000,
            config: backpressure
        )
        admission.noteSent(
            frameId: 11,
            bytes: 10_000,
            capturedAtUptimeNs: 1_010_000_000,
            isKeyframe: false,
            nowUptimeNs: 1_020_000_000,
            config: backpressure
        )

        let stale = admission.decision(nowUptimeNs: 1_370_000_000, config: backpressure)
        #expect(!stale.shouldEncode)
        #expect(stale.holdReason == "stale-unacked")

        admission.noteKeyframeRequested()
        let requested = admission.decision(nowUptimeNs: 1_371_000_000, config: backpressure)

        #expect(requested.shouldEncode)
        #expect(requested.forceKeyframe)
        #expect(requested.keyframeReason == .clientRequest)
    }

    @Test func ownedMediaAdmissionPrioritizesClientKeyframeOverBehindUnackedHold() {
        var admission = OwnedMediaEncodeAdmission()
        let backpressure = Self.backpressureConfig()

        _ = admission.noteAck(
            frameId: 40,
            renderGapMs: 200,
            frameAgeMs: 120,
            clientBacklogFrames: 2,
            clientBacklogBytes: 50_000,
            nowUptimeNs: 1_000_000_000,
            config: backpressure
        )
        admission.noteSent(
            frameId: 41,
            bytes: 50_000,
            capturedAtUptimeNs: 1_010_000_000,
            isKeyframe: false,
            nowUptimeNs: 1_020_000_000,
            config: backpressure
        )
        admission.noteKeyframeRequested()

        let decision = admission.decision(nowUptimeNs: 1_030_000_000, config: backpressure)

        #expect(decision.shouldEncode)
        #expect(decision.forceKeyframe)
        #expect(decision.keyframeReason == .clientRequest)
    }

    @Test func ownedMediaAdmissionAckClearsUnackedFramesAndExitsDrain() {
        var admission = OwnedMediaEncodeAdmission()
        let backpressure = Self.backpressureConfig()

        admission.noteSent(
            frameId: 1,
            bytes: 200_000,
            capturedAtUptimeNs: 1_000_000_000,
            isKeyframe: true,
            nowUptimeNs: 1_010_000_000,
            config: backpressure
        )
        admission.noteSent(
            frameId: 2,
            bytes: 200_000,
            capturedAtUptimeNs: 1_020_000_000,
            isKeyframe: false,
            nowUptimeNs: 1_030_000_000,
            config: backpressure
        )
        #expect(admission.mode == .draining)

        let events = admission.noteAck(
            frameId: 2,
            renderGapMs: 10,
            frameAgeMs: 20,
            clientBacklogFrames: 0,
            clientBacklogBytes: 0,
            nowUptimeNs: 1_040_000_000,
            config: backpressure
        )

        #expect(events.exitedDrain)
        #expect(admission.unacknowledgedFrameCount == 0)
        #expect(admission.mode == .normal)
    }

    @Test func ownedMediaAdmissionDrainTimeoutReopensAdmissionWithoutRecoveryKeyframe() {
        var admission = OwnedMediaEncodeAdmission()
        let backpressure = Self.backpressureConfig()

        _ = admission.noteAck(
            frameId: 40,
            renderGapMs: 10,
            frameAgeMs: 600,
            clientBacklogFrames: 0,
            clientBacklogBytes: 0,
            nowUptimeNs: 1_000_000_000,
            config: backpressure
        )

        let beforeTimeout = admission.decision(nowUptimeNs: 1_600_000_000, config: backpressure)
        let afterTimeout = admission.decision(nowUptimeNs: 1_701_000_000, config: backpressure)

        #expect(!beforeTimeout.shouldEncode)
        #expect(afterTimeout.shouldEncode)
        #expect(!afterTimeout.forceKeyframe)
        #expect(!afterTimeout.allowPeriodicKeyframe)
        #expect(afterTimeout.keyframeReason == nil)
    }

    @Test func ownedMediaAdmissionPrioritizesClientKeyframeRequestDuringDrain() {
        var admission = OwnedMediaEncodeAdmission()
        let backpressure = Self.backpressureConfig()

        _ = admission.noteAck(
            frameId: 40,
            renderGapMs: 10,
            frameAgeMs: 600,
            clientBacklogFrames: 0,
            clientBacklogBytes: 0,
            nowUptimeNs: 1_000_000_000,
            config: backpressure
        )
        admission.noteKeyframeRequested()

        let decision = admission.decision(nowUptimeNs: 1_100_000_000, config: backpressure)

        #expect(decision.shouldEncode)
        #expect(decision.forceKeyframe)
        #expect(decision.keyframeReason == .clientRequest)
    }

    @Test func ownedMediaAdmissionSendsExplicitClientKeyframeAfterDrainTimeout() {
        var admission = OwnedMediaEncodeAdmission()
        let backpressure = Self.backpressureConfig()

        _ = admission.noteAck(
            frameId: 40,
            renderGapMs: 10,
            frameAgeMs: 600,
            clientBacklogFrames: 0,
            clientBacklogBytes: 0,
            nowUptimeNs: 1_000_000_000,
            config: backpressure
        )
        admission.noteKeyframeRequested()

        let decision = admission.decision(nowUptimeNs: 1_701_000_000, config: backpressure)

        #expect(decision.shouldEncode)
        #expect(decision.forceKeyframe)
        #expect(decision.keyframeReason == .clientRequest)
    }

    @Test func ownedMediaAdmissionBlocksSecondKeyframeWhileOneIsInFlight() {
        var admission = OwnedMediaEncodeAdmission()
        let backpressure = Self.backpressureConfig()

        admission.noteKeyframeRequested()
        var decision = admission.decision(nowUptimeNs: 1_000_000_000, config: backpressure)
        #expect(decision.forceKeyframe)
        admission.noteSent(
            frameId: 1,
            bytes: 100_000,
            capturedAtUptimeNs: 1_000_000_000,
            isKeyframe: true,
            nowUptimeNs: 1_010_000_000,
            config: backpressure
        )

        admission.noteKeyframeRequested()
        decision = admission.decision(nowUptimeNs: 2_100_000_000, config: backpressure)

        #expect(!decision.shouldEncode)
        #expect(decision.holdReason == "keyframe-inflight")
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

    @Test func ownedMediaDiagnosticsFpsWindowCountsOneSecondSamples() {
        var window = OwnedMediaDiagnosticsFpsWindow(windowStartedAtUptimeNs: 1_000_000_000)
        window.incrementCaptured()
        window.incrementCaptured()
        window.incrementAdmitted()
        window.incrementEncoded()
        window.incrementSent()
        window.incrementAcked()

        let early = window.flushIfDue(nowUptimeNs: 1_999_000_000)
        let sample = window.flushIfDue(nowUptimeNs: 2_000_000_000)

        #expect(early == nil)
        #expect(sample?.captured == 2)
        #expect(sample?.admitted == 1)
        #expect(sample?.encoded == 1)
        #expect(sample?.sent == 1)
        #expect(sample?.acked == 1)
        #expect(sample?.fps(2) == 2)
    }

    @Test func ownedMediaSendStatsReportsDurationAndPacing() {
        let stats = OwnedMediaSendStats(
            frameId: 7,
            encodedBytes: 210_000,
            packetCount: 200,
            sendStartUptimeNs: 1_000_000_000,
            sendEndUptimeNs: 1_025_000_000,
            burstPauseCount: 12,
            maxInterPacketGapMs: 2.5,
            pacingBurstPacketCount: 16,
            pacingBurstPauseUs: 2_500,
            isBackpressured: true
        )

        #expect(stats.sendDurationMs == 25)
        #expect(stats.packetCount == 200)
        #expect(stats.burstPauseCount == 12)
        #expect(stats.isBackpressured)
    }

    @Test func ownedMediaAdmissionAnnotatesKeyframeReason() {
        var admission = OwnedMediaEncodeAdmission()
        let backpressure = Self.backpressureConfig()

        admission.noteKeyframeRequested()
        let clientRequest = admission.decision(
            nowUptimeNs: 1_000_000_000,
            config: backpressure
        )

        #expect(clientRequest.shouldEncode)
        #expect(clientRequest.forceKeyframe)
        #expect(clientRequest.keyframeReason == .clientRequest)
        admission.noteSent(
            frameId: 1,
            bytes: 100_000,
            capturedAtUptimeNs: 1_000_000_000,
            isKeyframe: true,
            nowUptimeNs: 1_010_000_000,
            config: backpressure
        )
        _ = admission.noteAck(
            frameId: 1,
            renderGapMs: 10,
            frameAgeMs: 20,
            clientBacklogFrames: 0,
            clientBacklogBytes: 0,
            nowUptimeNs: 1_020_000_000,
            config: backpressure
        )

        _ = admission.noteAck(
            frameId: 10,
            renderGapMs: 10,
            frameAgeMs: 600,
            clientBacklogFrames: 0,
            clientBacklogBytes: 0,
            nowUptimeNs: 2_000_000_000,
            config: backpressure
        )
        let timedOutDrain = admission.decision(
            nowUptimeNs: 2_800_000_000,
            config: backpressure
        )

        #expect(timedOutDrain.shouldEncode)
        #expect(!timedOutDrain.forceKeyframe)
        #expect(timedOutDrain.keyframeReason == nil)
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

    private static func backpressureConfig() -> OwnedMediaBackpressureConfig {
        OwnedMediaBackpressureConfig(
            frameAgeMs: 80,
            severeFrameAgeMs: 500,
            maxInflightFrames: 2,
            maxInflightBytes: 300_000,
            expectedFrameRate: 30,
            behindEncodeIntervalMs: 67,
            severeEncodeIntervalMs: 200,
            drainTimeoutMs: 700,
            keyframeCooldownMs: 1_000,
            normalMaxUnackedFrames: 2,
            behindMaxUnackedFrames: 1,
            staleUnackedMs: 350
        )
    }
}
