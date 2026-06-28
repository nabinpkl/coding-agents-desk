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

    // Slice 5: a confirmed vertical scroll emits one copyRect that shifts the stable
    // region by the measured dy, then tiles only the thin exposed strip. The diag
    // labels it scroll and carries the offset.
    @Test func verticalScrollEmitsCopyRectThenStrip() throws {
        var engine = ScrollDeltaEngine()
        let side = 256
        let full = PixelRect(x: 0, y: 0, width: side, height: side)
        let dy = 16

        let base = try Self.makeBGRAFrame(width: side, height: side) { _, y in
            let v = Self.scrollRowValue(y); return [v, v, v, 0xff]
        }
        #expect(engine.evaluate(base).kind == .reset)
        engine.commitPendingSurface()

        // Content shifts DOWN by dy: row y now shows what row y-dy showed.
        let scrolled = try Self.makeBGRAFrame(width: side, height: side, damageRects: [full], contentRectPixels: full) { _, y in
            let v = Self.scrollRowValue(y - dy); return [v, v, v, 0xff]
        }
        let r = engine.evaluate(scrolled, motion: MotionSignal(axis: .vertical, sign: 1))
        #expect(r.kind == .accepted)
        #expect(r.diagnostics?.acceptedBy == "scroll")
        #expect(r.diagnostics?.acceptedDy == dy)

        let cmds = r.envelope?.commands ?? []
        guard case let .copyRect(sx, sy, dxc, dyc, w, h) = cmds.first else {
            Issue.record("expected a leading copyRect, got \(cmds)")
            return
        }
        // A downward shift copies the stable top region down by dy.
        #expect(sx == 0 && sy == 0 && dxc == 0 && dyc == dy && w == side && h == side - dy)
        // The rest of the commands tile the exposed top strip.
        let stripTiles = cmds.dropFirst().filter {
            switch $0 { case .bitmapTile, .cacheTile, .drawCachedTile: return true; default: return false }
        }
        #expect(!stripTiles.isEmpty)
        // Exactly one copyRect across every envelope of the frame.
        let copyRects = r.envelopes.flatMap { $0.commands }.filter { if case .copyRect = $0 { return true }; return false }
        #expect(copyRects.count == 1)
    }

    // Slice 5: the exposed strip rides the same content cache ladder as any tile. A
    // second scroll whose exposed strip equals content already cached by the first
    // scroll's strip emits drawCachedTile (zero payload), the cache-ladder win.
    @Test func scrollExposedStripRidesCacheLadder() throws {
        var engine = ScrollDeltaEngine()
        let width = 256
        let height = 384   // three 128px grid rows
        let full = PixelRect(x: 0, y: 0, width: width, height: height)
        let dy = 128       // a full grid cell, so the strip is exactly 128x128 cells
        func docRow(_ y: Int) -> UInt8 { Self.scrollRowValue(y) }
        // A distinct 128-row block, cached at the bottom by a non-scroll frame, then
        // re-revealed at the top by a scroll.
        func blockC(_ row: Int) -> UInt8 { Self.scrollRowValue(row &+ 2000) }

        let base = try Self.makeBGRAFrame(width: width, height: height) { _, y in
            let v = docRow(y); return [v, v, v, 0xff]
        }
        #expect(engine.evaluate(base).kind == .reset)
        engine.commitPendingSurface()

        // Cache block C in the bottom cell row via a plain (non-scroll) tiles change.
        // Only the bottom cells differ from the baseline, so they emit cacheTile.
        let bottomCellRow = PixelRect(x: 0, y: height - dy, width: width, height: dy)
        let cacheSeed = try Self.makeBGRAFrame(width: width, height: height, damageRects: [bottomCellRow], contentRectPixels: full) { _, y in
            let v = y >= height - dy ? blockC(y - (height - dy)) : docRow(y)
            return [v, v, v, 0xff]
        }
        let rSeed = engine.evaluate(cacheSeed, motion: nil)
        #expect(rSeed.kind == .accepted)
        #expect(rSeed.envelopes.flatMap { $0.commands }.contains { if case .cacheTile = $0 { return true }; return false })
        engine.commitPendingSurface()

        // Now scroll DOWN by 128: the exposed top strip carries block C. The current
        // surface shows document content (not C) at the top, so rung-1 does not omit
        // it, and the cache recognizes C from the seed frame: drawCachedTile. The
        // 256-row overlap below the strip fixes the offset at +128.
        let scrolled = try Self.makeBGRAFrame(width: width, height: height, damageRects: [full], contentRectPixels: full) { _, y in
            // current committed surface is [doc(0..256), C]; shifting it down by 128
            // gives [C(exposed) | doc(0..256)].
            let v: UInt8
            if y < dy { v = blockC(y) } else { v = docRow(y - dy) }
            return [v, v, v, 0xff]
        }
        let rScroll = engine.evaluate(scrolled, motion: MotionSignal(axis: .vertical, sign: 1))
        let kinds = rScroll.envelopes.flatMap { $0.commands }.map { Self.kindLabel($0) }
        #expect(rScroll.diagnostics?.acceptedBy == "scroll", "kinds=\(kinds)")
        let hasDrawCached = rScroll.envelopes.flatMap { $0.commands }.contains {
            if case .drawCachedTile = $0 { return true }; return false
        }
        #expect(hasDrawCached, "the re-exposed strip must hit the cache as drawCachedTile; kinds=\(kinds)")
    }

    // Slice 5: input declares a scroll but the band does not translate (an unrelated
    // repaint). The estimator returns nil, so the engine tiles the band, never emits
    // a copyRect.
    @Test func scrollMissTilesTheRegionWithoutCopyRect() throws {
        var engine = ScrollDeltaEngine()
        let side = 256
        let full = PixelRect(x: 0, y: 0, width: side, height: side)

        let base = try Self.makeBGRAFrame(width: side, height: side) { _, y in
            let v = Self.scrollRowValue(y); return [v, v, v, 0xff]
        }
        #expect(engine.evaluate(base).kind == .reset)
        engine.commitPendingSurface()

        // A small, non-translating repaint with a scroll hint: unrelated new content.
        let band = PixelRect(x: 0, y: 0, width: 128, height: 160)
        let changed = try Self.makeBGRAFrame(width: side, height: side, damageRects: [band], contentRectPixels: full) { x, y in
            if x < 128 && y < 160 { let v = UInt8((x &* 31 &+ y &* 17) & 0xff); return [v, v, v, 0xff] }
            let v = Self.scrollRowValue(y); return [v, v, v, 0xff]
        }
        let r = engine.evaluate(changed, motion: MotionSignal(axis: .vertical, sign: 1))
        #expect(r.kind == .accepted)
        #expect(r.diagnostics?.acceptedBy != "scroll")
        let hasCopyRect = r.envelopes.flatMap { $0.commands }.contains { if case .copyRect = $0 { return true }; return false }
        #expect(!hasCopyRect, "a scroll miss must not emit a copyRect")
    }

    // Slice 5: whatever the envelope count, exactly one copyRect appears and it is the
    // first command of the first envelope, and every envelope is self-consistent
    // (commandCount matches and each command validates). Guards the prepend/rebuild.
    @Test func scrollEnvelopesAreSelfConsistentWithSingleLeadingCopyRect() throws {
        var engine = ScrollDeltaEngine()
        let side = 256
        let full = PixelRect(x: 0, y: 0, width: side, height: side)
        let dy = 24

        let base = try Self.makeBGRAFrame(width: side, height: side) { _, y in
            let v = Self.scrollRowValue(y); return [v, v, v, 0xff]
        }
        #expect(engine.evaluate(base).kind == .reset)
        engine.commitPendingSurface()

        let scrolled = try Self.makeBGRAFrame(width: side, height: side, damageRects: [full], contentRectPixels: full) { _, y in
            let v = Self.scrollRowValue(y - dy); return [v, v, v, 0xff]
        }
        let r = engine.evaluate(scrolled, motion: MotionSignal(axis: .vertical, sign: 1))
        #expect(r.diagnostics?.acceptedBy == "scroll")

        var copyRectCount = 0
        for (index, envelope) in r.envelopes.enumerated() {
            #expect(envelope.header.commandCount == envelope.commands.count)
            for (cmdIndex, command) in envelope.commands.enumerated() {
                if case .copyRect = command {
                    copyRectCount += 1
                    #expect(index == 0 && cmdIndex == 0, "copyRect must be the first command of the first envelope")
                }
                try command.validateForCurrentScope(payloadLength: envelope.payload.count)
            }
        }
        #expect(copyRectCount == 1)
    }

    // The [x, y] grid-cell origin a tile-bearing command addresses, or nil otherwise.
    private static func cellOrigin(_ c: OwnedGraphicsCommand) -> [Int]? {
        switch c {
        case let .cacheTile(_, x, y, _, _, _, _): return [x, y]
        case let .bitmapTile(x, y, _, _, _, _): return [x, y]
        case let .drawCachedTile(_, x, y, _, _): return [x, y]
        default: return nil
        }
    }

    // ADR-0024 predict-and-correct: a scroll with a local imperfection (a small patch
    // that did not translate) copyRects the shift and tiles ONLY the cells that differ
    // from the shifted surface (the exposed strip plus the patched cell), not the whole
    // band. The clean stable cell is reproduced by the shift and omitted.
    @Test func imperfectScrollTilesOnlyAffectedCellsNotWholeBand() throws {
        var engine = ScrollDeltaEngine()
        let side = 256
        let full = PixelRect(x: 0, y: 0, width: side, height: side)
        let dy = 16

        let base = try Self.makeBGRAFrame(width: side, height: side) { _, y in
            let v = Self.scrollRowValue(y); return [v, v, v, 0xff]
        }
        #expect(engine.evaluate(base).kind == .reset)
        engine.commitPendingSurface()

        // Scroll down by dy, but perturb a 16x16 patch inside the pure-stable cell at
        // (0,128) so that one cell no longer matches the clean shift.
        let scrolled = try Self.makeBGRAFrame(width: side, height: side, damageRects: [full], contentRectPixels: full) { x, y in
            if (40..<56).contains(x) && (160..<176).contains(y) { return [7, 7, 7, 0xff] }
            let v = Self.scrollRowValue(y - dy); return [v, v, v, 0xff]
        }
        let r = engine.evaluate(scrolled, motion: MotionSignal(axis: .vertical, sign: 1))
        #expect(r.diagnostics?.acceptedBy == "scroll")

        let cmds = r.envelopes.flatMap { $0.commands }
        #expect(cmds.contains { if case .copyRect = $0 { return true }; return false })
        let tiledCells = Set(cmds.compactMap { Self.cellOrigin($0) })
        // The clean stable cell was reproduced by the shift, so it is omitted.
        #expect(!tiledCells.contains([128, 128]))
        // The perturbed stable cell is tiled (the residual).
        #expect(tiledCells.contains([0, 128]))
        // Not every cell of the 4-cell band is tiled: the shift saved at least one.
        #expect(tiledCells.count < 4, "residual must tile only affected cells, not the whole band")
    }

    private static func kindLabel(_ c: OwnedGraphicsCommand) -> String {
        switch c {
        case .resetSurface: return "reset"
        case let .copyRect(_, _, _, dy, _, h): return "copyRect(dy=\(dy),h=\(h))"
        case let .bitmapTile(x, y, _, _, _, _): return "bitmap(\(x),\(y))"
        case let .cacheTile(s, x, y, _, _, _, _): return "cache(s=\(s),\(x),\(y))"
        case let .drawCachedTile(s, x, y, _, _): return "draw(s=\(s),\(x),\(y))"
        }
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
