import CoreGraphics
import CoreVideo
import Testing
@testable import AgentDeskHost

// Task 2: .fullFrame routes through the same per-tile cache ladder as .tiles
// instead of shipping one whole-frame JPEG. The freeze-relevant win is that a
// fullframe-classified frame whose cells are all byte-identical to the retained
// baseline now returns .noChange (zero bytes) rather than re-sending a ~338KB
// whole-screen JPEG every frame. Genuinely-new content still ships, but as
// cache tiles (cacheTile / drawCachedTile), never a single whole-frame bitmap.
struct FullFrameTilerRoutingTests {

    // (a) The freeze fix: a fullframe-classified frame whose whole-surface damage
    // covers content byte-identical to the previous surface must return .noChange
    // with no envelope (zero bytes), not a whole-screen resend. Rung 1 inside the
    // tiler drops every unchanged cell, so the tiler reports allUnchanged ->
    // .noChange.
    @Test func fullFrameAllCachedYieldsNoChangeZeroBytes() throws {
        var engine = ScrollDeltaEngine()
        let width = 256
        let height = 256
        let full = PixelRect(x: 0, y: 0, width: width, height: height)

        // Prime a textured surface so the content is non-trivial.
        let first = try Self.makeBGRAFrame(width: width, height: height) { x, y in
            let v = UInt8((x * 37 + y * 101) & 0xff)
            return [v, v, v, 0xff]
        }
        #expect(engine.evaluate(first).kind == .reset)
        engine.commitPendingSurface()

        // Deliver a frame with whole-surface damage but the SAME pixels. Without a
        // scroll hint and with full-surface damage this classifies .fullFrame, and
        // the tiler must find every cell byte-identical to the baseline.
        let identical = try Self.makeBGRAFrame(
            width: width,
            height: height,
            damageRects: [full],
            contentRectPixels: full
        ) { x, y in
            let v = UInt8((x * 37 + y * 101) & 0xff)
            return [v, v, v, 0xff]
        }
        let result = engine.evaluate(identical)

        #expect(result.kind == .noChange)
        #expect(result.envelope == nil)
    }

    // (b) Genuinely-new content classified .fullFrame must still ship, and must
    // ship through the tiler as cache tiles, not as a single whole-frame JPEG
    // bitmapTile. The makeJPEGFrameEnvelope whole-frame path is deleted, so there
    // must be no whole-surface bitmapTile command and at least one cacheTile.
    @Test func fullFrameNewContentEmitsCacheTilesNotWholeFrameJpeg() throws {
        var engine = ScrollDeltaEngine()
        let width = 256
        let height = 256
        let full = PixelRect(x: 0, y: 0, width: width, height: height)

        let first = try Self.makeBGRAFrame(width: width, height: height) { _, _ in
            [10, 10, 10, 0xff]
        }
        #expect(engine.evaluate(first).kind == .reset)
        engine.commitPendingSurface()

        // Whole-surface damage with content that differs everywhere, no scroll hint:
        // classifies .fullFrame.
        let churned = try Self.makeBGRAFrame(
            width: width,
            height: height,
            damageRects: [full],
            contentRectPixels: full
        ) { x, y in
            let v = UInt8((x * 37 + y * 101) & 0xff)
            return [v, v, v, 0xff]
        }
        let result = engine.evaluate(churned)

        #expect(result.kind == .accepted)
        guard let commands = result.envelope?.commands else {
            Issue.record("fullframe must produce an envelope")
            return
        }
        // At least one cache tile carries the new pixels.
        let cacheTileCount = commands.filter {
            if case .cacheTile = $0 { return true }; return false
        }.count
        #expect(cacheTileCount >= 1, "fullframe new content must ship cache tiles")

        // No single whole-surface bitmapTile covering the entire surface (the old
        // whole-frame JPEG shape). The tiler emits per-grid-cell tiles, each at most
        // tileGridPx wide, never one tile spanning the full width and height.
        let wholeSurfaceBitmap = commands.contains {
            if case let .bitmapTile(_, _, w, h, _, _) = $0, w == width, h == height { return true }
            return false
        }
        #expect(!wholeSurfaceBitmap, "fullframe must not emit a single whole-surface bitmapTile")
    }

