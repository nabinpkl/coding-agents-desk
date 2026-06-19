import CoreVideo
import Foundation

// ADR-0004 composition root. The only file that names concrete impls.
// Swapping the WebRTC library, codec, or capturer is editing this file and
// no other. R8.6.1 ships stub factories that throw; real impls land in
// R8.6.3+.

enum MediaStack {
    static func makeFactory(
        ownedDatagramAuthorizer: @escaping OwnedMediaDatagramAuthorizer = { _ in .rejected(.unauthorized) }
    ) -> MediaTransportFactory {
        switch Config.mediaStackMode {
        case .webrtc:
            return LibWebRTCTransportFactory(planeConfigurations: MediaPlaneConfiguration.defaultPlanes)
        case .owned:
            return OwnedMediaTransportFactory(
                codec: Config.ownedMediaCodec.wireCodec,
                configuration: .fromConfig(),
                authorizer: ownedDatagramAuthorizer
            )
        }
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
        let ownedPixelFormat = Config.ownedMediaChroma.capturePixelFormat
        let ownedDetailScaleDown = Config.mediaStackMode == .owned
            ? Config.ownedMediaCaptureScaleDown
            : planes[.detail]?.captureScaleDownBy ?? 1.0
        return VideoPlaneSources([
            .detail: ScreenCaptureKitFrameSource(
                scaleDownBy: ownedDetailScaleDown,
                pixelFormat: Config.mediaStackMode == .owned ? ownedPixelFormat : kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
            ),
            .motion: ScreenCaptureKitFrameSource(
                scaleDownBy: planes[.motion]?.captureScaleDownBy ?? SenderTuning.h264HardwareEncoderScaleDownBy,
                pixelFormat: Config.mediaStackMode == .owned ? ownedPixelFormat : kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
            )
        ])
    }
}

private extension Config.OwnedMediaChroma {
    var capturePixelFormat: OSType {
        switch self {
        case .yuv420:
            return kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
        case .yuv444:
            return kCVPixelFormatType_444YpCbCr8BiPlanarFullRange
        case .bgra:
            return kCVPixelFormatType_32BGRA
        }
    }
}
