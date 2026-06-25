import CoreGraphics
import CoreVideo
import Testing
@testable import AgentDeskHost

// Task 3: per-frame byte budget. A genuinely-new fullframe tiled all-LZFSE could
// sum to several MB and clog the ~2Mbps link. makeTileEnvelope accumulates the
// payload bytes appended across cells; once the running total crosses
// Config.hybridFrameByteBudget, every subsequent rung-3 (new) cell is forced to
// JPEG regardless of the per-cell busy test. Cells that hit rung 1 (omitted) or
// rung 2 (drawCachedTile) carry no payload and must NOT consume the budget.
struct FrameByteBudgetTests {

    // Early new cells stay LZFSE (compressible, below budget); once the running
    // payload crosses a small budget, later new cells switch to JPEG. Drive a
    // whole-surface change of distinct, individually-compressible cells with the
    // busy threshold raised high (so the busy test alone never trips) and a tiny
    // byte budget (so the budget is the only thing that flips encoding).
    @Test func budgetCrossingForcesLaterNewCellsToJpeg() throws {
        // Busy threshold very high so no cell is "busy"; only the budget can flip
        // a cell to JPEG. Small budget so the first cell or two stay LZFSE and the
        // rest cross over.
        var engine = ScrollDeltaEngine(
            hybridTileBusyBytesPerPixel: 99.0,
            hybridFrameByteBudget: 5_000
        )
        let width = 512
        let height = 256
        let full = PixelRect(x: 0, y: 0, width: width, height: height)

        let first = try Self.makeBGRAFrame(width: width, height: height) { _, _ in
            [10, 10, 10, 0xff]
        }
        #expect(engine.evaluate(first).kind == .reset)
        engine.commitPendingSurface()

        // Whole-surface change: 512x256 at a 128px grid = 4x2 = 8 cells, each with
        // distinct horizontal-gradient content (compressible by LZFSE, so each
        // individual cell is well under the busy threshold, but each still carries
        // a few KB of payload so a handful of cells crosses the 5KB budget).
        let churned = try Self.makeBGRAFrame(
            width: width,
            height: height,
            damageRects: [full],
            contentRectPixels: full
        ) { x, y in
            // A smooth gradient that varies per grid cell so every cell is distinct
            // (no rung-2 hits) yet compresses (LZFSE keeps it well under busy bpp).
            let cellX = x / 128
            let cellY = y / 128
            let v = UInt8((x &+ y &* 3 &+ cellX &* 40 &+ cellY &* 80) & 0xff)
            return [v, v, v, 0xff]
        }
        let result = engine.evaluate(churned)
        #expect(result.kind == .accepted)

        // Collect cache tiles in payload-offset order; the order cells are appended
        // is the order they cross the budget.
        let cacheTiles: [(offset: Int, compression: OwnedGraphicsTileCompression)] =
            (result.envelope?.commands ?? []).compactMap { cmd in
                guard case let .cacheTile(_, _, _, _, _, compression, range) = cmd else { return nil }
                return (range.offset, compression)
            }.sorted { $0.offset < $1.offset }

        // There must be both LZFSE (early, under budget) and JPEG (late, over budget)
        // cache tiles, and every LZFSE tile must precede every JPEG tile in payload
        // order (the budget is a monotonic threshold on accumulated bytes).
        let lzfseCount = cacheTiles.filter { $0.compression == .lzfse }.count
        let jpegCount = cacheTiles.filter { $0.compression == .jpeg }.count
        #expect(lzfseCount >= 1, "early cells (under budget, not busy) must stay LZFSE")
        #expect(jpegCount >= 1, "cells after the budget crosses must switch to JPEG")

        let firstJpegOffset = cacheTiles.first { $0.compression == .jpeg }?.offset ?? .max
        let lastLzfseOffset = cacheTiles.last { $0.compression == .lzfse }?.offset ?? -1
        #expect(lastLzfseOffset < firstJpegOffset,
                "all LZFSE tiles must precede all JPEG tiles in payload order")
    }

    // A high budget (effectively unlimited) keeps every non-busy cell LZFSE: with
    // the busy test off and the budget never crossed, nothing flips to JPEG.
    @Test func highBudgetKeepsAllNonBusyCellsLzfse() throws {
        var engine = ScrollDeltaEngine(
            hybridTileBusyBytesPerPixel: 99.0,
            hybridFrameByteBudget: 100_000_000
        )
        let width = 512
        let height = 256
        let full = PixelRect(x: 0, y: 0, width: width, height: height)

        let first = try Self.makeBGRAFrame(width: width, height: height) { _, _ in
            [10, 10, 10, 0xff]
        }
        #expect(engine.evaluate(first).kind == .reset)
        engine.commitPendingSurface()

        let churned = try Self.makeBGRAFrame(
            width: width,
            height: height,
            damageRects: [full],
            contentRectPixels: full
        ) { x, y in
            let cellX = x / 128
            let cellY = y / 128
            let v = UInt8((x &+ y &* 3 &+ cellX &* 40 &+ cellY &* 80) & 0xff)
            return [v, v, v, 0xff]
        }
        let result = engine.evaluate(churned)
        #expect(result.kind == .accepted)

        for cmd in result.envelope?.commands ?? [] {
            if case let .cacheTile(_, _, _, _, _, compression, _) = cmd {
                #expect(compression == .lzfse, "under an unlimited budget, non-busy cells stay LZFSE")
            }
        }
    }

    // Omitted (rung 1) and cached (rung 2) cells must not consume the budget. Prime
    // the cache so most cells hit rung 2 (drawCachedTile, zero payload), then drive
    // a frame whose only genuinely-new cell is small. With a tiny budget, that lone
    // new cell must still be LZFSE because the cached cells appended no bytes, so
    // the running payload never reached the budget.
    @Test func cachedAndOmittedCellsDoNotConsumeBudget() throws {
        var engine = ScrollDeltaEngine(
            hybridTileBusyBytesPerPixel: 99.0,
            hybridFrameByteBudget: 4_000
        )
        let width = 512
        let height = 256
        let full = PixelRect(x: 0, y: 0, width: width, height: height)

        let first = try Self.makeBGRAFrame(width: width, height: height) { _, _ in
            [10, 10, 10, 0xff]
        }
        #expect(engine.evaluate(first).kind == .reset)
        engine.commitPendingSurface()

        // Frame A: fill the left three columns (cells (0,0)..(2,1)) with distinct
        // content so they cache, and keep the rightmost column at the background so
        // it is omitted. This stores several slots whose payload, on a LATER frame,
        // will be referenced via drawCachedTile (zero payload).
        let frameA = try Self.makeBGRAFrame(
            width: width, height: height,
            damageRects: [full], contentRectPixels: full
        ) { x, y in
            if x < 384 {
                let cellX = x / 128
                let cellY = y / 128
                let v = UInt8((x &+ y &* 3 &+ cellX &* 40 &+ cellY &* 80) & 0xff)
                return [v, v, v, 0xff]
            }
            return [10, 10, 10, 0xff]
        }
        _ = engine.evaluate(frameA)
        engine.commitPendingSurface()

        // Frame B: revert the cached columns to background (so they are no longer on
        // screen) but keep them in the cache, and introduce ONE small new cell in
        // the rightmost column at (384,0). Then Frame C re-shows the cached content
        // AND the new cell, so the cached cells hit rung 2 (zero payload) and the
        // one new cell is the only payload-bearing rung-3 cell.
        let frameB = try Self.makeBGRAFrame(
            width: width, height: height,
            damageRects: [full], contentRectPixels: full
        ) { _, _ in [10, 10, 10, 0xff] }
        _ = engine.evaluate(frameB)
        engine.commitPendingSurface()

        // Frame C: re-show frame A's cached content in the left three columns, plus
        // one genuinely-new compressible cell in the top-right cell (384,0).
        let frameC = try Self.makeBGRAFrame(
            width: width, height: height,
            damageRects: [full], contentRectPixels: full
        ) { x, y in
            if x < 384 {
                let cellX = x / 128
                let cellY = y / 128
                let v = UInt8((x &+ y &* 3 &+ cellX &* 40 &+ cellY &* 80) & 0xff)
                return [v, v, v, 0xff]
            }
            if x >= 384 && x < 512 && y < 128 {
                // A distinct, compressible gradient new cell.
                let v = UInt8((x &* 2 &+ y) & 0xff)
                return [v, v, v, 0xff]
            }
            return [10, 10, 10, 0xff]
        }
        let rC = engine.evaluate(frameC)
        #expect(rC.kind == .accepted)

        // The cached columns must reference slots via drawCachedTile (zero payload).
        let drawCachedCount = (rC.envelope?.commands ?? []).filter {
            if case .drawCachedTile = $0 { return true }; return false
        }.count
        #expect(drawCachedCount >= 1, "cached content must reference slots, not re-send")

        // The lone new cell at (384,0) must be a cacheTile, and it must be LZFSE:
        // the cached cells appended no payload, so the running total never reached
        // the 4KB budget, so the new cell was not forced to JPEG.
        let newCellCompression = (rC.envelope?.commands ?? []).compactMap { cmd -> OwnedGraphicsTileCompression? in
            guard case let .cacheTile(_, x, y, _, _, compression, _) = cmd, x == 384, y == 0 else { return nil }
            return compression
        }
        #expect(newCellCompression == [.lzfse],
                "the only new cell must stay LZFSE because cached/omitted cells did not consume the budget")
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
