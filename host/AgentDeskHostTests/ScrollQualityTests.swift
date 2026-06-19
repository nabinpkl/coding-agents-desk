import Foundation
import Testing

@testable import AgentDeskHost

// Scroll-quality wire shape and profile derivation. The transport's live
// sender mutation can't be unit-tested without WebRTC, so the testable
// surface is the pure profile derivation on SenderTuning and the
// InteractionHint frame the client sends.
struct ScrollQualityTests {
    @Test func dualPlaneDefaultsUseReadableDetailAndLowLatencyMotion() {
        let planes = MediaPlaneConfiguration.defaultPlanes
        let detail = planes[.detail]
        let motion = planes[.motion]

        #expect(detail?.codecs == .vp9Only)
        #expect(detail?.captureScaleDownBy == 1.0)
        #expect(detail?.tuning.crispProfile.scaleResolutionDownBy == 1.0)
        #expect(motion?.codecs == .h264Only)
        #expect(motion?.captureScaleDownBy == SenderTuning.h264HardwareEncoderScaleDownBy)
        #expect(motion?.tuning.scrollProfile.scaleResolutionDownBy == 1.0)
    }

    @Test func motionCaptureDownscaleCanBeTunedFromEnvironment() {
        let planes = MediaPlaneConfiguration.defaultPlanes(environment: [
            "AGENTDESK_TUNING_MOTION_CAPTURE_SCALE_DOWN": "2.5"
        ])
        let detail = planes[.detail]
        let motion = planes[.motion]

        #expect(detail?.captureScaleDownBy == 1.0)
        #expect(motion?.captureScaleDownBy == 2.5)
        #expect(motion?.tuning.scrollProfile.scaleResolutionDownBy == 1.0)
    }

    @Test func invalidMotionCaptureDownscaleFallsBackToHardwareGuardrail() {
        let planes = MediaPlaneConfiguration.defaultPlanes(environment: [
            "AGENTDESK_TUNING_MOTION_CAPTURE_SCALE_DOWN": "0"
        ])

        #expect(planes[.motion]?.captureScaleDownBy == SenderTuning.h264HardwareEncoderScaleDownBy)
    }

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

    @Test func ownedMediaDatagramHeaderLengthMatchesWireShape() throws {
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
        header.append(1)
        header.append(3)
        appendUInt32BE(0, to: &header)
        appendUInt64BE(42, to: &header)
        appendUInt16BE(0, to: &header)
        appendUInt16BE(1, to: &header)
        appendUInt64BE(123_456, to: &header)
        appendUInt16BE(UInt16(payloadLength), to: &header)

        #expect(header.count == 32)
        #expect(header[30] == UInt8((payloadLength >> 8) & 0xff))
        #expect(header[31] == UInt8(payloadLength & 0xff))
        #expect(32 + 32 + payloadLength == 1_114)
    }

