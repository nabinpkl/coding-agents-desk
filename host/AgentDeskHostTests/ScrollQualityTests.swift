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
        #expect(Config.hybridScrollOwnershipMs == 500)
        #expect(Config.hybridScrollFallbackAfterMs == 300)
        #expect(Config.hybridScrollOwnershipMaxMisses == 2)
        #expect(Config.hybridScrollViewportMinWidth == 320)
        #expect(Config.hybridScrollViewportMinHeight == 240)
        #expect(Config.hybridScrollViewportConfidence == 0.88)
        #expect(Config.hybridScrollViewportMinInsetPx == 24)
        #expect(Config.hybridScrollViewportOverlap == 0.80)
        #expect(Config.hybridResetStripeMaxDecodedBytes == 2 * 1_024 * 1_024)
        #expect(Config.hybridResetStripeMaxWireBytes == 196_608)
        #expect(Config.hybridResetStripeAckTimeoutMs == 1_000)
        #expect(Config.hybridGraphicsFallbackMinIntervalMs == 1_500)
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

    @Test func hybridScrollHevcAdmissionAllowsHintTimeoutFallbackOnlyAfterGraceWindow() {
        var admission = HybridScrollHEVCAdmission()

        #expect(admission.allowsHintTimeoutFallback(
            nowUptimeNs: 1_000_000_000,
            fallbackGraceMs: 120
        ))

        admission.noteAcceptedScroll(nowUptimeNs: 1_000_000_000)

        #expect(!admission.allowsHintTimeoutFallback(
            nowUptimeNs: 1_119_000_000,
            fallbackGraceMs: 120
        ))
        #expect(admission.allowsHintTimeoutFallback(
            nowUptimeNs: 1_120_000_000,
            fallbackGraceMs: 120
        ))
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
        #expect(!admission.idleRefreshEligible(nowUptimeNs: 2_249_000_000, idleRefreshMs: 250))
        #expect(admission.idleRefreshEligible(nowUptimeNs: 2_250_000_000, idleRefreshMs: 250))
        let beforeIdle = admission.idleRefreshDue(nowUptimeNs: 2_249_000_000, idleRefreshMs: 250)
        let atIdle = admission.idleRefreshDue(nowUptimeNs: 2_250_000_000, idleRefreshMs: 250)
        let afterConsumed = admission.idleRefreshDue(nowUptimeNs: 2_750_000_000, idleRefreshMs: 250)

        #expect(!beforeIdle)
        #expect(atIdle)
        #expect(!afterConsumed)
    }

    @Test func hybridScrollHevcAdmissionEligibilityDoesNotConsumePendingRefresh() {
        var admission = HybridScrollHEVCAdmission()

        admission.noteAcceptedScroll(nowUptimeNs: 2_000_000_000)

        #expect(admission.idleRefreshEligible(nowUptimeNs: 2_250_000_000, idleRefreshMs: 250))
        #expect(admission.pendingIdleRefresh)
        admission.noteActiveScroll(nowUptimeNs: 2_260_000_000)
        #expect(!admission.idleRefreshEligible(nowUptimeNs: 2_300_000_000, idleRefreshMs: 250))
        let refreshDue = admission.idleRefreshDue(nowUptimeNs: 2_510_000_000, idleRefreshMs: 250)
        #expect(refreshDue)
        #expect(!admission.pendingIdleRefresh)
    }

    @Test func scrollCopyOwnershipSuppressesHevcWhileActiveEvenAfterMissBudget() {
        var ownership = ScrollCopyOwnership(config: ScrollCopyOwnershipConfig(
            ownershipTTLMs: 500,
            fallbackAfterMs: 300,
            maxMisses: 2
        ))

        ownership.observeAccepted(
            axis: .vertical,
            sign: -1,
            offsetPx: -24,
            frameId: 42,
            nowUptimeNs: 1_000_000_000
        )
        ownership.observeMiss(nowUptimeNs: 1_100_000_000)
        ownership.observeMiss(nowUptimeNs: 1_200_000_000)
        ownership.observeMiss(nowUptimeNs: 1_400_000_000)

        #expect(ownership.isActive(nowUptimeNs: 1_400_000_000))
        #expect(!ownership.allowsHevcFallback(nowUptimeNs: 1_400_000_000))
        let released = ownership.releaseIfExpired(nowUptimeNs: 1_501_000_000)
        #expect(released)
        #expect(ownership.allowsHevcFallback(nowUptimeNs: 1_501_000_000))
    }

    @Test func hybridHevcFallbackReasonsDoNotRequestKeyframes() {
        let reasons: [OwnedHybridHEVCFallbackReason] = [
            .scrollTimeout,
            .graphicsDisconnected,
            .graphicsReset,
            .graphicsSendFailed,
            .graphicsResetSendFailed,
            .rejectedMotion,
            .scrollRegionBeforeLock
        ]

        #expect(reasons.allSatisfy { !$0.requestsKeyframe })
        #expect(reasons.map(\.rawValue).contains("scroll-timeout"))
        #expect(reasons.map(\.rawValue).contains("graphics-disconnected"))
        #expect(reasons.map(\.rawValue).contains("scroll-region-before-lock"))
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

    @Test func hybridGraphicsRecoveryHevcGateSuppressesAndRateLimitsRecoveryFallback() {
        var gate = HybridGraphicsRecoveryHEVCGate()

        #expect(gate.decision(
            reason: .graphicsReset,
            recoveryState: .resetting,
            nowUptimeNs: 1_000_000_000,
            minIntervalMs: 1_500
        ) == .suppress(reason: "graphics-recovery-resetting"))
        #expect(gate.decision(
            reason: .graphicsDisconnected,
            recoveryState: .reconnecting,
            nowUptimeNs: 2_000_000_000,
            minIntervalMs: 1_500
        ) == .allow)
        #expect(gate.decision(
            reason: .graphicsDisconnected,
            recoveryState: .reconnecting,
            nowUptimeNs: 2_500_000_000,
            minIntervalMs: 1_500
        ) == .suppress(reason: "graphics-recovery-rate-limited"))
        #expect(gate.decision(
            reason: .graphicsDisconnected,
            recoveryState: .reconnecting,
            nowUptimeNs: 3_500_000_000,
            minIntervalMs: 1_500
        ) == .allow)
        #expect(gate.decision(
            reason: .scrollTimeout,
            recoveryState: .failedCoolingDown,
            nowUptimeNs: 3_600_000_000,
            minIntervalMs: 1_500
        ) == .allow)
    }

    @Test func hybridGraphicsRecoveryHevcGateRateLimitsResetSendFailureFallback() {
        var gate = HybridGraphicsRecoveryHEVCGate()

        #expect(gate.decision(
            reason: .graphicsResetSendFailed,
            recoveryState: .failedCoolingDown,
            nowUptimeNs: 10_000_000_000,
            minIntervalMs: 1_500
        ) == .allow)
        #expect(gate.decision(
            reason: .graphicsResetSendFailed,
            recoveryState: .failedCoolingDown,
            nowUptimeNs: 11_000_000_000,
            minIntervalMs: 1_500
        ) == .suppress(reason: "graphics-recovery-rate-limited"))
        #expect(gate.decision(
            reason: .graphicsResetSendFailed,
            recoveryState: .failedCoolingDown,
            nowUptimeNs: 11_500_000_000,
            minIntervalMs: 1_500
        ) == .allow)
    }

    @Test func hybridHevcFallbackPolicySuppressesActiveScrollWhenBaselineCannotRealign() throws {
        var engine = ScrollDeltaEngine()
        let previous = try Self.makeBGRAFrame(width: 64, height: 64) { x, y in
            return Self.pixel(x: x, y: y)
        }
        let fallback = try Self.makeBGRAFrame(width: 64, height: 64) { x, y in
            Self.pixel(x: x, y: y + 31)
        }
        let current = try Self.makeBGRAFrame(width: 64, height: 64) { x, y in
            y < 40 ? Self.pixel(x: x, y: y + 24) : Self.exposedPixel(x: x, y: y)
        }

        #expect(engine.evaluate(previous).kind == .reset)
        engine.commitPendingSurface()
        let decision = HybridHEVCFallbackPolicy.evaluate(
            HybridHEVCFallbackPolicyContext(
                fallbackReason: .scrollTimeout,
                inputScrollActive: true,
                ownershipActive: false,
                regionLockPending: false,
                stableViewportActive: false,
                graphicsRecoveryState: .idle,
                isIdleCorrectnessRefresh: false,
                graphicsRecentlyProducing: true
            )
        )

        #expect(decision.visualDecision == .suppress(reason: "baseline-not-realigned"))
        #expect(decision.baselineDecision == .visualOnly(reason: "active-scroll"))
        if decision.baselineDecision == .realign {
            engine.observeFallbackFrame(fallback)
        }
        let result = engine.evaluate(current)

        #expect(result.kind == .accepted)
        #expect(result.diagnostics?.acceptedDy == -24)
    }

    @Test func hybridHevcFallbackPolicyRealignsIdleCorrectnessRefresh() throws {
        var engine = ScrollDeltaEngine()
        let previous = try Self.makeBGRAFrame(width: 64, height: 64) { x, y in
            return Self.pixel(x: x, y: y)
        }
        let fallback = try Self.makeBGRAFrame(width: 64, height: 64) { x, y in
            Self.pixel(x: x, y: y + 31)
        }
        let current = try Self.makeBGRAFrame(width: 64, height: 64) { x, y in
            y < 48 ? Self.pixel(x: x, y: y + 47) : Self.exposedPixel(x: x, y: y)
        }

        #expect(engine.evaluate(previous).kind == .reset)
        engine.commitPendingSurface()
        let decision = HybridHEVCFallbackPolicy.evaluate(
            HybridHEVCFallbackPolicyContext(
                fallbackReason: nil,
                inputScrollActive: false,
                ownershipActive: false,
                regionLockPending: false,
                stableViewportActive: false,
                graphicsRecoveryState: .idle,
                isIdleCorrectnessRefresh: true,
                graphicsRecentlyProducing: false
            )
        )

        #expect(decision.visualDecision == .allow)
        #expect(decision.baselineDecision == .realign)
        if decision.baselineDecision == .realign {
            engine.observeFallbackFrame(fallback)
        }
        let result = engine.evaluate(current)

        #expect(result.kind == .accepted)
        #expect(result.diagnostics?.acceptedDy == -16)
    }

    @Test func hybridHevcFallbackPolicyRealignsIdleRefreshEvenWithStaleViewportLock() {
        let decision = HybridHEVCFallbackPolicy.evaluate(
            HybridHEVCFallbackPolicyContext(
                fallbackReason: nil,
                inputScrollActive: false,
                ownershipActive: true,
                regionLockPending: false,
                stableViewportActive: true,
                graphicsRecoveryState: .idle,
                isIdleCorrectnessRefresh: true,
                graphicsRecentlyProducing: true
            )
        )

        #expect(decision.visualDecision == .allow)
        #expect(decision.baselineDecision == .realign)
    }

    @Test func hybridHevcFallbackPolicySuppressesViewportTimeoutAndRejectedFallbacks() {
        for reason in [
            OwnedHybridHEVCFallbackReason.scrollTimeout,
            .scrollRegionBeforeLock,
            .rejectedMotion,
            .graphicsReset,
            .graphicsSendFailed,
            .graphicsResetSendFailed
        ] {
            let decision = HybridHEVCFallbackPolicy.evaluate(
                HybridHEVCFallbackPolicyContext(
                    fallbackReason: reason,
                    inputScrollActive: false,
                    ownershipActive: false,
                    regionLockPending: false,
                    stableViewportActive: true,
                    graphicsRecoveryState: .idle,
                    isIdleCorrectnessRefresh: false,
                    graphicsRecentlyProducing: false
                )
            )

            #expect(decision.visualDecision == .suppress(reason: "baseline-not-realigned"))
            #expect(decision.baselineDecision == .visualOnly(reason: "stable-viewport"))
        }
    }

    @Test func hybridHevcFallbackPolicySuppressesRegionLockPendingWhenBaselineCannotRealign() {
        let decision = HybridHEVCFallbackPolicy.evaluate(
            HybridHEVCFallbackPolicyContext(
                fallbackReason: .scrollRegionBeforeLock,
                inputScrollActive: false,
                ownershipActive: false,
                regionLockPending: true,
                stableViewportActive: false,
                graphicsRecoveryState: .idle,
                isIdleCorrectnessRefresh: false,
                graphicsRecentlyProducing: true
            )
        )

        #expect(decision.visualDecision == .suppress(reason: "baseline-not-realigned"))
        #expect(decision.baselineDecision == .visualOnly(reason: "region-lock-pending"))
    }

    @Test func hybridHevcFallbackPolicyRealignsGraphicsRecoveryWhenAllowed() {
        let decision = HybridHEVCFallbackPolicy.evaluate(
            HybridHEVCFallbackPolicyContext(
                fallbackReason: .graphicsDisconnected,
                inputScrollActive: false,
                ownershipActive: false,
                regionLockPending: false,
                stableViewportActive: false,
                graphicsRecoveryState: .reconnecting,
                isIdleCorrectnessRefresh: false,
                graphicsRecentlyProducing: false
            )
        )

        #expect(decision.visualDecision == .allow)
        #expect(decision.baselineDecision == .realign)
    }

    @Test func hybridHevcFallbackPolicyRealignsScrollWhenGraphicsSilent() {
        // Freeze fix: during scroll intent, if graphics is not producing accepted
        // updates, HEVC must carry the motion (realign + allow) instead of being
        // suppressed, otherwise the screen freezes for the scroll duration.
        let contexts = [
            HybridHEVCFallbackPolicyContext(
                fallbackReason: .scrollTimeout,
                inputScrollActive: true,
                ownershipActive: false,
                regionLockPending: false,
                stableViewportActive: false,
                graphicsRecoveryState: .idle,
                isIdleCorrectnessRefresh: false,
                graphicsRecentlyProducing: false
            ),
            HybridHEVCFallbackPolicyContext(
                fallbackReason: .scrollRegionBeforeLock,
                inputScrollActive: false,
                ownershipActive: false,
                regionLockPending: true,
                stableViewportActive: false,
                graphicsRecoveryState: .idle,
                isIdleCorrectnessRefresh: false,
                graphicsRecentlyProducing: false
            )
        ]
        for context in contexts {
            let decision = HybridHEVCFallbackPolicy.evaluate(context)
            #expect(decision.visualDecision == .allow)
            #expect(decision.baselineDecision == .realign)
        }
    }

    @Test func ownedGraphicsAckWaiterCompletesWhenAckCoversUpdate() async {
        let waiter = OwnedGraphicsAckWaiter()
        let task = Task {
            await waiter.wait(
                for: OwnedSurfaceUpdateId(surfaceGeneration: 1, frameId: 10),
                timeoutMs: 1_000
            )
        }

        waiter.noteAck(OwnedGraphicsFrameAck(
            surfaceGeneration: 1,
            frameId: 11,
            compositorMs: 1,
            totalGraphicsFramesApplied: 11,
            staleDiscardCount: 0
        ))

        #expect(await task.value)
    }

    @Test func ownedGraphicsAckWaiterCompletesWhenNewerGenerationCoversUpdate() async {
        let waiter = OwnedGraphicsAckWaiter()
        let task = Task {
            await waiter.wait(
                for: OwnedSurfaceUpdateId(surfaceGeneration: 1, frameId: 200),
                timeoutMs: 1_000
            )
        }

        waiter.noteAck(OwnedGraphicsFrameAck(
            surfaceGeneration: 2,
            frameId: 1,
            compositorMs: 1,
            totalGraphicsFramesApplied: 12,
            staleDiscardCount: 0
        ))

        #expect(await task.value)
    }

    @Test func ownedGraphicsAckWaiterDoesNotCompleteForOlderAck() async {
        let waiter = OwnedGraphicsAckWaiter()
        let task = Task {
            await waiter.wait(
                for: OwnedSurfaceUpdateId(surfaceGeneration: 2, frameId: 1),
                timeoutMs: 5
            )
        }

        waiter.noteAck(OwnedGraphicsFrameAck(
            surfaceGeneration: 1,
            frameId: 999,
            compositorMs: 1,
            totalGraphicsFramesApplied: 11,
            staleDiscardCount: 0
        ))

        #expect(!(await task.value))
    }

    @Test func ownedGraphicsAckWaiterTimesOutWithoutMutatingAuthState() async {
        let waiter = OwnedGraphicsAckWaiter()

        let acked = await waiter.wait(
            for: OwnedSurfaceUpdateId(surfaceGeneration: 1, frameId: 10),
            timeoutMs: 1
        )

        #expect(!acked)
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

    @Test func scrollDeltaEngineFullResetEmitsGenerationFrameAndDecodedCappedStripeFrames() throws {
        let decodedStripeCap = 64 * 16 * 4
        var engine = ScrollDeltaEngine(maxDecodedResetStripePayloadBytes: decodedStripeCap)
        let frame = try Self.makeBGRAFrame(width: 64, height: 64) { x, y in
            Self.pixel(x: x, y: y)
        }

        let result = engine.evaluate(frame)

        #expect(result.kind == ScrollDeltaKind.reset)
        let frames = result.envelopes
        #expect(frames.count == 4)
        let firstStripe = try #require(frames.first)
        #expect(result.envelope == firstStripe)
        #expect(firstStripe.header.surfaceGeneration == 1)
        #expect(firstStripe.header.frameId == 1)
        #expect(firstStripe.header.commandCount == 2)
        #expect(firstStripe.header.payloadLength == firstStripe.payload.count)
        #expect(firstStripe.commands.count == 2)
        #expect(firstStripe.commands[0] ==
            OwnedGraphicsCommand.resetSurface(
                surfaceGeneration: 1,
                width: 64,
                height: 64,
                pixelFormat: .bgra
            )
        )

        for (stripeIndex, stripe) in frames.enumerated() {
            let y = stripeIndex * 16
            #expect(stripe.header.surfaceGeneration == 1)
            #expect(stripe.header.frameId == UInt64(stripeIndex + 1))
            #expect(stripe.header.payloadLength == stripe.payload.count)
            let tileCommandIndex = stripeIndex == 0 ? 1 : 0
            guard case let .bitmapTile(x, tileY, width, height, compression, byteRange) = stripe.commands[tileCommandIndex] else {
                Issue.record("expected reset stripe bitmapTile, got \(stripe.commands[tileCommandIndex])")
                continue
            }
            #expect(x == 0)
            #expect(tileY == y)
            #expect(width == 64)
            #expect(height == 16)
            #expect(compression == .lzfse)
            #expect(byteRange.offset == 0)
            #expect(byteRange.length == stripe.payload.count)
            let decoded = try Self.decompressLZFSE(stripe.payload, expectedCount: 64 * 16 * 4)
            #expect(decoded.count <= decodedStripeCap)
            #expect(decoded == Self.tileBytes(width: 64, height: 16) { x, row in
                Self.pixel(x: x, y: y + row)
            })
        }
    }

    @Test func scrollDeltaEngineResetStripesRespectDecodedAndWireCaps() throws {
        let decodedStripeCap = 512 * 32 * 4
        let wireStripeCap = 16_384
        var engine = ScrollDeltaEngine(
            maxDecodedResetStripePayloadBytes: decodedStripeCap,
            maxWireResetStripeBytes: wireStripeCap
        )
        let frame = try Self.makeBGRAFrame(width: 512, height: 128) { x, y in
            [
                UInt8((x * 31 + y * 17) & 0xff),
                UInt8((x * 19 + y * 47 + x / 3) & 0xff),
                UInt8((x * 53 + y * 29 + y / 5) & 0xff),
                0xff
            ]
        }

        let result = engine.evaluate(frame)

        #expect(result.kind == ScrollDeltaKind.reset)
        #expect(result.envelopes.count > 4)
        for stripe in result.envelopes {
            #expect(stripe.wireByteCount <= wireStripeCap)
            guard let tile = stripe.commands.compactMap(Self.bitmapTileCommand).first else {
                Issue.record("expected reset stripe bitmapTile")
                continue
            }
            #expect(tile.width == 512)
            #expect(tile.height * tile.width * 4 <= decodedStripeCap)
        }
    }

    @Test func scrollDeltaEngineRejectsWholeSurfaceVerticalCopyRect() throws {
        var engine = ScrollDeltaEngine()
        let previous = try Self.makeBGRAFrame(width: 64, height: 64) { x, y in
            Self.pixel(x: x, y: y)
        }
        let current = try Self.makeBGRAFrame(width: 64, height: 64) { x, y in
            y < 48 ? Self.pixel(x: x, y: y + 16) : Self.exposedPixel(x: x, y: y)
        }

        #expect(engine.evaluate(previous).kind == .reset)
        engine.commitPendingSurface()
        let result = engine.evaluate(current, scrollRegion: Self.fullSurfaceRegion(width: 64, height: 64))

        #expect(result.kind == ScrollDeltaKind.accepted)
        let diagnostics = try #require(result.diagnostics)
        #expect(diagnostics.acceptedDx == 0)
        #expect(diagnostics.acceptedDy == -16)
        #expect(diagnostics.confidence >= 0.92)
        #expect(diagnostics.sampledPixelCount > 0)
        #expect(diagnostics.payloadBuildMs != nil)
        #expect(result.envelope == nil)
        #expect(result.envelopes.isEmpty)
        #expect(!diagnostics.viewportStable)
        #expect(diagnostics.viewportSource == nil)
        #expect(!diagnostics.fullSurfaceCopyRect)
        #expect(!diagnostics.wholeWindowCopyRect)
    }

    @Test func scrollDeltaEngineDoesNotEmitCopyRectWithoutStableRegion() throws {
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
        #expect(result.envelope == nil)
        #expect(result.envelopes.isEmpty)
        let diagnostics = try #require(result.diagnostics)
        #expect(diagnostics.acceptedDy == -16)
        #expect(!diagnostics.regionStable)
        #expect(diagnostics.regionSource == nil)
        #expect(!diagnostics.fullSurfaceCopyRect)
    }

    @Test func scrollDeltaEngineEmitsViewportScopedVerticalCopyRectAndExposedStripAfterViewportLock() throws {
        var engine = ScrollDeltaEngine(viewportConfig: ScrollViewportConfig(
            minWidth: 20,
            minHeight: 20,
            confidenceThreshold: 0.88,
            minInsetPx: 4,
            overlapThreshold: 0.80
        ))
        let outerRegion = ScrollRegion(
            x: 0,
            y: 0,
            width: 100,
            height: 80,
            source: .cursorFallback,
            stability: ScrollRegionStability(stableFrameCount: 2, overlapRatioWithPrevious: 1)
        )
        let viewport = (x: 4, y: 4, width: 96, height: 76)
        let viewportMaxX = viewport.x + viewport.width
        let viewportMaxY = viewport.y + viewport.height
        let scrollDy = 2
        func movingPixel(x: Int, y: Int) -> [UInt8] {
            let value = UInt8((y % 4) * 60 + (x % 3) * 5)
            return [value, value, value, 0xff]
        }
        let previous = try Self.makeBGRAFrame(width: 100, height: 80) { x, y in
            if x >= viewport.x, x < viewportMaxX, y >= viewport.y, y < viewportMaxY {
                return movingPixel(x: x, y: y)
            }
            return Self.pixel(x: x, y: y)
        }
        let current = try Self.makeBGRAFrame(width: 100, height: 80) { x, y in
            if x >= viewport.x, x < viewportMaxX, y >= viewport.y, y < viewportMaxY {
                return y < viewportMaxY - scrollDy
                    ? movingPixel(x: x, y: y + scrollDy)
                    : Self.exposedPixel(x: x, y: y)
            }
            return Self.pixel(x: x, y: y)
        }
        let scrollHint = ScrollActivityHint(
            axis: .vertical,
            sign: -1,
            predictedOffsetPx: -scrollDy,
            candidateOffsets: [-scrollDy],
            activeUntilUptimeNs: UInt64.max,
            eventCount: 1
        )

        #expect(engine.evaluate(previous).kind == .reset)
        engine.commitPendingSurface()
        let firstResult = engine.evaluate(
            current,
            scrollHint: scrollHint,
            scrollRegion: outerRegion,
            allowBlindScan: false
        )
        #expect(firstResult.kind == ScrollDeltaKind.accepted)
        #expect(firstResult.envelope == nil)
        let result = engine.evaluate(
            current,
            scrollHint: scrollHint,
            scrollRegion: outerRegion,
            allowBlindScan: false
        )

        #expect(result.kind == ScrollDeltaKind.accepted)
        let diagnostics = try #require(result.diagnostics)
        #expect(diagnostics.regionStable)
        #expect(diagnostics.regionSource == "cursor-fallback")
        #expect(diagnostics.regionX == 0)
        #expect(diagnostics.regionY == 0)
        #expect(diagnostics.regionWidth == 100)
        #expect(diagnostics.regionHeight == 80)
        #expect(diagnostics.viewportStable)
        #expect(diagnostics.viewportSource == "derived-pixels")
        #expect((diagnostics.viewportX ?? 0) >= viewport.x)
        #expect((diagnostics.viewportY ?? 0) >= viewport.y)
        #expect((diagnostics.viewportX ?? 0) <= viewport.x + 16)
        #expect((diagnostics.viewportY ?? 0) <= viewport.y + 16)
        #expect((diagnostics.viewportWidth ?? 0) >= viewport.width - 16)
        #expect((diagnostics.viewportHeight ?? 0) >= viewport.height - 16)
        #expect(!diagnostics.fullSurfaceCopyRect)
        #expect(!diagnostics.wholeWindowCopyRect)
        let envelope = try #require(result.envelope)
        guard case let .copyRect(srcX, srcY, dstX, dstY, width, height) = envelope.commands[0] else {
            Issue.record("expected copyRect")
            return
        }
        #expect(srcX == dstX)
        #expect(srcY == dstY + scrollDy)
        #expect(width <= outerRegion.width)
        #expect(height < outerRegion.height)
        guard case let .bitmapTile(tileX, tileY, tileWidth, tileHeight, compression, byteRange) = envelope.commands[1] else {
            Issue.record("expected bitmapTile")
            return
        }
        #expect(compression == .lzfse)
        #expect(byteRange == OwnedGraphicsByteRange(offset: 0, length: envelope.payload.count))
        #expect(tileX == dstX)
        #expect(tileY >= viewport.y)
        #expect(tileWidth == width)
        #expect(tileHeight == scrollDy)
    }

    @Test func scrollDeltaEngineValidatesRegionScrollWithoutEmittingBeforeRegionLock() throws {
        var engine = ScrollDeltaEngine()
        let region = ScrollRegion(
            x: 10,
            y: 8,
            width: 50,
            height: 40,
            source: .cursorFallback,
            stability: ScrollRegionStability(stableFrameCount: 1, overlapRatioWithPrevious: 0)
        )
        let previous = try Self.makeBGRAFrame(width: 100, height: 80) { x, y in
            Self.pixel(x: x, y: y)
        }
        let current = try Self.makeBGRAFrame(width: 100, height: 80) { x, y in
            if x >= region.x, x < region.maxX, y >= region.y, y < region.maxY {
                return y < region.maxY - 6
                    ? Self.pixel(x: x, y: y + 6)
                    : Self.exposedPixel(x: x, y: y)
            }
            return Self.pixel(x: x, y: y)
        }

        #expect(engine.evaluate(previous).kind == .reset)
        engine.commitPendingSurface()
        let result = engine.evaluate(
            current,
            scrollRegion: region,
            scrollRegionIsStable: false,
            emitGraphicsBeforeRegionLock: false
        )

        #expect(result.kind == ScrollDeltaKind.accepted)
        #expect(result.envelope == nil)
        #expect(result.envelopes.isEmpty)
        let diagnostics = try #require(result.diagnostics)
        #expect(diagnostics.acceptedDy == -6)
        #expect(!diagnostics.regionStable)
        #expect(diagnostics.regionSource == "cursor-fallback")
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
        let result = engine.evaluate(current, scrollRegion: Self.fullSurfaceRegion(width: 320, height: 256))

        #expect(result.kind == ScrollDeltaKind.accepted)
        let diagnostics = try #require(result.diagnostics)
        #expect(diagnostics.acceptedDx == 0)
        #expect(diagnostics.acceptedDy == -32)
        #expect(diagnostics.confidence >= 0.92)
        #expect(diagnostics.sampledPixelCount > 0)
        #expect(diagnostics.payloadBuildMs != nil)
        #expect(result.envelope == nil)
        #expect(result.envelopes.isEmpty)
    }

    @Test func scrollDeltaEngineAcceptsPhysicalScaleNonStrideVerticalScrollWithinBudget() throws {
        var engine = ScrollDeltaEngine()
        let width = 1_920
        let height = 1_080
        let scrollDy = 37
        let previous = try Self.makeBGRAFrame(width: width, height: height) { x, y in
            Self.scrollProbePixel(x: x, y: y)
        }
        let current = try Self.make420Frame(width: width, height: height) { x, y in
            y < height - scrollDy ? Self.scrollProbePixel(x: x, y: y + scrollDy) : Self.exposedPixel(x: x, y: y)
        }

        #expect(engine.evaluate(previous).kind == .reset)
        engine.commitPendingSurface()
        let result = engine.evaluate(
            current,
            scrollRegion: Self.fullSurfaceRegion(width: width, height: height),
            detectionBudgetMs: 4
        )

        #expect(result.kind == ScrollDeltaKind.accepted)
        let diagnostics = try #require(result.diagnostics)
        #expect(diagnostics.acceptedDx == 0)
        #expect(abs((diagnostics.acceptedDy ?? 0) + scrollDy) <= 2)
        #expect(diagnostics.confidence >= 0.88)
        #expect(diagnostics.secondBestConfidence <= diagnostics.confidence)
        #expect(diagnostics.confidence - diagnostics.secondBestConfidence >= 0.06)
        #expect(diagnostics.candidateCount > 100)
        #expect(diagnostics.hintSource == "blind")
        #expect(diagnostics.acceptedBy == "blind")
        #expect(diagnostics.probeScale > 1)
        #expect(diagnostics.timeoutReason == nil)
        #expect(diagnostics.payloadBuildMs != nil)
        #expect(result.envelope == nil)
        #expect(result.envelopes.isEmpty)
    }

    @Test func scrollDeltaEngineHintGuidedProbeAcceptsBoundedVerticalOffsets() throws {
        for scrollDy in [1, 15, 80] {
            var engine = ScrollDeltaEngine()
            let width = 320
            let height = 256
            let previous = try Self.makeBGRAFrame(width: width, height: height) { x, y in
                Self.scrollProbePixel(x: x, y: y)
            }
            let current = try Self.makeBGRAFrame(width: width, height: height) { x, y in
                y < height - scrollDy ? Self.scrollProbePixel(x: x, y: y + scrollDy) : Self.exposedPixel(x: x, y: y)
            }
            let hint = Self.scrollHint(axis: .vertical, predictedOffset: -scrollDy)

            #expect(engine.evaluate(previous).kind == .reset)
            engine.commitPendingSurface()
            let result = engine.evaluate(
                current,
                scrollHint: hint,
                scrollRegion: Self.fullSurfaceRegion(width: width, height: height)
            )

            #expect(result.kind == ScrollDeltaKind.accepted)
            let diagnostics = try #require(result.diagnostics)
            #expect(diagnostics.acceptedDy == -scrollDy)
            #expect(diagnostics.acceptedDx == 0)
            #expect(diagnostics.acceptedBy == "hint")
            #expect(diagnostics.hintActive)
            #expect(diagnostics.hintAxis == "vertical")
            #expect(diagnostics.hintPredictedOffset == -scrollDy)
            #expect(diagnostics.candidateCount <= 24)
            #expect(diagnostics.hintCandidates.count == diagnostics.candidateCount)
            #expect(result.envelope == nil)
            #expect(result.envelopes.isEmpty)
        }
    }

    @Test func scrollDeltaEngineHintGuidedProbeUsesLatestDeltaAcrossSequentialScrollFrames() throws {
        var tracker = ScrollActivityTracker()
        var engine = ScrollDeltaEngine()
        let width = 160
        let height = 128
        let firstScrollDy = 10
        let secondScrollDy = 15
        let totalScrollDy = firstScrollDy + secondScrollDy
        let previous = try Self.makeBGRAFrame(width: width, height: height) { x, y in
            Self.scrollProbePixel(x: x, y: y)
        }
        let first = try Self.makeBGRAFrame(width: width, height: height) { x, y in
            y < height - firstScrollDy ? Self.scrollProbePixel(x: x, y: y + firstScrollDy) : Self.exposedPixel(x: x, y: y)
        }
        let second = try Self.makeBGRAFrame(width: width, height: height) { x, y in
            y < height - totalScrollDy ? Self.scrollProbePixel(x: x, y: y + totalScrollDy) : Self.exposedPixel(x: x, y: y)
        }

        #expect(engine.evaluate(previous).kind == .reset)
        engine.commitPendingSurface()

        let firstNow = DispatchTime.now().uptimeNanoseconds
        tracker.record(.scroll(dx: 0, dy: Float(-firstScrollDy), phase: .changed), nowUptimeNs: firstNow)
        let firstHint = try #require(tracker.hint(nowUptimeNs: firstNow))
        let firstResult = engine.evaluate(first, scrollHint: firstHint)
        #expect(firstResult.kind == ScrollDeltaKind.accepted)
        let firstDiagnostics = try #require(firstResult.diagnostics)
        #expect(firstDiagnostics.acceptedDy == -firstScrollDy)
        engine.commitPendingSurface()

        let secondNow = DispatchTime.now().uptimeNanoseconds
        tracker.record(.scroll(dx: 0, dy: Float(-secondScrollDy), phase: .changed), nowUptimeNs: secondNow)
        let secondHint = try #require(tracker.hint(nowUptimeNs: secondNow))
        #expect(secondHint.predictedOffsetPx == -secondScrollDy)
        #expect(secondHint.candidateOffsets.contains(-totalScrollDy))
        let secondResult = engine.evaluate(second, scrollHint: secondHint)

        #expect(secondResult.kind == ScrollDeltaKind.accepted)
        let secondDiagnostics = try #require(secondResult.diagnostics)
        #expect(secondDiagnostics.acceptedDy == -secondScrollDy)
        #expect(secondDiagnostics.acceptedBy == "hint")
        #expect(secondDiagnostics.candidateCount <= 24)
    }

    @Test func scrollDeltaEngineHintTieBreakUsesPredictedOffsetForAdjacentCandidates() throws {
        var engine = ScrollDeltaEngine()
        let width = 96
        let height = 96
        let previous = try Self.makeBGRAFrame(width: width, height: height) { x, _ in
            Self.xOnlyPixel(x: x)
        }
        let current = try Self.makeBGRAFrame(width: width, height: height) { x, y in
            y < height - 15 ? Self.xOnlyPixel(x: x) : Self.exposedPixel(x: x, y: y)
        }
        let hint = ScrollActivityHint(
            axis: .vertical,
            sign: -1,
            predictedOffsetPx: -15,
            candidateOffsets: [-14, -15],
            activeUntilUptimeNs: UInt64.max,
            eventCount: 1
        )

        #expect(engine.evaluate(previous).kind == .reset)
        engine.commitPendingSurface()
        let result = engine.evaluate(current, scrollHint: hint)

        #expect(result.kind == ScrollDeltaKind.accepted)
        let diagnostics = try #require(result.diagnostics)
        #expect(diagnostics.acceptedDy == -15)
        #expect(diagnostics.acceptedBy == "hint")
        #expect(diagnostics.tieBreak == "predicted-offset")
        #expect(diagnostics.candidateCount == 2)
    }

    @Test func scrollDeltaEngineHintRejectsZeroMotionAmbiguity() throws {
        var engine = ScrollDeltaEngine()
        let width = 96
        let height = 96
        let previous = try Self.makeBGRAFrame(width: width, height: height) { x, _ in
            Self.xOnlyPixel(x: x)
        }
        let current = try Self.makeBGRAFrame(width: width, height: height) { x, _ in
            Self.xOnlyPixel(x: x)
        }
        let hint = ScrollActivityHint(
            axis: .vertical,
            sign: -1,
            predictedOffsetPx: -15,
            candidateOffsets: [-14, -15],
            activeUntilUptimeNs: UInt64.max,
            eventCount: 1
        )

        #expect(engine.evaluate(previous).kind == .reset)
        engine.commitPendingSurface()
        let result = engine.evaluate(current, scrollHint: hint)

        if case .rejected = result.kind {
            let diagnostics = try #require(result.diagnostics)
            #expect(diagnostics.timeoutReason == "hint-zero-motion-ambiguous")
            #expect(diagnostics.hintActive)
            #expect(diagnostics.acceptedBy == nil)
            #expect(diagnostics.candidateCount == 2)
        } else {
            Issue.record("expected rejected zero-motion ambiguity, got \(result.kind)")
        }
    }

    @Test func scrollDeltaEngineExpiredHintPreservesRejectedMotionFallback() throws {
        var engine = ScrollDeltaEngine()
        let previous = try Self.makeBGRAFrame(width: 64, height: 64) { x, y in
            Self.pixel(x: x, y: y)
        }
        let current = try Self.makeBGRAFrame(width: 64, height: 64) { x, y in
            let hash = UInt32(truncatingIfNeeded: x) &* 73_856_093 ^
                UInt32(truncatingIfNeeded: y) &* 19_349_663 ^
                0x9e37_79b9
            return [
                UInt8(truncatingIfNeeded: hash),
                UInt8(truncatingIfNeeded: hash >> 8),
                UInt8(truncatingIfNeeded: hash >> 16),
                0xff
            ]
        }
        let expiredHint = ScrollActivityHint(
            axis: .vertical,
            sign: -1,
            predictedOffsetPx: -15,
            candidateOffsets: [-15],
            activeUntilUptimeNs: 0,
            eventCount: 1
        )

        #expect(engine.evaluate(previous).kind == .reset)
        engine.commitPendingSurface()
        let result = engine.evaluate(current, scrollHint: expiredHint)

        if case .rejected = result.kind {
            let diagnostics = try #require(result.diagnostics)
            #expect(!diagnostics.hintActive)
            #expect(diagnostics.hintSource == "blind")
            #expect(diagnostics.acceptedBy == nil)
            #expect(diagnostics.candidateCount > 24)
            #expect(result.envelope == nil)
        } else {
            Issue.record("expected rejected motion, got \(result.kind), diagnostics: \(String(describing: result.diagnostics))")
        }
    }

    @Test func scrollDeltaEngineRejectsWholeSurfaceHorizontalCopyRect() throws {
        var engine = ScrollDeltaEngine()
        let previous = try Self.makeBGRAFrame(width: 64, height: 64) { x, y in
            Self.pixel(x: x, y: y)
        }
        let current = try Self.makeBGRAFrame(width: 64, height: 64) { x, y in
            x < 48 ? Self.pixel(x: x + 16, y: y) : Self.exposedPixel(x: x, y: y)
        }

        #expect(engine.evaluate(previous).kind == .reset)
        engine.commitPendingSurface()
        let result = engine.evaluate(current, scrollRegion: Self.fullSurfaceRegion(width: 64, height: 64))

        #expect(result.kind == ScrollDeltaKind.accepted)
        let diagnostics = try #require(result.diagnostics)
        #expect(diagnostics.acceptedDx == -16)
        #expect(diagnostics.acceptedDy == 0)
        #expect(diagnostics.confidence >= 0.92)
        #expect(diagnostics.sampledPixelCount > 0)
        #expect(diagnostics.payloadBuildMs != nil)
        #expect(result.envelope == nil)
        #expect(result.envelopes.isEmpty)
    }

    @Test func scrollDeltaEngineRejectsUnexplainedMotion() throws {
        var engine = ScrollDeltaEngine()
        let previous = try Self.makeBGRAFrame(width: 64, height: 64) { x, y in
            Self.pixel(x: x, y: y)
        }
        let current = try Self.makeBGRAFrame(width: 64, height: 64) { x, y in
            let hash = UInt32(truncatingIfNeeded: x) &* 73_856_093 ^
                UInt32(truncatingIfNeeded: y) &* 19_349_663 ^
                0x9e37_79b9
            return [
                UInt8(truncatingIfNeeded: hash),
                UInt8(truncatingIfNeeded: hash >> 8),
                UInt8(truncatingIfNeeded: hash >> 16),
                0xff
            ]
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
            Issue.record("expected rejected motion, got \(result.kind), diagnostics: \(String(describing: result.diagnostics))")
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

    @Test func scrollDeltaProbeEnforcesPositiveBudgetDuringCandidateScan() {
        let surface = ScrollDeltaSurface(
            width: 16,
            height: 16,
            bytesPerRow: 64,
            pixels: Self.tileBytes(width: 16, height: 16) { x, y in
                Self.scrollProbePixel(x: x, y: y)
            }
        )
        let current = ScrollDeltaSurface(
            width: 16,
            height: 16,
            bytesPerRow: 64,
            pixels: Self.tileBytes(width: 16, height: 16) { x, y in
                y < 14 ? Self.scrollProbePixel(x: x, y: y + 2) : Self.exposedPixel(x: x, y: y)
            }
        )
        let sampler = ScrollDeltaProbeSampler.surface(ScrollDeltaSurfaceSampler(surface: current))
        var elapsed = 0.0
        let probe = ScrollDeltaProbe(
            previous: surface,
            sampler: sampler,
            maxScrollOffset: 240,
            confidenceThreshold: 1.1,
            confidenceMargin: 0.06,
            startedAt: 1,
            detectionBudgetMs: 0.1,
            elapsedMs: { _ in
                elapsed += 1.0
                return elapsed
            },
            region: nil
        )

        let outcome = probe.bestOffset()

        #expect(outcome.timedOut)
        #expect(outcome.offset == nil)
        #expect(outcome.timeoutReason == "probe-budget-exceeded")
        #expect(outcome.timeoutPhase == "candidate-scan")
        #expect(outcome.candidateCount > 0)
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

    private static func scrollProbePixel(x: Int, y: Int) -> [UInt8] {
        let value = UInt8((x * 37 + y * 101 + (x / 23) * 19 + (y / 17) * 53) & 0xff)
        return [value, value, value, 0xff]
    }

    private static func xOnlyPixel(x: Int) -> [UInt8] {
        let value = UInt8((x * 37 + (x / 7) * 23) & 0xff)
        return [value, value, value, 0xff]
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

    private static func scrollHint(axis: ScrollActivityAxis, predictedOffset: Int) -> ScrollActivityHint {
        let sign = predictedOffset < 0 ? -1 : 1
        let candidates = [
            predictedOffset,
            predictedOffset - sign,
            predictedOffset + sign,
            predictedOffset - 2 * sign,
            predictedOffset + 2 * sign,
            predictedOffset - 4 * sign,
            predictedOffset + 4 * sign
        ].filter { $0 != 0 }
        return ScrollActivityHint(
            axis: axis,
            sign: sign,
            predictedOffsetPx: predictedOffset,
            candidateOffsets: candidates,
            activeUntilUptimeNs: UInt64.max,
            eventCount: 1
        )
    }

    private static func fullSurfaceRegion(width: Int, height: Int) -> ScrollRegion {
        ScrollRegion(
            x: 0,
            y: 0,
            width: width,
            height: height,
            source: .cursorFallback,
            stability: ScrollRegionStability(stableFrameCount: 2, overlapRatioWithPrevious: 1)
        )
    }

    private static func expectSingleCopyRectAndTile(_ envelope: OwnedGraphicsFrameEnvelope) {
        var copyRectCount = 0
        var bitmapTileCount = 0
        for command in envelope.commands {
            switch command {
            case .copyRect:
                copyRectCount += 1
            case let .bitmapTile(_, _, _, _, compression, byteRange):
                bitmapTileCount += 1
                #expect(compression == .lzfse)
                #expect(byteRange.offset == 0)
                #expect(byteRange.length == envelope.payload.count)
            case .resetSurface, .codecTile:
                break
            }
        }
        #expect(envelope.commands.count == 2)
        #expect(copyRectCount == 1)
        #expect(bitmapTileCount == 1)
    }

    private static func bitmapTileCommand(_ command: OwnedGraphicsCommand) -> (
        x: Int,
        y: Int,
        width: Int,
        height: Int,
        compression: OwnedGraphicsTileCompression,
        byteRange: OwnedGraphicsByteRange
    )? {
        guard case let .bitmapTile(x, y, width, height, compression, byteRange) = command else {
            return nil
        }
        return (x, y, width, height, compression, byteRange)
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
