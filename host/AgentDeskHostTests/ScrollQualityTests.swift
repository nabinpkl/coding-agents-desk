import CoreVideo
import Compression
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

    @Test func graphicsPortDefaultsToSecondConfiguredPort() {
        #expect(Config.graphicsPort(environment: [:]) == 41_889)
    }

    @Test func graphicsPortUsesEnvironmentOverrideWhenValid() {
        #expect(Config.graphicsPort(environment: ["AGENTDESK_GRAPHICS_PORT": "41999"]) == 41_999)
    }

    @Test func graphicsPortFallsBackForInvalidEnvironmentOverride() {
        #expect(Config.graphicsPort(environment: ["AGENTDESK_GRAPHICS_PORT": "0"]) == 41_889)
        #expect(Config.graphicsPort(environment: ["AGENTDESK_GRAPHICS_PORT": "99999"]) == 41_889)
        #expect(Config.graphicsPort(environment: ["AGENTDESK_GRAPHICS_PORT": "not-a-port"]) == 41_889)
    }

    @Test func graphicsListenerConfigurationUsesGraphicsPortAndReliableQuic() {
        let configuration = OwnedQuicListenerConfigurations.graphics()

        #expect(configuration.port == Config.graphicsPort)
        #expect(configuration.alpn == "agentdesk-owned-graphics")
        #expect(!configuration.usesDatagrams)
        #expect(configuration.maxDatagramFrameSize == nil)
    }

    @Test func hybridScrollConfigDefaultsToSuppressHevcDuringAcceptedScroll() {
        #expect(Config.hybridScrollHEVCFps == 0)
        #expect(Config.hybridScrollIdleRefreshMs == 250)
    }

    @Test func hybridScrollHevcAdmissionSuppressesAcceptedScrollAtZeroFps() {
        var admission = HybridScrollHEVCAdmission()

        admission.noteAcceptedScroll(nowUptimeNs: 1_000_000_000)

        #expect(admission.pendingIdleRefresh)
        #expect(admission.decisionAfterAcceptedScroll(
            nowUptimeNs: 1_000_000_000,
            scrollHEVCFps: 0
        ) == .suppress)
    }

    @Test func hybridScrollHevcAdmissionRateLimitsNonzeroScrollFps() {
        var admission = HybridScrollHEVCAdmission()

        admission.noteAcceptedScroll(nowUptimeNs: 1_000_000_000)

        #expect(admission.decisionAfterAcceptedScroll(
            nowUptimeNs: 1_000_000_000,
            scrollHEVCFps: 3
        ) == .allow)
        #expect(admission.decisionAfterAcceptedScroll(
            nowUptimeNs: 1_100_000_000,
            scrollHEVCFps: 3
        ) == .rateLimited)
        #expect(admission.decisionAfterAcceptedScroll(
            nowUptimeNs: 1_334_000_000,
            scrollHEVCFps: 3
        ) == .allow)
    }

    @Test func hybridScrollHevcAdmissionEmitsExactlyOneIdleRefresh() {
        var admission = HybridScrollHEVCAdmission()

        admission.noteAcceptedScroll(nowUptimeNs: 2_000_000_000)
        let beforeIdle = admission.idleRefreshDue(nowUptimeNs: 2_249_000_000, idleRefreshMs: 250)
        let atIdle = admission.idleRefreshDue(nowUptimeNs: 2_250_000_000, idleRefreshMs: 250)
        let afterConsumed = admission.idleRefreshDue(nowUptimeNs: 2_750_000_000, idleRefreshMs: 250)

        #expect(!beforeIdle)
        #expect(atIdle)
        #expect(!afterConsumed)
    }

    @Test func hybridHevcFallbackReasonsDoNotRequestKeyframes() {
        let reasons: [OwnedHybridHEVCFallbackReason] = [
            .scrollTimeout,
            .graphicsDisconnected,
            .graphicsReset,
            .graphicsSendFailed,
            .graphicsResetSendFailed,
            .rejectedMotion
        ]

        #expect(reasons.allSatisfy { !$0.requestsKeyframe })
        #expect(reasons.map(\.rawValue).contains("scroll-timeout"))
        #expect(reasons.map(\.rawValue).contains("graphics-disconnected"))
    }

    @Test func ownedGraphicsAdmissionAckClearsInflightFramesAndBytes() {
        var admission = OwnedGraphicsAdmission()
        let config = Self.graphicsAdmissionConfig()

        admission.noteSent(
            updateId: OwnedSurfaceUpdateId(surfaceGeneration: 1, frameId: 10),
            encodedBytes: 40_000,
            config: config
        )
        admission.noteSent(
            updateId: OwnedSurfaceUpdateId(surfaceGeneration: 1, frameId: 11),
            encodedBytes: 50_000,
            config: config
        )
        admission.noteAck(
            OwnedGraphicsFrameAck(
                surfaceGeneration: 1,
                frameId: 10,
                compositorMs: 1,
                queueDepthBytes: 0,
                queuedFrames: 0,
                totalGraphicsFramesApplied: 1,
                staleDiscardCount: 0
            ),
            config: config
        )

        #expect(admission.unackedFrameCount == 1)
        #expect(admission.unackedByteCount == 50_000)
        #expect(admission.decision(allowsReset: false, config: config).shouldBuildCommands)
    }

    @Test func ownedGraphicsAdmissionUsesAckQueueDepthForBehindAndSevere() {
        var behind = OwnedGraphicsAdmission()
        let config = Self.graphicsAdmissionConfig()

        behind.noteAck(
            OwnedGraphicsFrameAck(
                surfaceGeneration: 1,
                frameId: 1,
                compositorMs: 1,
                queueDepthBytes: 130_000,
                queuedFrames: 1,
                totalGraphicsFramesApplied: 1,
                staleDiscardCount: 0
            ),
            config: config
        )
        #expect(behind.mode == .behind)

        var severe = OwnedGraphicsAdmission()
        severe.noteAck(
            OwnedGraphicsFrameAck(
                surfaceGeneration: 1,
                frameId: 2,
                compositorMs: 1,
                queueDepthBytes: 370_000,
                queuedFrames: 3,
                totalGraphicsFramesApplied: 2,
                staleDiscardCount: 0
            ),
            config: config
        )
        let decision = severe.decision(allowsReset: false, config: config)

        #expect(decision.mode == .severe)
        #expect(!decision.shouldBuildCommands)
        #expect(decision.reason == "graphics-severe")
    }

    @Test func ownedGraphicsAdmissionDoesNotStallForeverAfterSingleSlowCompositorAck() {
        var admission = OwnedGraphicsAdmission()
        let config = Self.graphicsAdmissionConfig()

        admission.noteSent(
            updateId: OwnedSurfaceUpdateId(surfaceGeneration: 1, frameId: 10),
            encodedBytes: 40_000,
            config: config
        )
        admission.noteAck(
            OwnedGraphicsFrameAck(
                surfaceGeneration: 1,
                frameId: 10,
                compositorMs: 30,
                queueDepthBytes: 0,
                queuedFrames: 0,
                totalGraphicsFramesApplied: 1,
                staleDiscardCount: 0
            ),
            config: config
        )

        let decision = admission.decision(allowsReset: false, config: config)

        #expect(decision.mode == .behind)
        #expect(decision.shouldBuildCommands)
        #expect(decision.unackedFrames == 0)
    }

    @Test func ownedGraphicsAdmissionClampsBehindBudgetSoCompositorAckCannotDeadlock() {
        var admission = OwnedGraphicsAdmission()
        let config = OwnedGraphicsAdmissionConfig(
            normalMaxUnackedFrames: 2,
            behindMaxUnackedFrames: 0,
            maxUnackedBytes: 180_000,
            behindQueuedFrames: 1,
            severeQueuedFrames: 3,
            behindQueueDepthBytes: 120_000,
            severeQueueDepthBytes: 360_000,
            behindCompositorMs: 8,
            severeCompositorMs: 24
        )

        admission.noteSent(
            updateId: OwnedSurfaceUpdateId(surfaceGeneration: 1, frameId: 10),
            encodedBytes: 40_000,
            config: config
        )
        admission.noteAck(
            OwnedGraphicsFrameAck(
                surfaceGeneration: 1,
                frameId: 10,
                compositorMs: 30,
                queueDepthBytes: 0,
                queuedFrames: 0,
                totalGraphicsFramesApplied: 1,
                staleDiscardCount: 0
            ),
            config: config
        )

        let decision = admission.decision(allowsReset: false, config: config)

        #expect(config.behindMaxUnackedFrames == 1)
        #expect(decision.mode == .behind)
        #expect(decision.shouldBuildCommands)
        #expect(decision.unackedFrames == 0)
    }

    @Test func ownedGraphicsAdmissionLimitsUnackedFramesAndLetsResetBypassHold() {
        var admission = OwnedGraphicsAdmission()
        let config = Self.graphicsAdmissionConfig()

        admission.noteSent(
            updateId: OwnedSurfaceUpdateId(surfaceGeneration: 1, frameId: 10),
            encodedBytes: 40_000,
            config: config
        )
        admission.noteSent(
            updateId: OwnedSurfaceUpdateId(surfaceGeneration: 1, frameId: 11),
            encodedBytes: 40_000,
            config: config
        )

        let held = admission.decision(allowsReset: false, config: config)
        let reset = admission.decision(allowsReset: true, config: config)

        #expect(!held.shouldBuildCommands)
        #expect(held.reason == "graphics-unacked-frames")
        #expect(reset.shouldBuildCommands)
    }

    @Test func mediaListenerConfigurationStillUsesSignalingPortAndDatagrams() {
        let configuration = OwnedQuicListenerConfigurations.mediaDatagram()

        #expect(configuration.port == Config.signalingPort)
        #expect(configuration.alpn == "agentdesk-owned-media")
        #expect(configuration.usesDatagrams)
        #expect(configuration.maxDatagramFrameSize == Config.ownedMediaQuicMaxDatagramBytes)
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

    @Test func ownedMediaEncoderMapsClientKeyframeToResetRefreshReason() {
        #expect(OwnedMediaRefreshReason.fromEncodedFrame(
            frameId: 1,
            isKeyframe: true,
            requestedKeyframeReason: nil,
            expectedKeyframeReason: .initial
        ) == .initial)
        #expect(OwnedMediaRefreshReason.fromEncodedFrame(
            frameId: 20,
            isKeyframe: false,
            requestedKeyframeReason: .clientRequest,
            expectedKeyframeReason: .clientRequest
        ) == .rest)
        #expect(OwnedMediaRefreshReason.fromEncodedFrame(
            frameId: 21,
            isKeyframe: true,
            requestedKeyframeReason: .periodic,
            expectedKeyframeReason: .periodic
        ) == .rest)
        #expect(OwnedMediaRefreshReason.fromEncodedFrame(
            frameId: 22,
            isKeyframe: true,
            requestedKeyframeReason: .clientRequest,
            expectedKeyframeReason: .clientRequest
        ) == .reset)
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

    @Test func hybridHevcKeepsNativeScaleWhenRetainedGraphicsIsAvailable() {
        #expect(OwnedHybridHEVCScalePolicy.encodeScaleDown(requestedScaleDown: 1.5, retainedGraphicsAvailable: true) == 1.0)
        #expect(OwnedHybridHEVCScalePolicy.encodeScaleDown(requestedScaleDown: 1.5, retainedGraphicsAvailable: false) == 1.5)
        #expect(OwnedHybridHEVCScalePolicy.encodeScaleDown(requestedScaleDown: 0.5, retainedGraphicsAvailable: false) == 1.0)
    }

    @Test func graphicsStreamParserWaitsForPartialFrameAndParsesMultipleFrames() throws {
        let first = try Self.makeGraphicsEnvelope(frameId: 1).encode()
        let secondEnvelope = Self.makeGraphicsEnvelope(frameId: 2)
        let second = try secondEnvelope.encode()
        var parser = OwnedGraphicsStreamFrameParser()

        #expect(try parser.append(Data(first.prefix(5))).isEmpty)
        let completed = try parser.append(Data(first.dropFirst(5)))
        #expect(completed.map(\.header.frameId) == [1])

        let combined = try parser.append(second + second)
        #expect(combined == [secondEnvelope, secondEnvelope])
    }

    @Test func graphicsStreamParserAcceptsNearLimitFrameWithCoalescedNextFrame() throws {
        let secondEnvelope = Self.makeGraphicsEnvelope(frameId: 2)
        let second = try secondEnvelope.encode()
        let first = try Self.makeNearMaximumGraphicsFrame(frameId: 1, followingFrameByteCount: second.count)
        #expect(first.count <= OwnedGraphicsStreamFrameParser.maxFrameByteCount)
        #expect(first.count + second.count > OwnedGraphicsStreamFrameParser.maxFrameByteCount)
        var parser = OwnedGraphicsStreamFrameParser()

        let frames = try parser.append(first + second)

        #expect(frames.map(\.header.frameId) == [1, 2])
    }

    @Test func graphicsStreamParserRejectsMalformedMagic() throws {
        var parser = OwnedGraphicsStreamFrameParser()

        #expect(throws: SessionRejected(reason: .malformed)) {
            _ = try parser.append(Data([0x42, 0x41, 0x44, 0x21, 1, 0, 0, 0, 0, 0, 0, 0, 0]))
        }
    }

    @Test func scrollDeltaEngineEmitsVerticalCopyRectAndExposedStrip() throws {
        var engine = ScrollDeltaEngine()
        let previous = try Self.makeBGRAFrame(width: 64, height: 64) { x, y in
            Self.pixel(x: x, y: y)
        }
        let current = try Self.makeBGRAFrame(width: 64, height: 64) { x, y in
            y < 48 ? Self.pixel(x: x, y: y + 16) : Self.exposedPixel(x: x, y: y)
        }

        #expect(engine.evaluate(previous).kind == .reset)
        engine.commitPendingSurface()
        let result = engine.evaluate(current)

        #expect(result.kind == ScrollDeltaKind.accepted)
        let diagnostics = try #require(result.diagnostics)
        #expect(diagnostics.acceptedDx == 0)
        #expect(diagnostics.acceptedDy == -16)
        #expect(diagnostics.confidence >= 0.92)
        #expect(diagnostics.sampledPixelCount > 0)
        #expect(diagnostics.payloadBuildMs != nil)
        let envelope = try #require(result.envelope)
        #expect(envelope.commands.count == 2)
        #expect(envelope.commands[0] == OwnedGraphicsCommand.copyRect(srcX: 0, srcY: 16, dstX: 0, dstY: 0, width: 64, height: 48))
        #expect(envelope.commands[1] == OwnedGraphicsCommand.bitmapTile(
            x: 0,
            y: 48,
            width: 64,
            height: 16,
            compression: OwnedGraphicsTileCompression.lzfse,
            byteRange: OwnedGraphicsByteRange(offset: 0, length: envelope.payload.count)
        ))
        let decoded = try Self.decompressLZFSE(envelope.payload, expectedCount: 64 * 16 * 4)
        #expect(decoded == Self.tileBytes(width: 64, height: 16) { x, row in
            Self.exposedPixel(x: x, y: row + 48)
        })
    }

    @Test func scrollDeltaEngineSamplesLumaBeforePayloadBuildFor420Scroll() throws {
        var engine = ScrollDeltaEngine()
        let previous = try Self.makeBGRAFrame(width: 320, height: 256) { x, y in
            Self.pixel(x: x, y: y)
        }
        let current = try Self.make420Frame(width: 320, height: 256) { x, y in
            y < 224 ? Self.pixel(x: x, y: y + 32) : Self.exposedPixel(x: x, y: y)
        }

        #expect(engine.evaluate(previous).kind == .reset)
        engine.commitPendingSurface()
        let result = engine.evaluate(current)

        #expect(result.kind == ScrollDeltaKind.accepted)
        let diagnostics = try #require(result.diagnostics)
        #expect(diagnostics.acceptedDx == 0)
        #expect(diagnostics.acceptedDy == -32)
        #expect(diagnostics.confidence >= 0.92)
        #expect(diagnostics.sampledPixelCount > 0)
        #expect(diagnostics.payloadBuildMs != nil)
        let envelope = try #require(result.envelope)
        #expect(envelope.commands[0] == OwnedGraphicsCommand.copyRect(srcX: 0, srcY: 32, dstX: 0, dstY: 0, width: 320, height: 224))
    }

    @Test func scrollDeltaEngineEmitsHorizontalCopyRectAndExposedStrip() throws {
        var engine = ScrollDeltaEngine()
        let previous = try Self.makeBGRAFrame(width: 64, height: 64) { x, y in
            Self.pixel(x: x, y: y)
        }
        let current = try Self.makeBGRAFrame(width: 64, height: 64) { x, y in
            x < 48 ? Self.pixel(x: x + 16, y: y) : Self.exposedPixel(x: x, y: y)
        }

        #expect(engine.evaluate(previous).kind == .reset)
        engine.commitPendingSurface()
        let result = engine.evaluate(current)

        #expect(result.kind == ScrollDeltaKind.accepted)
        let diagnostics = try #require(result.diagnostics)
        #expect(diagnostics.acceptedDx == -16)
        #expect(diagnostics.acceptedDy == 0)
        #expect(diagnostics.confidence >= 0.92)
        #expect(diagnostics.sampledPixelCount > 0)
        #expect(diagnostics.payloadBuildMs != nil)
        let envelope = try #require(result.envelope)
        #expect(envelope.commands[0] == OwnedGraphicsCommand.copyRect(srcX: 16, srcY: 0, dstX: 0, dstY: 0, width: 48, height: 64))
        #expect(envelope.commands[1] == OwnedGraphicsCommand.bitmapTile(
            x: 48,
            y: 0,
            width: 16,
            height: 64,
            compression: OwnedGraphicsTileCompression.lzfse,
            byteRange: OwnedGraphicsByteRange(offset: 0, length: envelope.payload.count)
        ))
    }

    @Test func scrollDeltaEngineRejectsUnexplainedMotion() throws {
        var engine = ScrollDeltaEngine()
        let previous = try Self.makeBGRAFrame(width: 64, height: 64) { x, y in
            Self.pixel(x: x, y: y)
        }
        let current = try Self.makeBGRAFrame(width: 64, height: 64) { x, y in
            [UInt8((x * 11 + y * 13) & 0xff), UInt8((x * 17) & 0xff), UInt8((y * 19) & 0xff), 0xff]
        }

        #expect(engine.evaluate(previous).kind == .reset)
        engine.commitPendingSurface()
        let result = engine.evaluate(current)

        if case .rejected = result.kind {
            #expect(result.envelope == nil)
            let diagnostics = try #require(result.diagnostics)
            #expect(diagnostics.acceptedDx == nil)
            #expect(diagnostics.acceptedDy == nil)
            #expect(diagnostics.payloadBuildMs == nil)
            #expect(diagnostics.sampledPixelCount > 0)
        } else {
            Issue.record("expected rejected motion")
        }
    }

    @Test func scrollDeltaEngineProbeTimeoutBuildsNoGraphicsPayload() throws {
        var engine = ScrollDeltaEngine()
        let previous = try Self.makeBGRAFrame(width: 64, height: 64) { x, y in
            Self.pixel(x: x, y: y)
        }
        let current = try Self.makeBGRAFrame(width: 64, height: 64) { x, y in
            y < 48 ? Self.pixel(x: x, y: y + 16) : Self.exposedPixel(x: x, y: y)
        }

        #expect(engine.evaluate(previous).kind == .reset)
        engine.commitPendingSurface()
        let result = engine.evaluate(current, detectionBudgetMs: 0)

        #expect(result.kind == ScrollDeltaKind.timeout)
        #expect(result.envelope == nil)
        let diagnostics = try #require(result.diagnostics)
        #expect(diagnostics.timeoutReason == "probe-budget-exceeded")
        #expect(diagnostics.payloadBuildMs == nil)
        #expect(diagnostics.acceptedDx == nil)
        #expect(diagnostics.acceptedDy == nil)
    }

    @Test func scrollDeltaEngineTimeoutDoesNotReplaceCommittedBaseline() throws {
        var timeoutEngine = ScrollDeltaEngine()
        let previous = try Self.makeBGRAFrame(width: 64, height: 64) { x, y in
            Self.pixel(x: x, y: y)
        }
        let timedOut = try Self.makeBGRAFrame(width: 64, height: 64) { x, y in
            y < 48 ? Self.pixel(x: x, y: y + 16) : Self.exposedPixel(x: x, y: y)
        }
        let currentFromOriginalBaseline = try Self.makeBGRAFrame(width: 64, height: 64) { x, y in
            y < 40 ? Self.pixel(x: x, y: y + 24) : Self.exposedPixel(x: x, y: y)
        }

        #expect(timeoutEngine.evaluate(previous).kind == .reset)
        timeoutEngine.commitPendingSurface()
        #expect(timeoutEngine.evaluate(timedOut, detectionBudgetMs: 0).kind == .timeout)

        var resumedEngine = timeoutEngine
        let resumed = resumedEngine.evaluate(currentFromOriginalBaseline)

        #expect(resumed.kind == .accepted)
        #expect(resumed.diagnostics?.acceptedDy == -24)
    }

    @Test func scrollDeltaEngineFallbackObservationRealignsProbeBaseline() throws {
        var engine = ScrollDeltaEngine()
        let first = try Self.makeBGRAFrame(width: 64, height: 64) { x, y in
            Self.pixel(x: x, y: y)
        }
        let fallback = try Self.makeBGRAFrame(width: 64, height: 64) { x, y in
            Self.pixel(x: x, y: y + 31)
        }
        let current = try Self.makeBGRAFrame(width: 64, height: 64) { x, y in
            y < 48 ? Self.pixel(x: x, y: y + 47) : Self.exposedPixel(x: x, y: y)
        }

        #expect(engine.evaluate(first).kind == .reset)
        engine.commitPendingSurface()
        engine.observeFallbackFrame(fallback)
        let result = engine.evaluate(current)

        #expect(result.kind == .accepted)
        #expect(result.diagnostics?.acceptedDy == -16)
    }

    @Test func scrollDeltaEngineResetsOnResizeAndReservesHevcIdsInSameGeneration() throws {
        var engine = ScrollDeltaEngine()
        let previous = try Self.makeBGRAFrame(width: 64, height: 64) { x, y in
            Self.pixel(x: x, y: y)
        }
        let resized = try Self.makeBGRAFrame(width: 32, height: 64) { x, y in
            Self.pixel(x: x, y: y)
        }

        let first = engine.evaluate(previous)
        engine.commitPendingSurface()
        let refreshId = engine.reserveRefreshUpdateId()
        let reset = engine.evaluate(resized)

        #expect(first.kind == ScrollDeltaKind.reset)
        #expect(refreshId.surfaceGeneration == 1)
        #expect(reset.kind == ScrollDeltaKind.reset)
        #expect(reset.envelope?.header.surfaceGeneration == 2)
        #expect(engine.reserveRefreshUpdateId().surfaceGeneration == 2)
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

    private static func graphicsAdmissionConfig() -> OwnedGraphicsAdmissionConfig {
        OwnedGraphicsAdmissionConfig(
            normalMaxUnackedFrames: 2,
            behindMaxUnackedFrames: 1,
            maxUnackedBytes: 180_000,
            behindQueuedFrames: 1,
            severeQueuedFrames: 3,
            behindQueueDepthBytes: 120_000,
            severeQueueDepthBytes: 360_000,
            behindCompositorMs: 8,
            severeCompositorMs: 24
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

    private static func makeGraphicsEnvelope(frameId: UInt64) -> OwnedGraphicsFrameEnvelope {
        let payload = Data([0x10, 0x20, 0x30])
        return OwnedGraphicsFrameEnvelope(
            header: OwnedGraphicsFrameHeader(
                surfaceGeneration: 1,
                frameId: frameId,
                capturedAtUptimeNs: frameId * 100,
                commandCount: 1,
                payloadLength: payload.count
            ),
            commands: [
                .bitmapTile(
                    x: 0,
                    y: 0,
                    width: 1,
                    height: 1,
                    compression: .lzfse,
                    byteRange: OwnedGraphicsByteRange(offset: 0, length: payload.count)
                )
            ],
            payload: payload
        )
    }

    private static func makeNearMaximumGraphicsFrame(frameId: UInt64, followingFrameByteCount: Int) throws -> Data {
        var payloadCount = OwnedGraphicsStreamFrameParser.maxFrameByteCount
            - OwnedGraphicsFrameEnvelope.fixedHeaderByteCount
        while payloadCount > 0 {
            let payload = Data(repeating: 0x5a, count: payloadCount)
            let envelope = OwnedGraphicsFrameEnvelope(
                header: OwnedGraphicsFrameHeader(
                    surfaceGeneration: 1,
                    frameId: frameId,
                    capturedAtUptimeNs: frameId * 100,
                    commandCount: 1,
                    payloadLength: payload.count
                ),
                commands: [
                    .bitmapTile(
                        x: 0,
                        y: 0,
                        width: 1,
                        height: 1,
                        compression: .lzfse,
                        byteRange: OwnedGraphicsByteRange(offset: 0, length: payload.count)
                    )
                ],
                payload: payload
            )
            let encoded = try envelope.encode()
            if encoded.count <= OwnedGraphicsStreamFrameParser.maxFrameByteCount {
                guard encoded.count + followingFrameByteCount > OwnedGraphicsStreamFrameParser.maxFrameByteCount else {
                    throw SessionRejected(reason: .malformed)
                }
                return encoded
            }
            payloadCount -= max(1, encoded.count - OwnedGraphicsStreamFrameParser.maxFrameByteCount)
        }
        throw SessionRejected(reason: .malformed)
    }

    private static func makeBGRAFrame(
        width: Int,
        height: Int,
        pixel: (Int, Int) -> [UInt8]
    ) throws -> CapturedVideoFrame {
        var pixelBuffer: CVPixelBuffer?
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            width,
            height,
            kCVPixelFormatType_32BGRA,
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
        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }
        guard let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) else {
            throw SessionRejected(reason: .malformed)
        }
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        for y in 0..<height {
            for x in 0..<width {
                let bytes = pixel(x, y)
                let offset = y * bytesPerRow + x * 4
                baseAddress.storeBytes(of: bytes[0], toByteOffset: offset, as: UInt8.self)
                baseAddress.storeBytes(of: bytes[1], toByteOffset: offset + 1, as: UInt8.self)
                baseAddress.storeBytes(of: bytes[2], toByteOffset: offset + 2, as: UInt8.self)
                baseAddress.storeBytes(of: bytes[3], toByteOffset: offset + 3, as: UInt8.self)
            }
        }
        return CapturedVideoFrame(
            pixelBuffer: pixelBuffer,
            presentationTimeNs: 123_000_000,
            capturedAtUptimeNs: 456_000_000,
            rotation: ._0
        )
    }

    private static func make420Frame(
        width: Int,
        height: Int,
        pixel: (Int, Int) -> [UInt8]
    ) throws -> CapturedVideoFrame {
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
        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }
        guard let yBase = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0),
              let uvBase = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 1) else {
            throw SessionRejected(reason: .malformed)
        }
        let yBytesPerRow = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0)
        let uvBytesPerRow = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 1)
        let uvHeight = CVPixelBufferGetHeightOfPlane(pixelBuffer, 1)
        let uvWidth = CVPixelBufferGetWidthOfPlane(pixelBuffer, 1)
        for y in 0..<height {
            for x in 0..<width {
                yBase.storeBytes(
                    of: luma(pixel(x, y)),
                    toByteOffset: y * yBytesPerRow + x,
                    as: UInt8.self
                )
            }
        }
        for y in 0..<uvHeight {
            for x in 0..<uvWidth {
                let offset = y * uvBytesPerRow + x * 2
                uvBase.storeBytes(of: UInt8(128), toByteOffset: offset, as: UInt8.self)
                uvBase.storeBytes(of: UInt8(128), toByteOffset: offset + 1, as: UInt8.self)
            }
        }
        return CapturedVideoFrame(
            pixelBuffer: pixelBuffer,
            presentationTimeNs: 123_000_000,
            capturedAtUptimeNs: 456_000_000,
            rotation: ._0
        )
    }

    private static func pixel(x: Int, y: Int) -> [UInt8] {
        [
            UInt8((x * 3 + y * 5) & 0xff),
            UInt8((x * 7 + y * 11) & 0xff),
            UInt8((x * 13 + y * 17) & 0xff),
            0xff
        ]
    }

    private static func luma(_ bgra: [UInt8]) -> UInt8 {
        let blue = 29 * Int(bgra[0])
        let green = 150 * Int(bgra[1])
        let red = 77 * Int(bgra[2])
        return UInt8((blue + green + red) >> 8)
    }

    private static func exposedPixel(x: Int, y: Int) -> [UInt8] {
        [
            UInt8((200 + x) & 0xff),
            UInt8((100 + y) & 0xff),
            UInt8((50 + x + y) & 0xff),
            0xff
        ]
    }

    private static func tileBytes(width: Int, height: Int, pixel: (Int, Int) -> [UInt8]) -> Data {
        var data = Data(count: width * height * 4)
        data.withUnsafeMutableBytes { buffer in
            guard let base = buffer.baseAddress else { return }
            for y in 0..<height {
                for x in 0..<width {
                    let bytes = pixel(x, y)
                    let offset = (y * width + x) * 4
                    base.storeBytes(of: bytes[0], toByteOffset: offset, as: UInt8.self)
                    base.storeBytes(of: bytes[1], toByteOffset: offset + 1, as: UInt8.self)
                    base.storeBytes(of: bytes[2], toByteOffset: offset + 2, as: UInt8.self)
                    base.storeBytes(of: bytes[3], toByteOffset: offset + 3, as: UInt8.self)
                }
            }
        }
        return data
    }

    private static func decompressLZFSE(_ data: Data, expectedCount: Int) throws -> Data {
        var output = Data(count: expectedCount)
        let decodedCount = output.withUnsafeMutableBytes { outputBytes in
            data.withUnsafeBytes { inputBytes in
                compression_decode_buffer(
                    outputBytes.bindMemory(to: UInt8.self).baseAddress!,
                    expectedCount,
                    inputBytes.bindMemory(to: UInt8.self).baseAddress!,
                    data.count,
                    nil,
                    COMPRESSION_LZFSE
                )
            }
        }
        guard decodedCount == expectedCount else {
            throw SessionRejected(reason: .malformed)
        }
        return output
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
