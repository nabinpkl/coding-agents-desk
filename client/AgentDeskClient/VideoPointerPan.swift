import CoreGraphics

// Pointer mode's one piece of arithmetic: how far the Mac's pointer travels for a finger
// that travelled some distance across the video.
//
// The answer is geometric, not the trackpad's. `GestureTranslator.emitCursorDelta` applies a
// velocity curve and knows nothing about zoom, which is right for a relative pad with no
// picture under it and wrong here: on a 2x-zoomed video it would move the pointer at twice
// the visual rate of the finger, and the pointer is drawn in that picture.
//
// So one screen point of finger is one screen point of pointer. The pointer keeps whatever
// offset from the finger it started the drag with, and zooming in buys proportionally finer
// control -- which is the whole reason to zoom before doing something precise.
//
// The conversion is the same projection ADR-0009 uses in the other direction. A source point
// occupies `videoSize / displayBounds` screen points at 1x, times the zoom:
//
//     screenPointsPerHostPoint = videoSize.width / displayBounds.width * zoomScale
//     hostDelta                = fingerDelta / screenPointsPerHostPoint
enum VideoPointerPan {
    // nil when the geometry is not known yet: no DesktopState, no laid-out picture, or a
    // zoom scale that has not settled. A caller must send nothing rather than substitute a
    // scale of 1, which would move the pointer by a wrong amount rather than not at all.
    static func hostDelta(
        fingerDelta: CGPoint,
        videoSize: CGSize,
        displayBounds: CGRect,
        zoomScale: CGFloat
    ) -> CGPoint? {
        guard videoSize.width > 0, videoSize.height > 0,
              displayBounds.width > 0, displayBounds.height > 0,
              zoomScale > 0,
              fingerDelta.x.isFinite, fingerDelta.y.isFinite else { return nil }

        let perHostX = videoSize.width / displayBounds.width * zoomScale
        let perHostY = videoSize.height / displayBounds.height * zoomScale
        guard perHostX > 0, perHostY > 0 else { return nil }

        let delta = CGPoint(x: fingerDelta.x / perHostX, y: fingerDelta.y / perHostY)
        guard delta.x.isFinite, delta.y.isFinite else { return nil }
        return delta
    }
}
