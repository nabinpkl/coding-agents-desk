import CoreVideo
import Foundation

// ADR-0004 capture seam. ScreenCaptureKitFrameSource is the v0 impl
// (lands in R8.6.5). TestPatternFrameSource is the diagnostic impl
// (lands in R8.6.3). Both produce CVPixelBuffer-bearing frames at their
// native cadence; the WebRTC layer pulls them through a
// ScreenCaptureKitVideoCapturer that wraps RTCCVPixelBuffer.

// Push-callback model. The previous AsyncStream design buffered up to 2
// frames in our own stream plus required a pump Task to await them, which
// added ~70 ms of latency before libwebrtc ever saw a captured frame. The
// onFrame closure is invoked directly from whatever thread the underlying
// capture API delivers on (SCStream's sample queue for the production
// impl), so there is no buffer of our own between capture and encode.
protocol VideoFrameSource: AnyObject, Sendable {
    func start(onFrame: @escaping @Sendable (CapturedVideoFrame) -> Void) async throws
    func stop()
}

// CVPixelBuffer is a CoreFoundation reference type; we never mutate it
// after creation, so crossing task boundaries is safe in practice. Swift's
// strict-concurrency checker doesn't know that, hence @unchecked.
struct CapturedVideoFrame: @unchecked Sendable {
    let pixelBuffer: CVPixelBuffer
    let presentationTimeNs: Int64
    let capturedAtUptimeNs: UInt64
    let rotation: VideoRotation
}

struct CapturePixelSize: Equatable {
    let width: Int
    let height: Int
}

enum CaptureSizing {
    static func pixelSize(
        displayWidthPoints: Int,
        displayHeightPoints: Int,
        backingScale: Double,
        scaleDownBy: Double
    ) -> CapturePixelSize {
        let effectiveScale = max(backingScale / max(scaleDownBy, 1.0), 0.001)
        return CapturePixelSize(
            width: evenDimension(from: Double(displayWidthPoints) * effectiveScale),
            height: evenDimension(from: Double(displayHeightPoints) * effectiveScale)
        )
    }

    private static func evenDimension(from value: Double) -> Int {
        let rounded = max(2, Int(value.rounded(.down)))
        return rounded.isMultiple(of: 2) ? rounded : rounded - 1
    }
}

enum VideoRotation: Int {
    case _0 = 0
    case _90 = 90
    case _180 = 180
    case _270 = 270
}
