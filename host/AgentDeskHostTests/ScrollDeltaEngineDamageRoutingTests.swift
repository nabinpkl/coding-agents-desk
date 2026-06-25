import CoreGraphics
import CoreVideo
import ImageIO
import Testing
@testable import AgentDeskHost

// H1: with the damage path on, the two non-scroll classifier outcomes
// (.fullFrame and .tiles) both emit a tile envelope over the reliable
// graphics channel instead of falling back to HEVC. .noChange yields a
// result with no envelope and no fallback flag.
struct ScrollDeltaEngineDamageRoutingTests {
    @Test func fullFrameOutcomeProducesTileEnvelopeNotRejection() throws {
        var engine = ScrollDeltaEngine()
        let width = 256
        let height = 256

        // Prime a solid surface (reset).
        let first = try Self.makeBGRAFrame(width: width, height: height) { _, _ in
            [10, 10, 10, 0xff]
        }
        #expect(engine.evaluate(first).kind == .reset)
        engine.commitPendingSurface()

        // Deliver a frame whose damage covers the whole surface with content
        // that differs everywhere and no scroll hint. The classifier returns
        // .fullFrame, which H1 routes to a tile envelope.
        let full = PixelRect(x: 0, y: 0, width: width, height: height)
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

        #expect(result.envelope != nil)
        // Task 2: fullframe routes through the tile cache ladder, so it emits cache
        // tiles (cacheTile / drawCachedTile), not a single whole-frame bitmapTile.
        let hasTile = result.envelope?.commands.contains {
            switch $0 {
            case .bitmapTile, .cacheTile, .drawCachedTile: return true
            default: return false
            }
        } == true
        #expect(hasTile)
    }

    // Per-row luma hash so a vertical shift is detectable and a scroll classifies
    // cleanly (mirrors the classifier test surfaces).
    private static func scrollRowValue(_ y: Int) -> UInt8 {
        var h = UInt32(truncatingIfNeeded: y &+ 1)
        h = h &* 2_654_435_761; h ^= (h >> 15); h = h &* 2_246_822_519; h ^= (h >> 13)
        return UInt8(truncatingIfNeeded: h >> 24)
    }

    // Drive a real downward scroll through the engine so the classifier returns
    // .scroll and makeScrollEnvelope runs, then report the exposed strip tile's
    // compression.
    private static func stripCompressionForDownScroll(dy: Int, width: Int, height: Int) throws -> OwnedGraphicsTileCompression {
        var engine = ScrollDeltaEngine()
        let first = try makeBGRAFrame(width: width, height: height) { _, y in
            let v = scrollRowValue(y); return [v, v, v, 0xff]
        }
        #expect(engine.evaluate(first).kind == .reset)
        engine.commitPendingSurface()
        let band = PixelRect(x: 0, y: 0, width: width, height: height)
        let scrolled = try makeBGRAFrame(width: width, height: height, damageRects: [band], contentRectPixels: band) { _, y in
            let v = scrollRowValue(y - dy); return [v, v, v, 0xff]
        }
        let result = engine.evaluate(scrolled, motion: MotionSignal(axis: .vertical, sign: 1))
        guard let strip = result.envelope?.commands.first(where: { $0.kindIsBitmapTile }),
              case let .bitmapTile(_, _, _, _, compression, _) = strip else {
            Issue.record("expected a scroll strip bitmap tile, acceptedBy=\(String(describing: result.diagnostics?.acceptedBy))")
            return .lzfse
        }
        return compression
    }

    // A fast flick reveals a tall band: 640*240*4 = 614400 bytes >= the 524288
    // threshold, so the strip ships lossy JPEG instead of a large lossless blob.
    @Test func largeFlickScrollStripIsLossyJpeg() throws {
        let compression = try Self.stripCompressionForDownScroll(dy: 240, width: 640, height: 480)
        #expect(compression == .jpeg)
    }

    // A slow scroll reveals a thin strip (640*8*4 = 20480 bytes, well under
    // threshold) and stays lossless so revealed text is crisp. The strip lossy
    // decision is size-only now: backpressure is absorbed by cadence, not by
    // smearing a small readable strip (a small strip stays lossless regardless).
    @Test func slowScrollStripStaysLossless() throws {
        let compression = try Self.stripCompressionForDownScroll(dy: 8, width: 640, height: 480)
        #expect(compression == .lzfse)
    }

