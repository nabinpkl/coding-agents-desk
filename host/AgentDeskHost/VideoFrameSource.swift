import CoreVideo
import Foundation

// ADR-0004 capture seam. ScreenCaptureKitFrameSource is the v0 impl
// (lands in R8.6.5). TestPatternFrameSource is the diagnostic impl
// (lands in R8.6.3). Both produce CVPixelBuffer-bearing frames at their
// native cadence; the WebRTC layer pulls them through a
// ScreenCaptureKitVideoCapturer that wraps RTCCVPixelBuffer.

protocol VideoFrameSource: AnyObject, Sendable {
    func start() async throws
    func stop()
    var frames: AsyncStream<CapturedVideoFrame> { get }
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
