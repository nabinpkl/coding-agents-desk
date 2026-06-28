import CoreVideo
import Foundation

enum MediaStack {
    static func makeFactory(
        ownedDatagramAuthorizer: @escaping OwnedMediaDatagramAuthorizer = { _ in .rejected(.unauthorized) },
        ownedGraphicsAuthorizer: @escaping OwnedGraphicsChannelAuthorizer = { _ in .rejected(.unauthorized) },
        scrollActivityHintProvider: @escaping @Sendable () -> ScrollActivityHint? = { nil }
    ) -> MediaTransportFactory {
        OwnedMediaTransportFactory(
            configuration: .fromConfig(),
            authorizer: ownedDatagramAuthorizer,
            graphicsAuthorizer: ownedGraphicsAuthorizer,
            scrollActivityHintProvider: scrollActivityHintProvider
        )
    }

    static func makeFrameSource() -> VideoFrameSource {
        if ProcessInfo.processInfo.environment["AGENTDESK_USE_TEST_PATTERN"] == "1" {
            return TestPatternFrameSource()
        }
        return ScreenCaptureKitFrameSource(
            scaleDownBy: Config.ownedMediaCaptureScaleDown,
            pixelFormat: Config.ownedMediaChroma.capturePixelFormat
        )
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