    // Workstream B: drive a real downward scroll, then decode the exposed strip's JPEG
    // to its TRUE encoded pixel width. The bitmapTile command always carries the
    // destination width (the client upscales), so a velocity downscale is only visible
    // in the encoded image dimensions, not the command.
    private static func stripEncodedAndDestWidthForDownScroll(
        dy: Int, width: Int, height: Int
    ) throws -> (encodedWidth: Int, destWidth: Int)? {
        var engine = ScrollDeltaEngine()
        let first = try makeBGRAFrame(width: width, height: height) { _, y in
            let v = scrollRowValue(y); return [v, v, v, 0xff]
        }
        #expect(engine.evaluate(first).kind == .reset)
        engine.commitPendingSurface()
        let band = PixelRect(x: 0, y: 0, width: width, height: height)
        let scrolled = try makeBGRAFrame(width: width, height: height, damageRects: [band], contentRectPixels: band) { _, y in
            let v = scrollRowValue(y - dy); return [v, v, v, 0xff]
        }
        let result = engine.evaluate(scrolled, motion: MotionSignal(axis: .vertical, sign: 1))
        guard let envelope = result.envelope,
              let strip = envelope.commands.first(where: { $0.kindIsBitmapTile }),
              case let .bitmapTile(_, _, destWidth, _, .jpeg, byteRange) = strip else {
            return nil
        }
        let jpeg = Data(envelope.payload[byteRange.offset..<(byteRange.offset + byteRange.length)])
        guard let source = CGImageSourceCreateWithData(jpeg as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return nil }
        return (image.width, destWidth)
    }

    // A fast flick (measured offset over hybridScrollFastVelocityPx, default 600)
    // downscales the exposed strip: the encoded JPEG is materially narrower than the
    // destination, which the client upscales. The bulk still rides copyRect at full
    // fidelity; only the thin motion-blurred strip trades resolution for cost.
    @Test func fastFlickScrollStripDownscalesBelowDestination() throws {
        guard let dims = try Self.stripEncodedAndDestWidthForDownScroll(dy: 640, width: 640, height: 900) else {
            Issue.record("expected a jpeg scroll strip for a fast flick")
            return
        }
        #expect(dims.destWidth == 640)
        #expect(dims.encodedWidth < dims.destWidth)   // downscaled
        #expect(dims.encodedWidth <= 360)             // ~0.5x with rounding/clamp slack
    }

    // A moderate flick that is lossy JPEG but below the fast-velocity threshold keeps
    // the strip at native resolution (encoded width == destination), so ordinary
    // scrolling stays crisp; only genuinely fast flicks trade resolution for cost.
    @Test func moderateFlickScrollStripStaysNativeResolution() throws {
        guard let dims = try Self.stripEncodedAndDestWidthForDownScroll(dy: 240, width: 640, height: 480) else {
            Issue.record("expected a jpeg scroll strip for a moderate flick")
            return
        }
        #expect(dims.encodedWidth == dims.destWidth)  // native, not downscaled
    }

    // Pins the LZFSE tile path before the buildTile seam refactor (Task 4 TDD
    // anchor). A .tiles classification must emit one .lzfse bitmapTile per grid
    // cell with a byteRange whose length equals the tile's slice of the payload.
    // If buildTile changes the encoding or breaks byteRange accounting, this
    // test fails before the wire contract changes.
    @Test func tilesPathEmitsLzfseTilesWithCorrectByteRanges() throws {
        var engine = ScrollDeltaEngine()
        let width = 256
        let height = 256

        let first = try Self.makeBGRAFrame(width: width, height: height) { _, _ in
            [10, 10, 10, 0xff]
        }
        #expect(engine.evaluate(first).kind == .reset)
        engine.commitPendingSurface()

        // Change a small region so the damage classifier returns .tiles (small,
        // non-scroll, below the fullFrame threshold). A single 64x64 rect in a
        // 256x256 surface is 6.25% coverage; the classifier treats this as .tiles.
        let damageRect = PixelRect(x: 0, y: 0, width: 64, height: 64)
        let full = PixelRect(x: 0, y: 0, width: width, height: height)
        let changed = try Self.makeBGRAFrame(
            width: width,
            height: height,
            damageRects: [damageRect],
            contentRectPixels: full
        ) { x, y in
            if x < 64 && y < 64 {
                let v = UInt8((x * 13 + y * 7) & 0xff)
                return [v, v, v, 0xff]
            }
            return [10, 10, 10, 0xff]
        }
        let result = engine.evaluate(changed)

        guard let envelope = result.envelope else {
            Issue.record("expected a tile envelope from the .tiles path")
            return
        }
        // All tiles that carry pixels (bitmapTile or cacheTile) must be LZFSE.
        // drawCachedTile carries no payload so it is excluded from byteRange checks.
        let tiles = envelope.commands.compactMap { cmd -> (PixelRect, OwnedGraphicsByteRange)? in
            switch cmd {
            case let .bitmapTile(x, y, w, h, compression, range):
                #expect(compression == .lzfse, "bitmapTile at (\(x),\(y)) must be lzfse, got \(compression)")
                return (PixelRect(x: x, y: y, width: w, height: h), range)
            case let .cacheTile(_, x, y, w, h, compression, range):
                #expect(compression == .lzfse, "cacheTile at (\(x),\(y)) must be lzfse, got \(compression)")
                return (PixelRect(x: x, y: y, width: w, height: h), range)
            default:
                return nil
            }
        }
        #expect(!tiles.isEmpty)
        // Each tile's byteRange must slice the real payload without gaps or overlaps.
        var cursor = 0
        for (rect, range) in tiles.sorted(by: { $0.1.offset < $1.1.offset }) {
            #expect(range.offset == cursor, "gap or overlap at tile \(rect): expected offset \(cursor), got \(range.offset)")
            #expect(range.length > 0, "tile \(rect) has zero-length payload")
            #expect(range.offset + range.length <= envelope.payload.count)
            cursor += range.length
        }
        #expect(cursor == envelope.payload.count, "payload has trailing bytes: cursor=\(cursor) payloadCount=\(envelope.payload.count)")
    }

