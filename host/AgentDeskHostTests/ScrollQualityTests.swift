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
}
