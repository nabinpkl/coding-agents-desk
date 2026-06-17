import Foundation

// ADR-0004 composition root. The only file that names concrete impls.
// Swapping the WebRTC library, codec, or capturer is editing this file and
// no other. R8.6.1 ships stub factories that throw; real impls land in
// R8.6.3+.

enum MediaStack {
    // Dual-plane media: full-resolution detail for readable rest text,
    // downscaled H.264 motion for scroll.
    static func makeFactory() -> MediaTransportFactory {
        LibWebRTCTransportFactory(planeConfigurations: MediaPlaneConfiguration.defaultPlanes)
    }

    // R8.6.5 swaps the default from TestPatternFrameSource to
    // ScreenCaptureKitFrameSource. TestPattern is still reachable via
    // direct instantiation for diagnostics, and the env-var override
    // below lets a developer flip back without recompiling.
    static func makeFrameSources() -> VideoPlaneSources {
        if ProcessInfo.processInfo.environment["AGENTDESK_USE_TEST_PATTERN"] == "1" {
            return VideoPlaneSources([
                .detail: TestPatternFrameSource(),
                .motion: TestPatternFrameSource()
            ])
        }
        let planes = MediaPlaneConfiguration.defaultPlanes
        return VideoPlaneSources([
            .detail: ScreenCaptureKitFrameSource(scaleDownBy: planes[.detail]?.captureScaleDownBy ?? 1.0),
            .motion: ScreenCaptureKitFrameSource(scaleDownBy: planes[.motion]?.captureScaleDownBy ?? SenderTuning.h264HardwareEncoderScaleDownBy)
        ])
    }
}