    // Rung 1 (Task 5): macOS reports the same dirty rect twice in a row, but the
    // pixels equal the retained baseline on the second frame. The engine must
    // omit every tile and return .noChange instead of re-sending the identical
    // bytes and saturating the link.
    @Test func identicalTilesFrameSecondTimeIsNoChange() throws {
        var engine = ScrollDeltaEngine()
        let width = 256
        let height = 256
        let full = PixelRect(x: 0, y: 0, width: width, height: height)

        // Prime with a solid surface (reset path seeds the baseline).
        let first = try Self.makeBGRAFrame(width: width, height: height) { _, _ in
            [0x20, 0x20, 0x20, 0xff]
        }
        #expect(engine.evaluate(first).kind == .reset)
        engine.commitPendingSurface()

        // Deliver a frame with a real change in the top-left 64x64 cell.
        let damageRect = PixelRect(x: 0, y: 0, width: 64, height: 64)
        let changed = try Self.makeBGRAFrame(
            width: width,
            height: height,
            damageRects: [damageRect],
            contentRectPixels: full
        ) { x, y in
            if x < 64 && y < 64 { return [0x80, 0x80, 0x80, 0xff] }
            return [0x20, 0x20, 0x20, 0xff]
        }
        let r1 = engine.evaluate(changed)
        #expect(r1.kind == .accepted)
        engine.commitPendingSurface()

        // Re-send the exact same frame. The OS reports the same dirty rect but
        // the pixels now equal the retained baseline, so nothing should be sent.
        let r2 = engine.evaluate(changed)
        #expect(r2.kind == .noChange)
    }

    // Rung 1 (Task 5): two dirty cells are reported, but only one differs from
    // the retained baseline. The engine must send exactly one bitmapTile command
    // (the truly changed cell) and omit the unchanged cell entirely.
    @Test func partialTilesChangeSendsOnlyChangedCells() throws {
        var engine = ScrollDeltaEngine()
        let width = 256
        let height = 256
        let full = PixelRect(x: 0, y: 0, width: width, height: height)

        // Prime with a solid surface.
        let base = try Self.makeBGRAFrame(width: width, height: height) { _, _ in
            [0x20, 0x20, 0x20, 0xff]
        }
        #expect(engine.evaluate(base).kind == .reset)
        engine.commitPendingSurface()

        // Report two dirty cells, but only the first cell (0,0)-(64,64) actually
        // changes. The second cell (128,128)-(192,192) stays at the baseline fill.
        let cell1 = PixelRect(x: 0, y: 0, width: 64, height: 64)
        let cell2 = PixelRect(x: 128, y: 128, width: 64, height: 64)
        let frame = try Self.makeBGRAFrame(
            width: width,
            height: height,
            damageRects: [cell1, cell2],
            contentRectPixels: full
        ) { x, y in
            if x < 64 && y < 64 { return [0x90, 0x90, 0x90, 0xff] }
            return [0x20, 0x20, 0x20, 0xff]
        }
        let r = engine.evaluate(frame)
        #expect(r.kind == .accepted)
        // Count all commands that carry pixels: bitmapTile or cacheTile (first seen
        // content). drawCachedTile references a slot but sends no pixels; it counts
        // as a tile send for this purpose. Rung 1 must have dropped the unchanged
        // cell at (128,128), so exactly one tile-bearing command must be present.
        let tiles = r.envelope?.commands.filter {
            switch $0 {
            case .bitmapTile, .cacheTile, .drawCachedTile: return true
            default: return false
            }
        } ?? []
        // Only the changed cell at (0,0) must be sent; the unchanged cell at
        // (128,128) is omitted because its pixels equal the retained baseline.
        #expect(tiles.count == 1)
    }

