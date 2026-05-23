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

// ADR-0007 region-of-interest capture. Frame sources that can crop
// their output to a sub-rectangle of the source conform; nil resets
// to the full source. Normalized 0..1 in source coords. Concrete impl
// today is ScreenCaptureKitFrameSource; TestPattern doesn't crop.
//
// The crop affects the OUTPUT frame's dimensions as well: the encoder
// is reconfigured to the rect's pixel size so the sub-region encodes
// at native source density (sharper text), not stretched to fill the
// original full-display dimensions.
protocol RegionalVideoFrameSource: VideoFrameSource {
    func setSourceRect(_ normalizedRect: CGRect?)
}

// CVPixelBuffer is a CoreFoundation reference type; we never mutate it
// after creation, so crossing task boundaries is safe in practice. Swift's
// strict-concurrency checker doesn't know that, hence @unchecked.
struct CapturedVideoFrame: @unchecked Sendable {
    let pixelBuffer: CVPixelBuffer
    let presentationTimeNs: Int64
    let rotation: VideoRotation
}

enum VideoRotation: Int {
    case _0 = 0
    case _90 = 90
    case _180 = 180
    case _270 = 270
}