    @Test func ownedMediaQuicDatagramDefaultFitsAdmdPacketSize() {
        #expect(Config.ownedMediaQuicMaxDatagramBytes >= 1_114)
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

    @Test func motionCodecCanBeTunedToDownscaledVp9() {
        let planes = MediaPlaneConfiguration.defaultPlanes(environment: [
            "AGENTDESK_TUNING_MOTION_CODEC": "vp9",
            "AGENTDESK_TUNING_MOTION_CAPTURE_SCALE_DOWN": "2.5"
        ])
        let motion = planes[.motion]

        #expect(motion?.codecs == .vp9Only)
        #expect(motion?.captureScaleDownBy == 2.5)
        #expect(motion?.tuning.scrollProfile.scaleResolutionDownBy == 1.0)
        #expect(motion?.tuning.scrollProfile.temporalLayers == SenderTuning.default.temporalLayers)
    }

    @Test func scrollProfileDropsResolutionAndBitrateAndPrioritizesFramerate() {
        let tuning = SenderTuning.default
        let scroll = tuning.scrollProfile
        #expect(scroll.scaleResolutionDownBy == tuning.scrollScaleDownBy)
        #expect(scroll.scaleResolutionDownBy > 1.0)
        #expect(scroll.maxFramerate == tuning.scrollMaxFramerate)
        #expect(scroll.maxBitrateKbps == tuning.scrollMaxBitrateKbps)
        // Smaller frames are the latency lever: the scroll cap must be well
        // below the crisp ceiling.
        #expect(scroll.maxBitrateKbps < tuning.maxBitrateKbps)
        #expect(scroll.degradation == .maintainFramerate)
    }

    @Test func crispProfileRestoresFullResolutionAndBaseValues() {
        let tuning = SenderTuning.default
        let crisp = tuning.crispProfile
        #expect(crisp.scaleResolutionDownBy == 1.0)
        #expect(crisp.maxFramerate == tuning.maxFramerate)
        #expect(crisp.maxBitrateKbps == tuning.maxBitrateKbps)
        #expect(crisp.degradation == tuning.degradationPreference)
    }

    @Test func detailSuppressedProfileBacksOffInvisibleDetailPlaneDuringScroll() {
        let tuning = SenderTuning.default
        let suppressed = tuning.detailScrollSuppressedProfile

        #expect(suppressed.active)
        #expect(suppressed.scaleResolutionDownBy == tuning.detailScrollScaleDownBy)
        #expect(suppressed.scaleResolutionDownBy > tuning.crispProfile.scaleResolutionDownBy)
        #expect(suppressed.maxFramerate == 1)
        #expect(suppressed.maxBitrateKbps < tuning.crispProfile.maxBitrateKbps)
        #expect(suppressed.minBitrateKbps < tuning.crispProfile.minBitrateKbps)
        #expect(suppressed.degradation == .maintainFramerate)
        #expect(suppressed.temporalLayers == tuning.temporalLayers)
    }

    @Test func detailSuppressedProfileCanDisableDetailSenderDuringScroll() {
        let tuning = SenderTuning.fromEnvironment([
            "AGENTDESK_TUNING_DETAIL_SCROLL_ACTIVE": "0"
        ])
        let suppressed = tuning.detailScrollSuppressedProfile

        #expect(!suppressed.active)
        #expect(tuning.crispProfile.active)
        #expect(tuning.scrollProfile.active)
    }

    @Test func temporalLayersAreConstantAcrossProfilesSoSwitchesAvoidReconfig() {
        let tuning = SenderTuning.default
        // Layers > 1 enables temporal SVC; the scroll bitrate squeeze then
        // sheds layers instead of reconfiguring. The count must match across
        // profiles or the switch would force an encoder reinit + keyframe.
        #expect(tuning.temporalLayers > 1)
        #expect(tuning.crispProfile.temporalLayers == tuning.scrollProfile.temporalLayers)
    }

    @Test func h264OnlyKeepsCrispSenderScaleForPostScrollRestore() {
        let tuning = SenderTuning.default.applyingCodecGuardrails(for: .h264Only)

        #expect(tuning.crispProfile.scaleResolutionDownBy == SenderTuning.default.crispProfile.scaleResolutionDownBy)
        #expect(tuning.scrollProfile.scaleResolutionDownBy >= SenderTuning.h264HardwareEncoderScaleDownBy)
        #expect(tuning.scrollProfile.scaleResolutionDownBy > tuning.crispProfile.scaleResolutionDownBy)
        #expect(tuning.crispProfile.temporalLayers == 1)
        #expect(tuning.scrollProfile.temporalLayers == 1)
        #expect(tuning.crispProfile.degradation == .maintainFramerate)
    }

    @Test func vp9FirstKeepsVp9SenderProfile() {
        let tuning = SenderTuning.default.applyingCodecGuardrails(for: .vp9First)

        #expect(tuning == .default)
    }

    @Test func h264CaptureSizeIsDownscaledBeforeWebRTC() {
        let size = CaptureSizing.pixelSize(
            displayWidthPoints: 1800,
            displayHeightPoints: 1169,
            backingScale: 2.0,
            scaleDownBy: SenderTuning.h264HardwareEncoderScaleDownBy
        )

        #expect(size.width == 1028)
        #expect(size.height == 668)
        #expect(size.width.isMultiple(of: 2))
        #expect(size.height.isMultiple(of: 2))
    }

    @Test func interactionHintRoundTripsWithCompactKeys() throws {
        let hint = InteractionHint(kind: "scroll", active: true)
        let data = try JSONEncoder().encode(hint)
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        #expect(object?["t"] as? String == "interaction-hint")
        #expect(object?["k"] as? String == "scroll")
        #expect(object?["a"] as? Bool == true)
        let decoded = try JSONDecoder().decode(InteractionHint.self, from: data)
        #expect(decoded == hint)
    }

    @Test func h264OnlyCodecPolicyDropsVp8AndVp9Fallbacks() {
        let allowed = CodecPreferencePolicy.orderedAllowedIndexes(
            capabilities: [
                CodecCapabilityDescriptor(index: 0, name: "H264", preferredPayloadType: "96", aptPayloadType: nil),
                CodecCapabilityDescriptor(index: 1, name: "rtx", preferredPayloadType: "97", aptPayloadType: "96"),
                CodecCapabilityDescriptor(index: 2, name: "VP9", preferredPayloadType: "98", aptPayloadType: nil),
                CodecCapabilityDescriptor(index: 3, name: "rtx", preferredPayloadType: "99", aptPayloadType: "98"),
                CodecCapabilityDescriptor(index: 4, name: "VP8", preferredPayloadType: "100", aptPayloadType: nil),
                CodecCapabilityDescriptor(index: 5, name: "red", preferredPayloadType: "101", aptPayloadType: nil)
            ],
            preferences: .h264Only
        )

        #expect(allowed == [0, 1, 5])
        #expect(MediaCodecPreferences.h264Only.allows(statsMimeType: "video/H264"))
        #expect(!MediaCodecPreferences.h264Only.allows(statsMimeType: "video/VP8"))
    }

    @Test func vp9FirstCodecPolicyKeepsOnlyConfiguredPrimaryCodecs() {
        let allowed = CodecPreferencePolicy.orderedAllowedIndexes(
            capabilities: [
                CodecCapabilityDescriptor(index: 0, name: "H264", preferredPayloadType: "96", aptPayloadType: nil),
                CodecCapabilityDescriptor(index: 1, name: "rtx", preferredPayloadType: "97", aptPayloadType: "96"),
                CodecCapabilityDescriptor(index: 2, name: "VP8", preferredPayloadType: "100", aptPayloadType: nil),
                CodecCapabilityDescriptor(index: 3, name: "VP9", preferredPayloadType: "98", aptPayloadType: nil),
                CodecCapabilityDescriptor(index: 4, name: "rtx", preferredPayloadType: "99", aptPayloadType: "98")
            ],
            preferences: .vp9First
        )

        #expect(allowed == [3, 4, 0, 1])
        #expect(MediaCodecPreferences.vp9First.allows(statsMimeType: "video/VP9"))
        #expect(MediaCodecPreferences.vp9First.allows(statsMimeType: "video/H264"))
        #expect(!MediaCodecPreferences.vp9First.allows(statsMimeType: "video/VP8"))
    }

    @Test func outboundPlaneResolverUsesTrackIdentifierBeforeMid() {
        let plane = OutboundRtpPlaneResolver.planeName(
            trackIdentifier: "motion-video",
            mid: "0",
            midPlanes: ["0": .detail]
        )

        #expect(plane == "motion")
    }

    @Test func outboundPlaneResolverFallsBackToTransceiverMid() {
        let plane = OutboundRtpPlaneResolver.planeName(
            trackIdentifier: nil,
            mid: "1",
            midPlanes: ["0": .detail, "1": .motion]
        )

        #expect(plane == "motion")
    }
}