    // Rung 2 (Task 10): content that was seen at (0,0) and cached must be
    // recognized via drawCachedTile when it appears at (128,128). The first
    // appearance must emit cacheTile (sends pixels); the second appearance
    // of the same pixels at a new position must emit drawCachedTile (no pixels).
    @Test func repeatedContentAtNewPositionUsesDrawCachedTile() throws {
        var engine = ScrollDeltaEngine()
        let width = 256
        let height = 256
        let full = PixelRect(x: 0, y: 0, width: width, height: height)

        // Prime a solid background.
        let base = try Self.makeBGRAFrame(width: width, height: height) { _, _ in
            [0x20, 0x20, 0x20, 0xff]
        }
        #expect(engine.evaluate(base).kind == .reset)
        engine.commitPendingSurface()

        // First appearance of 0xAA content at (0,0)-(64,64): must emit cacheTile.
        let damage1 = PixelRect(x: 0, y: 0, width: 64, height: 64)
        let f1 = try Self.makeBGRAFrame(
            width: width, height: height,
            damageRects: [damage1], contentRectPixels: full
        ) { x, y in
            if x < 64 && y < 64 { return [0xAA, 0xAA, 0xAA, 0xff] }
            return [0x20, 0x20, 0x20, 0xff]
        }
        let r1 = engine.evaluate(f1)
        engine.commitPendingSurface()
        #expect(r1.envelope!.commands.contains { if case .cacheTile = $0 { return true }; return false },
                "first appearance must emit cacheTile")

        // Second appearance: same 0xAA content at (128,128)-(192,192); (0,0) reverts.
        // Report both rects as damaged so the engine's grid sees both cells.
        let damage2a = PixelRect(x: 0, y: 0, width: 64, height: 64)
        let damage2b = PixelRect(x: 128, y: 128, width: 64, height: 64)
        let f2 = try Self.makeBGRAFrame(
            width: width, height: height,
            damageRects: [damage2a, damage2b], contentRectPixels: full
        ) { x, y in
            if x >= 128 && x < 192 && y >= 128 && y < 192 { return [0xAA, 0xAA, 0xAA, 0xff] }
            return [0x20, 0x20, 0x20, 0xff]
        }
        let r2 = engine.evaluate(f2)
        engine.commitPendingSurface()
        #expect(r2.envelope!.commands.contains { if case .drawCachedTile = $0 { return true }; return false },
                "second appearance of same content at new position must emit drawCachedTile")
    }

    // Rung 2 (Task 10): after invalidateRetainedSurface the cache must be cleared,
    // forcing the same content to be re-sent as cacheTile, never drawCachedTile.
    @Test func generationResetClearsCache() throws {
        var engine = ScrollDeltaEngine()
        let width = 256
        let height = 256
        let full = PixelRect(x: 0, y: 0, width: width, height: height)

        // Prime and commit a baseline.
        let base = try Self.makeBGRAFrame(width: width, height: height) { _, _ in
            [0x20, 0x20, 0x20, 0xff]
        }
        #expect(engine.evaluate(base).kind == .reset)
        engine.commitPendingSurface()

        // First appearance of 0xAA at (0,0): cached.
        let damage1 = PixelRect(x: 0, y: 0, width: 64, height: 64)
        let f1 = try Self.makeBGRAFrame(
            width: width, height: height,
            damageRects: [damage1], contentRectPixels: full
        ) { x, y in
            if x < 64 && y < 64 { return [0xAA, 0xAA, 0xAA, 0xff] }
            return [0x20, 0x20, 0x20, 0xff]
        }
        _ = engine.evaluate(f1)
        engine.commitPendingSurface()

        // Invalidate: forces a reset on the next evaluate.
        engine.invalidateRetainedSurface()

        // Re-seed after the reset (reset path).
        let reseed = try Self.makeBGRAFrame(width: width, height: height) { _, _ in
            [0x20, 0x20, 0x20, 0xff]
        }
        _ = engine.evaluate(reseed)
        engine.commitPendingSurface()

        // Same 0xAA content now at (128,128): the cache was cleared on reset,
        // so the engine must emit cacheTile, not drawCachedTile.
        let damage2 = PixelRect(x: 128, y: 128, width: 64, height: 64)
        let f2 = try Self.makeBGRAFrame(
            width: width, height: height,
            damageRects: [damage2], contentRectPixels: full
        ) { x, y in
            if x >= 128 && x < 192 && y >= 128 && y < 192 { return [0xAA, 0xAA, 0xAA, 0xff] }
            return [0x20, 0x20, 0x20, 0xff]
        }
        let r = engine.evaluate(f2)
        #expect(!r.envelope!.commands.contains { if case .drawCachedTile = $0 { return true }; return false },
                "after reset, same content must be re-sent as cacheTile, not drawCachedTile")
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
