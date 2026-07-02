import CoreImage
import CoreVideo
import Foundation

// ADR-0036: pure region-render helpers for the damage-proportional crisp convert, lifted out
// of QuicSessionHostMediaTransport so they are unit-testable without the transport, lanes, or
// locks. The transport renders only the region a crisp window needs (the whole frame on a
// heal, just the grid-aligned damage bbox on a gated window) into a persistent FAST (malloc)
// buffer the controller then hashes from cached memory.
enum OwnedMediaCrispConvert {
    // The grid-aligned union bounding box of this frame's damage, clamped to the surface, or
    // nil if there is no damage. Snapping outward to the tile grid guarantees every tile the
    // controller will visit for these rects is fully inside the rendered region (a tile that
    // straddles the raw bbox edge would otherwise be half-stale). One bbox render is cheaper
    // than N per-rect renders and still damage-proportional for the typical single-band case.
    static func gridAlignedDamageBounds(
        _ damageRects: [PixelRect], grid: Int, width: Int, height: Int
    ) -> PixelRect? {
        guard grid > 0 else { return nil }
        let clamped = damageRects
            .map { $0.clamped(toWidth: width, height: height) }
            .filter { $0.area > 0 }
        guard let union = PixelRect.union(of: clamped), union.area > 0 else { return nil }
        let x0 = (union.x / grid) * grid
        let y0 = (union.y / grid) * grid
        let x1 = min(width, ((union.maxX + grid - 1) / grid) * grid)
        let y1 = min(height, ((union.maxY + grid - 1) / grid) * grid)
        return PixelRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0)
    }

    // Render one BGRA sub-region of the source into `dest` at the SAME top-left offset, with
    // `destRowBytes` as the full-surface stride, so the region lands in place inside the
    // persistent full-surface buffer and untouched rows/columns keep their prior bytes.
    //
    // Orientation: CIImage(cvPixelBuffer:) is bottom-left origin (y up); the buffer is
    // top-left origin (y down). CIContext.render(toBitmap:bounds:) writes the CIImage content
    // within `bounds` top-down into the bitmap. So a region whose TOP-LEFT is (region.x,
    // region.y) in buffer space maps to CIImage bounds origin y = fullHeight - region.maxY
    // (flip), and we point the bitmap at base + region.y*destRowBytes + region.x*4 so row 0 of
    // the rendered band lands on buffer row region.y. That offset + flip is the whole
    // correctness risk; OwnedMediaCrispConvertTests pins it against a known (x,y) pattern.
    //
    // Already-BGRA source: copy the region's rows directly (no CIContext). YUV source: render
    // via the shared CIContext. Returns false only for a degenerate/unconvertible buffer.
    static func renderRegion(
        source: CVPixelBuffer,
        into dest: UnsafeMutableRawPointer,
        destRowBytes: Int,
        region: PixelRect,
        fullWidth: Int,
        fullHeight: Int,
        context: CIContext
    ) -> Bool {
        guard region.width > 0, region.height > 0,
              region.x >= 0, region.y >= 0,
              region.maxX <= fullWidth, region.maxY <= fullHeight,
              destRowBytes >= fullWidth * 4 else { return false }
        let regionRowBytes = region.width * 4
        let destStart = dest.advanced(by: region.y * destRowBytes + region.x * 4)

        if CVPixelBufferGetPixelFormatType(source) == kCVPixelFormatType_32BGRA {
            // Fast path: the source is already BGRA. Copy just the region's rows (top-down,
            // no flip: an already-BGRA CVPixelBuffer base is top-left origin), honoring the
            // source stride, which may carry row padding.
            guard CVPixelBufferLockBaseAddress(source, .readOnly) == kCVReturnSuccess,
                  let srcBase = CVPixelBufferGetBaseAddress(source) else { return false }
            defer { CVPixelBufferUnlockBaseAddress(source, .readOnly) }
            let srcRowBytes = CVPixelBufferGetBytesPerRow(source)
            guard srcRowBytes >= fullWidth * 4 else { return false }
            for row in 0..<region.height {
                let srcRow = srcBase.advanced(by: (region.y + row) * srcRowBytes + region.x * 4)
                destStart.advanced(by: row * destRowBytes)
                    .copyMemory(from: srcRow, byteCount: regionRowBytes)
            }
            return true
        }

        // YUV source: render just the region via CoreImage straight into the buffer at its
        // offset. bounds is in CIImage (bottom-left) coordinates, hence the y-flip.
        let ciImage = CIImage(cvPixelBuffer: source)
        let bounds = CGRect(
            x: region.x,
            y: fullHeight - region.maxY,
            width: region.width,
            height: region.height
        )
        context.render(
            ciImage,
            toBitmap: destStart,
            rowBytes: destRowBytes,
            bounds: bounds,
            format: .BGRA8,
            colorSpace: CGColorSpaceCreateDeviceRGB()
        )
        return true
    }
}
