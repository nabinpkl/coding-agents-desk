import CoreGraphics
import CoreVideo
import Testing
@testable import AgentDeskHost

// ADR-0022 progressive repaint. A genuinely-new fullframe tiled all-LZFSE could
// sum to several MB and clog the ~2Mbps link. makeTileEnvelope accumulates the
// payload bytes appended across cells; once one envelope crosses
// Config.hybridFrameSendBudgetBytes it is closed and the remaining cells continue
// in the next envelope of the same surface generation (rising frameId). The client
// paints each envelope cell-by-cell as it arrives, so a large repaint streams in as
// several bounded frames instead of one that head-of-line blocks the channel. Text
// stays lossless LZFSE at native resolution (no per-frame downscale); only
// content-busy cells JPEG. Cells that hit rung 1 (omitted) or rung 2
// (drawCachedTile) carry no payload and never trigger a chunk flush.
struct FrameByteBudgetTests {

    // A large whole-surface change with a small per-envelope send budget splits into
    // several envelopes, all in one surface generation with strictly rising
    // frameIds, every non-final envelope at least a budget's worth of payload, and
    // every cell crisp LZFSE (no downscale).
    @Test func largeRepaintSplitsIntoBoundedProgressiveEnvelopes() throws {
        let budget = 8_000
        var engine = ScrollDeltaEngine(
            hybridTileBusyBytesPerPixel: 99.0,        // busy test never trips
            hybridFrameSendBudgetBytes: budget
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

        let envelopes = result.envelopes
        #expect(envelopes.count >= 2, "a large repaint must split into multiple paced envelopes")
        let generations = Set(envelopes.map { $0.header.surfaceGeneration })
        #expect(generations.count == 1, "all progressive envelopes share one surface generation")
        let frameIds = envelopes.map { $0.header.frameId }
        #expect(frameIds == frameIds.sorted() && Set(frameIds).count == frameIds.count,
                "frameIds strictly increase across progressive envelopes")
        for envelope in envelopes.dropLast() {
            #expect(envelope.payload.count >= budget, "a flushed envelope crossed the send budget")
        }
        for envelope in envelopes {
            for cmd in envelope.commands {
                if case let .cacheTile(_, _, _, _, _, compression, _) = cmd {
                    #expect(compression == .lzfse, "progressive repaint keeps text lossless, no downscale")
                }
            }
        }
    }

    // A high send budget never splits: one envelope, all non-busy cells LZFSE.
    @Test func highBudgetEmitsSingleLosslessEnvelope() throws {
        var engine = ScrollDeltaEngine(
            hybridTileBusyBytesPerPixel: 99.0,
            hybridFrameSendBudgetBytes: 100_000_000
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
        #expect(result.envelopes.count == 1, "an under-budget frame is a single envelope")

        for cmd in result.envelopes.first?.commands ?? [] {
            if case let .cacheTile(_, _, _, _, _, compression, _) = cmd {
                #expect(compression == .lzfse, "under a high budget, non-busy cells stay LZFSE")
            }
        }
    }

    // Omitted (rung 1) and cached (rung 2) cells must not consume the budget. Prime
    // the cache so most cells hit rung 2 (drawCachedTile, zero payload), then drive
    // a frame whose only genuinely-new cell is small. With a tiny budget, that lone
    // new cell must still be LZFSE because the cached cells appended no bytes, so
    // the running payload never reached the budget.
    @Test func cachedAndOmittedCellsDoNotTriggerChunking() throws {
        var engine = ScrollDeltaEngine(
            hybridTileBusyBytesPerPixel: 99.0,
            hybridFrameSendBudgetBytes: 4_000
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
