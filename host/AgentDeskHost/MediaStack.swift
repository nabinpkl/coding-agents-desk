import Foundation

// ADR-0004 composition root. The only file that names concrete impls.
// Swapping the WebRTC library, codec, or capturer is editing this file and
// no other. R8.6.1 ships stub factories that throw; real impls land in
// R8.6.3+.

enum MediaStack {
    // Codec selection is one-line swap here OR via env var so you can
    // A/B without rebuild. Recognized values for AGENTDESK_CODEC:
    //   h264 | vp9 (default) | av1
    // Sender tuning (degradationPreference, bitrate ceilings, BWE seed,
    // screencast flag) is read from AGENTDESK_TUNING_* env vars; see
    // SenderTuning.fromEnvironment() for the field list.
    static func makeFactory() -> MediaTransportFactory {
        let codecs: MediaCodecPreferences
        switch ProcessInfo.processInfo.environment["AGENTDESK_CODEC"]?.lowercased() {
        case "h264": codecs = .h264Only
        case "av1":  codecs = .av1First
        default:     codecs = .vp9First
        }
        let tuning = SenderTuning.fromEnvironment()
        return LibWebRTCTransportFactory(codecs: codecs, tuning: tuning)
    }

    // R8.6.5 swaps the default from TestPatternFrameSource to
    // ScreenCaptureKitFrameSource. TestPattern is still reachable via
    // direct instantiation for diagnostics, and the env-var override
    // below lets a developer flip back without recompiling.
    static func makeFrameSource() -> VideoFrameSource {
        if ProcessInfo.processInfo.environment["AGENTDESK_USE_TEST_PATTERN"] == "1" {
            return TestPatternFrameSource()
        }
        return ScreenCaptureKitFrameSource()
    }
}
