import CoreImage
import CoreVideo
import XCTest
@testable import AgentDeskHost

// Unit D: pins the sub-region BGRA render's offset + y-flip, the one correctness risk in the
// damage-proportional convert. CIImage is bottom-left origin; the persistent buffer is
// top-left origin, so a wrong flip or offset places the rendered band at the wrong row/column.
// The tests exercise the CIContext path (a non-BGRA source, so renderRegion converts rather
// than memcpy-ing) against a known per-pixel (x,y) pattern, then assert a sub-region lands
// byte-identical to a full-frame render at the SAME offset, with everything outside untouched.
final class OwnedMediaCrispConvertTests: XCTestCase {
    private let fullWidth = 512
    private let fullHeight = 384

    // A 32ARGB source whose every pixel encodes its (x, y): a non-BGRA format so renderRegion
    // takes the CIContext ARGB->BGRA branch (a lossless channel permutation, no subsampling),
    // and a distinct value per pixel so a misplaced row or column is detectable.
    private func makeARGBSource() -> CVPixelBuffer {
        var pb: CVPixelBuffer?
        let attrs: [CFString: Any] = [
            kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
            kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32ARGB,
        ]
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault, fullWidth, fullHeight, kCVPixelFormatType_32ARGB,
            attrs as CFDictionary, &pb
        )
        XCTAssertEqual(status, kCVReturnSuccess)
        let buffer = pb!
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        let base = CVPixelBufferGetBaseAddress(buffer)!.assumingMemoryBound(to: UInt8.self)
        let stride = CVPixelBufferGetBytesPerRow(buffer)
        for y in 0..<fullHeight {
            for x in 0..<fullWidth {
                let p = base.advanced(by: y * stride + x * 4)
                // ARGB byte order in memory: A, R, G, B. Encode (x,y): distinct per pixel.
                p[0] = 0xFF                       // A
                p[1] = UInt8((x >> 8) & 0xFF) | UInt8((y >> 4) & 0xF0) // R: x-high + y-high nibble
                p[2] = UInt8(y & 0xFF)            // G: y-low
                p[3] = UInt8(x & 0xFF)            // B: x-low
            }
        }
        return buffer
    }

    private func makeBuffer() -> (UnsafeMutableRawPointer, Int) {
        let rowBytes = fullWidth * 4
        let count = rowBytes * fullHeight
        let ptr = UnsafeMutableRawPointer.allocate(
            byteCount: count, alignment: MemoryLayout<UInt8>.alignment
        )
        ptr.initializeMemory(as: UInt8.self, repeating: 0, count: count)
        return (ptr, count)
    }

    // A full-frame render and an interior sub-region render must place identical bytes at the
    // same offset (correct offset + no y-flip), and the sub-region render must not touch bytes
    // outside the region.
    func testSubRegionRenderMatchesFullRenderAtSameOffsetAndLeavesRestUntouched() {
        let source = makeARGBSource()
        let rowBytes = fullWidth * 4
        let context = CIContext(options: [.cacheIntermediates: false])

        // Reference: render the whole frame.
        let (reference, refCount) = makeBuffer()
        defer { reference.deallocate() }
        XCTAssertTrue(OwnedMediaTransport_renderRegionFullFrame(
            source: source, into: reference, destRowBytes: rowBytes,
            fullWidth: fullWidth, fullHeight: fullHeight, context: context
        ))

        // Sub-region: a non-trivial interior band, rest of the buffer left zeroed.
        let region = PixelRect(x: 128, y: 64, width: 256, height: 128)
        let (partial, partCount) = makeBuffer()
        defer { partial.deallocate() }
        XCTAssertEqual(refCount, partCount)
        XCTAssertTrue(OwnedMediaCrispConvert.renderRegion(
            source: source, into: partial, destRowBytes: rowBytes,
            region: region, fullWidth: fullWidth, fullHeight: fullHeight, context: context
        ))

        let ref = reference.assumingMemoryBound(to: UInt8.self)
        let part = partial.assumingMemoryBound(to: UInt8.self)

        // Inside the region: byte-identical to the full-frame reference at the same offset.
        // A wrong y-flip or column offset makes these diverge.
        var insideMismatches = 0
        for y in region.y..<region.maxY {
            for x in region.x..<region.maxX {
                let off = y * rowBytes + x * 4
                for c in 0..<4 where ref[off + c] != part[off + c] {
                    insideMismatches += 1
                }
            }
        }
        XCTAssertEqual(insideMismatches, 0,
                       "sub-region bytes must match the full render at the same offset (offset + flip correct)")

        // The region must carry the reference content, not stay zero (proves it rendered).
        let midOff = (region.y + region.height / 2) * rowBytes + (region.x + region.width / 2) * 4
        XCTAssertGreaterThan(Int(ref[midOff]) + Int(ref[midOff + 1]) + Int(ref[midOff + 2]), 0,
                             "the reference must have non-zero content at the region center")

        // Outside the region: untouched (still zero).
        var outsideNonZero = 0
        for y in 0..<fullHeight {
            for x in 0..<fullWidth {
                let inside = x >= region.x && x < region.maxX && y >= region.y && y < region.maxY
                guard !inside else { continue }
                let off = y * rowBytes + x * 4
                for c in 0..<4 where part[off + c] != 0 {
                    outsideNonZero += 1
                }
            }
        }
        XCTAssertEqual(outsideNonZero, 0, "a sub-region render must not touch bytes outside the region")
    }

    // gridAlignedDamageBounds snaps the union of damage rects OUTWARD to the tile grid and
    // clamps to the surface, so every tile the controller visits is fully inside the region.
    func testGridAlignedDamageBoundsSnapsOutwardAndClamps() {
        let grid = 64
        // A single rect straddling tile boundaries at (70,70)-(200,150).
        let bounds = OwnedMediaCrispConvert.gridAlignedDamageBounds(
            [PixelRect(x: 70, y: 70, width: 130, height: 80)],
            grid: grid, width: fullWidth, height: fullHeight
        )
        XCTAssertEqual(bounds, PixelRect(x: 64, y: 64, width: 192, height: 128),
                       "x: 70->64..256 (192), y: 70->64..192 (128)")

        // Empty damage yields nil (a promote-only gated window renders nothing).
        XCTAssertNil(OwnedMediaCrispConvert.gridAlignedDamageBounds(
            [], grid: grid, width: fullWidth, height: fullHeight
        ))

        // A rect past the surface edge clamps to the surface, still grid-snapped.
        let clamped = OwnedMediaCrispConvert.gridAlignedDamageBounds(
            [PixelRect(x: 500, y: 370, width: 200, height: 200)],
            grid: grid, width: fullWidth, height: fullHeight
        )
        XCTAssertEqual(clamped, PixelRect(x: 448, y: 320, width: 64, height: 64),
                       "clamped to 512x384 then grid-snapped outward")
    }
}

// Thin wrapper so the test can invoke renderRegion for the whole frame without duplicating
// the full-frame PixelRect at every call site.
private func OwnedMediaTransport_renderRegionFullFrame(
    source: CVPixelBuffer,
    into dest: UnsafeMutableRawPointer,
    destRowBytes: Int,
    fullWidth: Int,
    fullHeight: Int,
    context: CIContext
) -> Bool {
    OwnedMediaCrispConvert.renderRegion(
        source: source, into: dest, destRowBytes: destRowBytes,
        region: PixelRect(x: 0, y: 0, width: fullWidth, height: fullHeight),
        fullWidth: fullWidth, fullHeight: fullHeight, context: context
    )
}
