import CoreVideo
import Foundation

// Capture seam. ScreenCaptureKitFrameSource is the production impl and
// TestPatternFrameSource is the diagnostic impl. Both produce
// CVPixelBuffer-bearing frames at their native cadence for the owned
// VideoToolbox encoder.

// Push-callback model. The previous AsyncStream design buffered up to 2
// frames in our own stream plus required a pump Task to await them, which
// added ~70 ms of latency before encoding. The
// onFrame closure is invoked directly from whatever thread the underlying
// capture API delivers on (SCStream's sample queue for the production
// impl), so there is no buffer of our own between capture and encode.
protocol VideoFrameSource: AnyObject, Sendable {
    func start(onFrame: @escaping @Sendable (CapturedVideoFrame) -> Void) async throws
    func stop()
}

protocol DisplaySelectableVideoFrameSource: AnyObject, Sendable {
    func selectDisplay(id: String?)
}

// CVPixelBuffer is a CoreFoundation reference type; we never mutate it
// after creation, so crossing task boundaries is safe in practice. Swift's
// strict-concurrency checker doesn't know that, hence @unchecked.
struct CapturedVideoFrame: @unchecked Sendable {
    let pixelBuffer: CVPixelBuffer
    let presentationTimeNs: Int64
    let capturedAtUptimeNs: UInt64
    let rotation: VideoRotation
    let forceKeyframe: Bool
    // OS-provided per-frame damage (ADR-0021), in native pixel-buffer space.
    // Empty when the capture source could not supply usable damage geometry
    // (incomplete frame, missing attachments, a non-SCK source, or a rescaled
    // frame); the damage scroll classifier treats empty damage as a full-frame
    // refresh, so an empty list is always safe, just unoptimized.
    let damageRects: [PixelRect]
    // The valid-content rectangle in native pixel-buffer space, nil when
    // unknown. The classifier gates a scroll band against this width.
    let contentRectPixels: PixelRect?

    init(
        pixelBuffer: CVPixelBuffer,
        presentationTimeNs: Int64,
        capturedAtUptimeNs: UInt64,
        rotation: VideoRotation,
        forceKeyframe: Bool = false,
        damageRects: [PixelRect] = [],
        contentRectPixels: PixelRect? = nil
    ) {
        self.pixelBuffer = pixelBuffer
        self.presentationTimeNs = presentationTimeNs
        self.capturedAtUptimeNs = capturedAtUptimeNs
        self.rotation = rotation
        self.forceKeyframe = forceKeyframe
        self.damageRects = damageRects
        self.contentRectPixels = contentRectPixels
    }
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
