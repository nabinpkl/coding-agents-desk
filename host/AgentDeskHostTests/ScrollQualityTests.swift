import CoreVideo
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

    @Test func ownedMediaMotionBudgetStaysRestWhenDisabled() {
        let policy = OwnedMediaMotionBudgetPolicy(
            enabled: false,
            restBitrateKbps: 8_000,
            restFps: 30,
            restScaleDown: 1.0,
            motionBitrateKbps: 5_000,
            motionFps: 15,
            motionScaleDown: 1.25,
            motionFrameAgeMs: 80,
            motionBacklogFrames: 1,
            motionInflightBytes: 120_000,
            restBudgetHoldMs: 500
        )

        let budget = policy.choose(
            mode: .behind,
            frameAgeMs: 200,
            backlogFrames: 2,
            unacknowledgedBytes: 200_000,
            lastMotionBudgetAtUptimeNs: nil,
            nowUptimeNs: 1_000_000_000
        )

        #expect(budget.mode == .rest)
        #expect(budget.bitrateKbps == 8_000)
        #expect(budget.expectedFrameRate == 30)
    }

    @Test func ownedMediaMotionBudgetCarriesRestAndMotionScaleDown() {
        let policy = OwnedMediaMotionBudgetPolicy(
            enabled: true,
            restBitrateKbps: 8_000,
            restFps: 30,
            restScaleDown: 1.0,
            motionBitrateKbps: 5_000,
            motionFps: 15,
            motionScaleDown: 1.5,
            motionFrameAgeMs: 80,
            motionBacklogFrames: 1,
            motionInflightBytes: 120_000,
            restBudgetHoldMs: 500
        )

        let rest = policy.choose(
            mode: .normal,
            frameAgeMs: 10,
            backlogFrames: 0,
            unacknowledgedBytes: 0,
            lastMotionBudgetAtUptimeNs: nil,
            nowUptimeNs: 1_000_000_000
        )
        let motion = policy.choose(
            mode: .behind,
            frameAgeMs: 120,
            backlogFrames: 0,
            unacknowledgedBytes: 0,
            lastMotionBudgetAtUptimeNs: nil,
            nowUptimeNs: 1_010_000_000
        )

        #expect(rest.mode == .rest)
        #expect(rest.scaleDown == 1.0)
        #expect(motion.mode == .motion)
        #expect(motion.scaleDown == 1.5)
    }

    @Test func ownedMediaMotionBudgetClampsInvalidScaleDownToOne() {
        let budget = OwnedMediaEncodeBudget(
            mode: .motion,
            bitrateKbps: 5_000,
            expectedFrameRate: 15,
            scaleDown: 0.5
        )

        #expect(budget.scaleDown == 1.0)
    }

    @Test func ownedMediaMotionBudgetControlsCadenceDuringRestHold() {
        let budget = OwnedMediaEncodeBudget(
            mode: .motion,
            bitrateKbps: 5_000,
            expectedFrameRate: 15,
            scaleDown: 1.25
        )

        let interval = OwnedMediaEncodeCadencePolicy.intervalMs(
            admissionIntervalMs: 34,
            budget: budget
        )

        #expect(interval == 67)
    }

    @Test func ownedMediaMotionBudgetTurnsOnForBehindFrameAge() {
        let policy = Self.motionBudgetPolicy()

        let budget = policy.choose(
            mode: .behind,
            frameAgeMs: 90,
            backlogFrames: 0,
            unacknowledgedBytes: 0,
            lastMotionBudgetAtUptimeNs: nil,
            nowUptimeNs: 1_000_000_000
        )

        #expect(budget.mode == .motion)
        #expect(budget.bitrateKbps == 5_000)
        #expect(budget.expectedFrameRate == 15)
    }

    @Test func ownedMediaMotionBudgetTurnsOnForBacklogOrInflightBytes() {
        let policy = Self.motionBudgetPolicy()

        let backlog = policy.choose(
            mode: .normal,
            frameAgeMs: 20,
            backlogFrames: 1,
            unacknowledgedBytes: 0,
            lastMotionBudgetAtUptimeNs: nil,
            nowUptimeNs: 1_000_000_000
        )
        let bytes = policy.choose(
            mode: .normal,
            frameAgeMs: 20,
            backlogFrames: 0,
            unacknowledgedBytes: 130_000,
            lastMotionBudgetAtUptimeNs: nil,
            nowUptimeNs: 1_100_000_000
        )

        #expect(backlog.mode == .motion)
        #expect(bytes.mode == .motion)
    }

    @Test func ownedMediaMotionBudgetHoldsBeforeReturningToRest() {
        let policy = Self.motionBudgetPolicy()

        let held = policy.choose(
            mode: .normal,
            frameAgeMs: 20,
            backlogFrames: 0,
            unacknowledgedBytes: 0,
            lastMotionBudgetAtUptimeNs: 1_000_000_000,
            nowUptimeNs: 1_300_000_000
        )
        let restored = policy.choose(
            mode: .normal,
            frameAgeMs: 20,
            backlogFrames: 0,
            unacknowledgedBytes: 0,
            lastMotionBudgetAtUptimeNs: 1_000_000_000,
            nowUptimeNs: 1_501_000_000
        )

        #expect(held.mode == .motion)
        #expect(restored.mode == .rest)
    }

    @Test func ownedMediaMotionBudgetConfigParsesBooleanAndThresholds() {
        #expect(Config.enabledFlag(environmentKey: "MISSING", defaultValue: true, environment: [:]))
        #expect(!Config.enabledFlag(environmentKey: "FLAG", defaultValue: true, environment: ["FLAG": "0"]))
        #expect(!Config.enabledFlag(environmentKey: "FLAG", defaultValue: true, environment: ["FLAG": "false"]))
        #expect(Config.enabledFlag(environmentKey: "FLAG", defaultValue: false, environment: ["FLAG": "1"]))
        #expect(Config.enabledFlag(environmentKey: "FLAG", defaultValue: false, environment: ["FLAG": "true"]))
    }

    @Test func ownedMediaMotionScaleDownConfigParsesPositiveValues() {
        #expect(Config.ownedMediaMotionScaleDown(environment: ["AGENTDESK_OWNED_MEDIA_MOTION_SCALE_DOWN": "1.5"]) == 1.5)
        #expect(Config.ownedMediaMotionScaleDown(environment: ["AGENTDESK_OWNED_MEDIA_MOTION_SCALE_DOWN": "0"]) == 1.25)
        #expect(Config.ownedMediaMotionScaleDown(environment: ["AGENTDESK_OWNED_MEDIA_MOTION_SCALE_DOWN": "bad"]) == 1.25)
    }

    @Test func ownedMediaMotionBudgetStateDoesNotRefreshHoldOnlyMotion() {
        var state = OwnedMediaMotionBudgetState()
        let policy = Self.motionBudgetPolicy()

        let motion = state.choose(
            policy: policy,
            mode: .behind,
            frameAgeMs: 120,
            backlogFrames: 1,
            unacknowledgedBytes: 130_000,
            nowUptimeNs: 1_000_000_000
        )
        let held = state.choose(
            policy: policy,
            mode: .normal,
            frameAgeMs: 20,
            backlogFrames: 0,
            unacknowledgedBytes: 0,
            nowUptimeNs: 1_300_000_000
        )

        #expect(motion.mode == .motion)
        #expect(held.mode == .motion)
        #expect(state.lastMotionBudgetAtUptimeNs == 1_000_000_000)
    }

    @Test func ownedMediaMotionBudgetStateRefreshesOnDirectPressure() {
        var state = OwnedMediaMotionBudgetState()
        let policy = Self.motionBudgetPolicy()

        _ = state.choose(
            policy: policy,
            mode: .behind,
            frameAgeMs: 120,
            backlogFrames: 1,
            unacknowledgedBytes: 130_000,
            nowUptimeNs: 1_000_000_000
        )
        let pressured = state.choose(
            policy: policy,
            mode: .normal,
            frameAgeMs: 90,
            backlogFrames: 0,
            unacknowledgedBytes: 0,
            nowUptimeNs: 1_300_000_000
        )

        #expect(pressured.mode == .motion)
        #expect(state.lastMotionBudgetAtUptimeNs == 1_300_000_000)
    }

    @Test func ownedMediaEncoderBudgetApplicationSkipsUnchangedBudget() {
        var applied = OwnedMediaAppliedEncodeBudget()
        let rest = OwnedMediaEncodeBudget(mode: .rest, bitrateKbps: 8_000, expectedFrameRate: 30)
        let motion = OwnedMediaEncodeBudget(mode: .motion, bitrateKbps: 5_000, expectedFrameRate: 15)

        #expect(applied.shouldApply(rest))
        applied.noteApplied(rest)
        #expect(!applied.shouldApply(rest))
        #expect(applied.shouldApply(motion))

        applied.reset()
        #expect(applied.shouldApply(rest))
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

    @Test func ownedMediaPacingKeepsSmallFramesOnNormalPacing() {
        let policy = OwnedMediaDatagramPacingPolicy(
            largeFramePacketThreshold: 64,
            jumboFramePacketThreshold: 128,
            largeFramePacing: OwnedMediaDatagramPacing(burstPacketCount: 24, burstPauseUs: 1_500),
            jumboFramePacing: OwnedMediaDatagramPacing(burstPacketCount: 16, burstPauseUs: 1_500)
        )

        let choice = policy.choose(
            packetCount: 5,
            isKeyframe: false,
            isBackpressured: false,
            normal: OwnedMediaDatagramPacing(burstPacketCount: 32, burstPauseUs: 1_000),
            backpressure: OwnedMediaDatagramPacing(burstPacketCount: 16, burstPauseUs: 2_500)
        )

        #expect(choice.pacing == OwnedMediaDatagramPacing(burstPacketCount: 32, burstPauseUs: 1_000))
        #expect(choice.reason == .normal)
    }

    @Test func ownedMediaPacingSmoothsLargeDeltaFramesBeforeBackpressure() {
        let policy = OwnedMediaDatagramPacingPolicy(
            largeFramePacketThreshold: 64,
            jumboFramePacketThreshold: 128,
            largeFramePacing: OwnedMediaDatagramPacing(burstPacketCount: 24, burstPauseUs: 1_500),
            jumboFramePacing: OwnedMediaDatagramPacing(burstPacketCount: 16, burstPauseUs: 1_500)
        )

        let choice = policy.choose(
            packetCount: 96,
            isKeyframe: false,
            isBackpressured: false,
            normal: OwnedMediaDatagramPacing(burstPacketCount: 32, burstPauseUs: 1_000),
            backpressure: OwnedMediaDatagramPacing(burstPacketCount: 16, burstPauseUs: 2_500)
        )

        #expect(choice.pacing == OwnedMediaDatagramPacing(burstPacketCount: 24, burstPauseUs: 1_500))
        #expect(choice.reason == .largeFrame)
    }

    @Test func ownedMediaPacingSmoothsJumboDeltaFramesBeforeBackpressure() {
        let policy = OwnedMediaDatagramPacingPolicy(
            largeFramePacketThreshold: 64,
            jumboFramePacketThreshold: 128,
            largeFramePacing: OwnedMediaDatagramPacing(burstPacketCount: 24, burstPauseUs: 1_500),
            jumboFramePacing: OwnedMediaDatagramPacing(burstPacketCount: 16, burstPauseUs: 1_500)
        )

        let choice = policy.choose(
            packetCount: 180,
            isKeyframe: false,
            isBackpressured: false,
            normal: OwnedMediaDatagramPacing(burstPacketCount: 32, burstPauseUs: 1_000),
            backpressure: OwnedMediaDatagramPacing(burstPacketCount: 16, burstPauseUs: 2_500)
        )

        #expect(choice.pacing == OwnedMediaDatagramPacing(burstPacketCount: 16, burstPauseUs: 1_500))
        #expect(choice.reason == .jumboFrame)
    }

    @Test func ownedMediaPacingLetsBackpressureWinOverFrameSize() {
        let policy = OwnedMediaDatagramPacingPolicy(
            largeFramePacketThreshold: 64,
            jumboFramePacketThreshold: 128,
            largeFramePacing: OwnedMediaDatagramPacing(burstPacketCount: 24, burstPauseUs: 1_500),
            jumboFramePacing: OwnedMediaDatagramPacing(burstPacketCount: 16, burstPauseUs: 1_500)
        )

        let choice = policy.choose(
            packetCount: 180,
            isKeyframe: false,
            isBackpressured: true,
            normal: OwnedMediaDatagramPacing(burstPacketCount: 32, burstPauseUs: 1_000),
            backpressure: OwnedMediaDatagramPacing(burstPacketCount: 16, burstPauseUs: 2_500)
        )

        #expect(choice.pacing == OwnedMediaDatagramPacing(burstPacketCount: 16, burstPauseUs: 2_500))
        #expect(choice.reason == .backpressure)
    }

    @Test func ownedMediaPacingKeepsKeyframesOnNormalOrBackpressurePacing() {
        let policy = OwnedMediaDatagramPacingPolicy(
            largeFramePacketThreshold: 64,
            jumboFramePacketThreshold: 128,
            largeFramePacing: OwnedMediaDatagramPacing(burstPacketCount: 24, burstPauseUs: 1_500),
            jumboFramePacing: OwnedMediaDatagramPacing(burstPacketCount: 16, burstPauseUs: 1_500)
        )

        let normalKeyframe = policy.choose(
            packetCount: 180,
            isKeyframe: true,
            isBackpressured: false,
            normal: OwnedMediaDatagramPacing(burstPacketCount: 32, burstPauseUs: 1_000),
            backpressure: OwnedMediaDatagramPacing(burstPacketCount: 16, burstPauseUs: 2_500)
        )

        #expect(normalKeyframe.reason == .normal)
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
            pacingReason: .backpressure,
            isBackpressured: true
        )

        #expect(stats.sendDurationMs == 25)
        #expect(stats.packetCount == 200)
        #expect(stats.burstPauseCount == 12)
        #expect(stats.pacingReason == .backpressure)
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

    @Test func ownedMediaFrameScalerReturnsOriginalFrameWhenScaleIsOne() throws {
        let scaler = OwnedMediaFrameScaler()
        let frame = try Self.makePixelBufferFrame(width: 640, height: 480)

        let scaled = try scaler.scaledFrame(frame, scaleDown: 1.0)

        #expect(CVPixelBufferGetWidth(scaled.pixelBuffer) == 640)
        #expect(CVPixelBufferGetHeight(scaled.pixelBuffer) == 480)
        #expect(scaled.capturedAtUptimeNs == frame.capturedAtUptimeNs)
        #expect(scaled.presentationTimeNs == frame.presentationTimeNs)
    }

    @Test func ownedMediaFrameScalerDownscalesToEvenDimensions() throws {
        let scaler = OwnedMediaFrameScaler()
        let frame = try Self.makePixelBufferFrame(width: 641, height: 481)

        let scaled = try scaler.scaledFrame(frame, scaleDown: 1.5)

        #expect(CVPixelBufferGetWidth(scaled.pixelBuffer) == 426)
        #expect(CVPixelBufferGetHeight(scaled.pixelBuffer) == 320)
        #expect(scaled.capturedAtUptimeNs == frame.capturedAtUptimeNs)
        #expect(scaled.presentationTimeNs == frame.presentationTimeNs)
    }

    @Test func ownedMediaFrameScalerKeepsNativeSizeForRestBudgetAndDownscalesMotionBudget() throws {
        let scaler = OwnedMediaFrameScaler()
        let frame = try Self.makePixelBufferFrame(width: 1_920, height: 1_080)
        let restBudget = OwnedMediaEncodeBudget(
            mode: .rest,
            bitrateKbps: 8_000,
            expectedFrameRate: 30,
            scaleDown: 1.0
        )
        let motionBudget = OwnedMediaEncodeBudget(
            mode: .motion,
            bitrateKbps: 5_000,
            expectedFrameRate: 15,
            scaleDown: 1.5
        )

        let rest = try scaler.scaledFrame(frame, scaleDown: restBudget.scaleDown)
        let motion = try scaler.scaledFrame(frame, scaleDown: motionBudget.scaleDown)

        #expect(CVPixelBufferGetWidth(rest.pixelBuffer) == 1_920)
        #expect(CVPixelBufferGetHeight(rest.pixelBuffer) == 1_080)
        #expect(CVPixelBufferGetWidth(motion.pixelBuffer) == 1_280)
        #expect(CVPixelBufferGetHeight(motion.pixelBuffer) == 720)
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

    private static func motionBudgetPolicy() -> OwnedMediaMotionBudgetPolicy {
        OwnedMediaMotionBudgetPolicy(
            enabled: true,
            restBitrateKbps: 8_000,
            restFps: 30,
            restScaleDown: 1.0,
            motionBitrateKbps: 5_000,
            motionFps: 15,
            motionScaleDown: 1.25,
            motionFrameAgeMs: 80,
            motionBacklogFrames: 1,
            motionInflightBytes: 120_000,
            restBudgetHoldMs: 500
        )
    }

    private static func makePixelBufferFrame(width: Int, height: Int) throws -> CapturedVideoFrame {
        var pixelBuffer: CVPixelBuffer?
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            width,
            height,
            kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
            [
                kCVPixelBufferIOSurfacePropertiesKey: [:],
                kCVPixelBufferCGImageCompatibilityKey: true,
                kCVPixelBufferCGBitmapContextCompatibilityKey: true
            ] as CFDictionary,
            &pixelBuffer
        )
        guard status == kCVReturnSuccess, let pixelBuffer else {
            throw SessionRejected(reason: .malformed)
        }
        return CapturedVideoFrame(
            pixelBuffer: pixelBuffer,
            presentationTimeNs: 123_000_000,
            capturedAtUptimeNs: 456_000_000,
            rotation: ._0
        )
    }
}