    // The freeze fix exactly: a fullframe whose content was already cached (seen in
    // a prior frame) must reference slots via drawCachedTile and ship far fewer
    // bytes than the original cache-store frame. Drive two churned frames; the
    // second repeats the first's content, so the tiler hits rung 2 and the second
    // envelope is dramatically smaller (or .noChange).
    @Test func repeatedFullFrameContentShipsFarFewerBytesThanFirst() throws {
        var engine = ScrollDeltaEngine()
        let width = 256
        let height = 256
        let full = PixelRect(x: 0, y: 0, width: width, height: height)

        let first = try Self.makeBGRAFrame(width: width, height: height) { _, _ in
            [10, 10, 10, 0xff]
        }
        #expect(engine.evaluate(first).kind == .reset)
        engine.commitPendingSurface()

        func churnedFrame(seed: Int) throws -> CapturedVideoFrame {
            try Self.makeBGRAFrame(
                width: width, height: height,
                damageRects: [full], contentRectPixels: full
            ) { x, y in
                let v = UInt8((x * 37 + y * 101 + seed) & 0xff)
                return [v, v, v, 0xff]
            }
        }

        // Frame A: brand-new content, stored into cache slots.
        let a = try churnedFrame(seed: 0)
        let rA = engine.evaluate(a)
        #expect(rA.kind == .accepted)
        let bytesA = rA.envelope?.payload.count ?? 0
        #expect(bytesA > 0)
        engine.commitPendingSurface()

        // Frame B: revert to baseline so A's cells are no longer on screen, then
        // Frame C re-shows A's exact content. First push a different frame to move
        // the surface off A.
        let b = try churnedFrame(seed: 99)
        _ = engine.evaluate(b)
        engine.commitPendingSurface()

        // Frame C: same content as A. Cells match cached slots -> rung 2 hits.
        let c = try churnedFrame(seed: 0)
        let rC = engine.evaluate(c)
        engine.commitPendingSurface()

        let bytesC = rC.envelope?.payload.count ?? 0
        // C must ship far fewer payload bytes than A: cached cells reference slots
        // (drawCachedTile, zero payload) instead of re-encoding pixels.
        #expect(bytesC < bytesA, "repeated fullframe content must ship fewer bytes via the cache")
        // And C must carry at least one drawCachedTile referencing A's slots.
        let drawCachedCount = (rC.envelope?.commands ?? []).filter {
            if case .drawCachedTile = $0 { return true }; return false
        }.count
        #expect(drawCachedCount >= 1, "repeated content must reference cached slots")
    }

    private static func makeBGRAFrame(
        width: Int,
        height: Int,
        damageRects: [PixelRect] = [],
        contentRectPixels: PixelRect? = nil,
        pixel: (Int, Int) -> [UInt8]
    ) throws -> CapturedVideoFrame {
        var pixelBuffer: CVPixelBuffer?
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            width,
            height,
            kCVPixelFormatType_32BGRA,
            [
                kCVPixelBufferIOSurfacePropertiesKey: [:],
                kCVPixelBufferCGImageCompatibilityKey: true,
                kCVPixelBufferCGBitmapContextCompatibilityKey: true
            ] as CFDictionary,
            &pixelBuffer
        )
        guard status == kCVReturnSuccess, let pixelBuffer else {
            throw SessionRejected(reason: .malformed)
        }
        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }
        guard let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) else {
            throw SessionRejected(reason: .malformed)
        }
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        for y in 0..<height {
            for x in 0..<width {
                let bytes = pixel(x, y)
                let offset = y * bytesPerRow + x * 4
                baseAddress.storeBytes(of: bytes[0], toByteOffset: offset, as: UInt8.self)
                baseAddress.storeBytes(of: bytes[1], toByteOffset: offset + 1, as: UInt8.self)
                baseAddress.storeBytes(of: bytes[2], toByteOffset: offset + 2, as: UInt8.self)
                baseAddress.storeBytes(of: bytes[3], toByteOffset: offset + 3, as: UInt8.self)
            }
        }
        return CapturedVideoFrame(
            pixelBuffer: pixelBuffer,
            presentationTimeNs: 123_000_000,
            capturedAtUptimeNs: 456_000_000,
            rotation: ._0,
            damageRects: damageRects,
            contentRectPixels: contentRectPixels
        )
    }
}
