import CoreGraphics
import CoreVideo
import Foundation
import AgentDeskWire

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

// What the capture stream is pointed at.
//
// A window target streams that window alone through
// `SCContentFilter(desktopIndependentWindow:)`, which renders it unoccluded and
// works while it sits on another Space. Measured against a display target it costs
// roughly a quarter of the bitrate and a sixth of the keyframe size, because the
// wallpaper, menu bar, Dock, and neighbouring windows never enter the frame.
//
// A window target is view-only. `InputDispatcher` posts global CGEvents in display
// coordinates and has no per-window routing, so the host drops input while one is
// selected rather than moving a cursor the viewer cannot see.
enum CaptureTarget: Equatable, Sendable {
    case display(String?)
    case window(CGWindowID)

    var isWindow: Bool {
        if case .window = self { return true }
        return false
    }
}

// Whether the capture source is currently producing usable frames.
//
// A window target can stop producing without the stream ever erroring: minimizing it
// or hiding its app yields `SCFrameStatus.suspended` and then silence, and
// `SCStreamDelegate.didStopWithError` never fires. Without this the client holds its
// last frame forever with a fully healthy decoder, which reads as a freeze.
enum CaptureAvailability: Equatable, Sendable {
    case available
    case unavailable(reason: String)
}

protocol TargetSelectableVideoFrameSource: AnyObject, Sendable {
    func selectCaptureTarget(_ target: CaptureTarget)
    // Rebuild the stream against the same target. The stream's pixel dimensions are fixed at
    // start from the window's size, so a window resized underneath it keeps scaling into the
    // old buffer until this is called. Costs a keyframe, which is why it is explicit rather
    // than folded into selectCaptureTarget's no-op-when-unchanged path.
    func restartCapture()
    // Whether the OS cursor is composited into the captured video. Default off: the client
    // draws its own sharp, low-latency cursor overlay, so baking it into the (laggy,
    // compressed) video too is a redundant double-draw that also adds cursor-move damage.
    // Client-controlled via ClientConfig; applied live (restarts capture, rare event).
    func setShowsCursorInVideo(_ enabled: Bool)
    // Reports capture health transitions only, not every frame.
    func setCaptureAvailabilityHandler(_ handler: @escaping @Sendable (CaptureAvailability) -> Void)
    // Reports the dimensions the stream was actually configured with, each time one starts.
    func setCaptureGeometryHandler(_ handler: @escaping @Sendable (CaptureGeometry) -> Void)
}

// The pixel dimensions the capture stream is really running at.
//
// This is measured, not derived. Anything downstream that wants to know what a fraction of
// the capture comes to -- the client's resolution ladder, above all -- has to be working from
// the number the stream was configured with, because every other route to it is a guess that
// can be right for months and then quietly stop being right: points times an AppKit backing
// scale, a display mode read at a different instant, a remembered value from the last target.
// The stream knows. It says so here, and there is no second opinion to reconcile.
struct CaptureGeometry: Equatable, Sendable {
    let widthPixels: Int
    let heightPixels: Int
}

extension TargetSelectableVideoFrameSource {
    func selectDisplay(id: String?) {
        selectCaptureTarget(.display(id))
    }
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
    // Points-to-pixels for whatever the capture is pointed at. A display supplies its
    // point size and NSScreen backing scale; a window supplies its filter's contentRect
    // and pointPixelScale. Same arithmetic either way, so it takes neither one's vocabulary.
    static func pixelSize(
        widthPoints: Double,
        heightPoints: Double,
        backingScale: Double,
        scaleDownBy: Double
    ) -> CapturePixelSize {
        let effectiveScale = max(backingScale / max(scaleDownBy, 1.0), 0.001)
        return CapturePixelSize(
            width: evenDimension(from: widthPoints * effectiveScale),
            height: evenDimension(from: heightPoints * effectiveScale)
        )
    }

    static func scaleDownBy(baseScaleDownBy: Double, resolutionScale: Double) -> Double {
        max(max(baseScaleDownBy, 1.0) / normalizedResolutionScale(resolutionScale), 1.0)
    }

    static func normalizedResolutionScale(_ scale: Double) -> Double {
        min(max(scale, 0.1), 1.0)
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
