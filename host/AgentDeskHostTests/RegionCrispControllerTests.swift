import XCTest
@testable import AgentDeskHost

final class RegionCrispControllerTests: XCTestCase {
    private let grid = 64
    private let settle = 150

    private func config(slots: Int = 16) -> RegionCrispConfig {
        RegionCrispConfig(tileGridPx: grid, settleWindowMs: settle, cacheSlots: slots)
    }

    // A uniform BGRA surface filled with one byte value.
    private func surface(_ byte: UInt8, width: Int = 64, height: Int = 64) -> Data {
        Data(repeating: byte, count: width * height * 4)
    }

    private func observe(
        _ c: inout RegionCrispController, _ pixels: Data, at nowMs: Int,
        width: Int = 64, height: Int = 64
    ) -> RegionCrispEmission {
        let emission = c.observe(pixels: pixels, width: width, height: height, bytesPerRow: width * 4, nowMs: nowMs)
        // The transport commits the staged slot assignments once the emission is handed to
        // the lane (commitEmission); mirror that here so cross-frame dedup and eviction
        // behave as in production now that observe() no longer commits unconditionally.
        c.commitEmission()
        return emission
    }

    // Behavior 1 (tracer): a tile static for >= the settle window promotes to a crisp
    // cacheTile carrying its compressed payload.
    func testSettledTilePromotesToCrispCacheTile() {
        var c = RegionCrispController(config: config())
        XCTAssertTrue(observe(&c, surface(0xAB), at: 0).isEmpty, "first sight only establishes baseline")
        let e = observe(&c, surface(0xAB), at: 200)
        XCTAssertEqual(e.commands.count, 1)
        guard case let .cacheTile(_, x, y, w, h, comp, br) = e.commands.first else {
            return XCTFail("expected a cacheTile, got \(String(describing: e.commands.first))")
        }
        XCTAssertEqual([x, y, w, h], [0, 0, 64, 64])
        XCTAssertEqual(comp, .lzfse)
        XCTAssertEqual(br.offset, 0)
        XCTAssertGreaterThan(br.length, 0)
        XCTAssertEqual(e.payload.count, br.length)
        XCTAssertEqual(c.droppedCrispTileCount, 0)
    }

    // Behavior 2: a tile static for less than the settle window does not promote.
    func testStaticBelowSettleWindowDoesNotPromote() {
        var c = RegionCrispController(config: config())
        _ = observe(&c, surface(0xAB), at: 0)
        XCTAssertTrue(observe(&c, surface(0xAB), at: 100).isEmpty, "100ms < 150ms settle must not promote")
    }

    // Behavior 3 (the coherence invariant): when a crisp tile's content changes, the
    // controller eagerly reverts it and never emits a draw for the stale or new hash on
    // that frame. The new content only promotes after its own settle window.
    func testChangedCrispTileEagerlyRevertsAndNeverDrawsStale() {
        var c = RegionCrispController(config: config())
        _ = observe(&c, surface(0xAB), at: 0)
        _ = observe(&c, surface(0xAB), at: 200) // promoted to crisp

        let onChange = observe(&c, surface(0xCD), at: 300)
        XCTAssertEqual(onChange.commands, [.revertTileToVideo(x: 0, y: 0, width: 64, height: 64)])
        XCTAssertTrue(onChange.payload.isEmpty, "a revert carries no payload")
        for command in onChange.commands {
            switch command {
            case .cacheTile, .drawCachedTile:
                XCTFail("must not draw any tile on the frame the content changed")
            default:
                break
            }
        }

        XCTAssertTrue(observe(&c, surface(0xCD), at: 400).isEmpty, "new content must serve its own settle window")
        let repromote = observe(&c, surface(0xCD), at: 500)
        guard case .cacheTile = repromote.commands.first else {
            return XCTFail("the new content must promote after settling")
        }
    }

    // Behavior 4: an already-crisp tile that stays unchanged emits nothing further.
    func testAlreadyCrispUnchangedEmitsNothing() {
        var c = RegionCrispController(config: config())
        _ = observe(&c, surface(0xAB), at: 0)
        _ = observe(&c, surface(0xAB), at: 200) // promoted
        XCTAssertTrue(observe(&c, surface(0xAB), at: 400).isEmpty, "a tile already crisp must not re-emit")
        XCTAssertTrue(observe(&c, surface(0xAB), at: 9999).isEmpty)
    }

    // Behavior 5: content seen before (same hash, cached in a committed slot) promotes
    // via drawCachedTile with no payload, not a fresh cacheTile. Dedup is cross-frame
    // because the cache only exposes committed slots.
    func testRepeatedContentHashDedupsToDrawCachedTile() {
        var c = RegionCrispController(config: config())
        // Promote content A, committing slot for hash(A).
        _ = observe(&c, surface(0xAB), at: 0)
        let promoteA = observe(&c, surface(0xAB), at: 200)
        guard case let .cacheTile(slotA, _, _, _, _, _, _) = promoteA.commands.first else {
            return XCTFail("expected cacheTile for content A")
        }
        // Change to B, settle and promote B.
        _ = observe(&c, surface(0xCD), at: 300) // revert A
        _ = observe(&c, surface(0xCD), at: 500) // promote B
        // Change back to A: revert, then re-settle. A's content is still cached.
        _ = observe(&c, surface(0xAB), at: 600) // revert B
        let reAchievesA = observe(&c, surface(0xAB), at: 800)
        guard case let .drawCachedTile(slot, x, y, w, h) = reAchievesA.commands.first else {
            return XCTFail("returning to cached content must dedup to drawCachedTile, got \(String(describing: reAchievesA.commands.first))")
        }
        XCTAssertEqual(slot, slotA, "must reference the slot already holding content A")
        XCTAssertEqual([x, y, w, h], [0, 0, 64, 64])
        XCTAssertTrue(reAchievesA.payload.isEmpty, "a cache hit carries no payload")
    }

    // Review HIGH-3: when more tiles settle in one frame than the cache can hold, the
    // controller must never make two tiles share a slot (which would paint wrong pixels
    // crisply). Excess tiles are dropped to the video floor and counted.
    func testSingleFrameSlotExhaustionNeverReusesASlot() {
        var c = RegionCrispController(config: config(slots: 2))
        // 192-wide surface = three 64x64 tiles with DISTINCT content (distinct hashes),
        // so each genuinely needs its own slot; the cache holds only two.
        let w = 192, h = 64
        var px = Data(count: w * h * 4)
        for y in 0..<h {
            for x in 0..<w {
                let v: UInt8 = x < 64 ? 0xAA : (x < 128 ? 0xBB : 0xCC)
                let o = y * w * 4 + x * 4
                px[o] = v; px[o + 1] = v; px[o + 2] = v; px[o + 3] = v
            }
        }
        _ = observe(&c, px, at: 0, width: w, height: h)
        let e = observe(&c, px, at: 200, width: w, height: h)
        var slots: [UInt16] = []
        for command in e.commands {
            guard case let .cacheTile(slot, _, _, _, _, _, _) = command else {
                return XCTFail("exhaustion frame should only assign cacheTiles, got \(command)")
            }
            slots.append(slot)
        }
        XCTAssertEqual(slots.count, 2, "only as many tiles as slots may be cached in one frame")
        XCTAssertEqual(Set(slots).count, slots.count, "no two tiles may share a slot")
        XCTAssertEqual(c.throttledCrispTileCount, 1, "the third tile is throttled to the video floor this frame")
        XCTAssertEqual(c.droppedCrispTileCount, 0, "throttling is not a compression-failure drop")
    }

    // Review MINOR-8/11: partial-edge tiles (dimensions not a multiple of the grid) are
    // emitted with correct clipped extents, and multiple cacheTiles in one frame carry
    // sequential, non-overlapping byteRanges that exactly cover the payload.
    func testPartialEdgeTilesAndSequentialByteRanges() {
        var c = RegionCrispController(config: config(slots: 16))
        let w = 70, h = 70 // grid 64 -> tiles 64x64, 6x64, 64x6, 6x6
        _ = observe(&c, surface(0xAB, width: w, height: h), at: 0, width: w, height: h)
        let e = observe(&c, surface(0xAB, width: w, height: h), at: 200, width: w, height: h)

        var ranges: [(offset: Int, length: Int)] = []
        var sawCornerTile = false
        for command in e.commands {
            guard case let .cacheTile(_, _, _, cw, ch, _, br) = command else {
                return XCTFail("expected cacheTile, got \(command)")
            }
            if cw == 6 && ch == 6 { sawCornerTile = true }
            ranges.append((br.offset, br.length))
        }
        XCTAssertEqual(e.commands.count, 4, "a 70x70 surface at grid 64 has four tiles")
        XCTAssertTrue(sawCornerTile, "the 6x6 corner partial-edge tile must be emitted with clipped extent")
        // ByteRanges in emission order are contiguous from 0 and cover the payload exactly.
        var cursor = 0
        for r in ranges {
            XCTAssertEqual(r.offset, cursor, "byteRanges must be sequential with no gaps or overlaps")
            XCTAssertGreaterThan(r.length, 0)
            cursor += r.length
        }
        XCTAssertEqual(cursor, e.payload.count, "byteRanges must cover the payload exactly")
    }

    // Review MAJOR-1: on session reconnect the controller must be reset so its view of
    // the client's slot cache cannot diverge. After reset, previously-crisp content is
    // unknown again: it re-establishes a baseline and re-promotes via cacheTile (fresh
    // payload), never a drawCachedTile referencing a slot the new client lacks.
    func testResetReestablishesBaselineAndDoesNotAssumeCachedSlots() {
        var c = RegionCrispController(config: config())
        _ = observe(&c, surface(0xAB), at: 0)
        _ = observe(&c, surface(0xAB), at: 200) // crisp + cached
        c.reset()
        XCTAssertTrue(observe(&c, surface(0xAB), at: 300).isEmpty, "reset must re-establish a baseline, not assume crisp")
        let e = observe(&c, surface(0xAB), at: 500)
        guard case .cacheTile = e.commands.first else {
            return XCTFail("after reset, content must re-promote via cacheTile, not a stale drawCachedTile")
        }
    }

    // Review MINOR-1: a surface geometry change drops all per-tile state, so the
    // transition frame re-establishes a baseline (no draw) and flags surfaceDidReset so the
    // transport sends a fresh resetSurface before any tile for the new geometry lands. The
    // first-ever observe is NOT a resize and must not raise the flag.
    func testSurfaceResizeReestablishesBaselineAndFlagsReset() {
        var c = RegionCrispController(config: config())
        let first = observe(&c, surface(0xAB), at: 0)
        XCTAssertFalse(first.surfaceDidReset, "the first observe from a 0x0 baseline is not a resize")
        let crisp = observe(&c, surface(0xAB), at: 200)
        guard case .cacheTile = crisp.commands.first else {
            return XCTFail("expected the tile to promote before the resize")
        }
        // Resize to a different geometry: the transition frame establishes a baseline only.
        let resized = observe(&c, surface(0xCD, width: 128, height: 64), at: 300, width: 128, height: 64)
        XCTAssertTrue(resized.surfaceDidReset, "a geometry change must flag a surface reset")
        XCTAssertTrue(resized.isEmpty, "the resize transition frame re-establishes a baseline, it must not draw")
        // After the new geometry settles, tiles promote afresh against the new surface.
        let repromote = observe(&c, surface(0xCD, width: 128, height: 64), at: 500, width: 128, height: 64)
        XCTAssertFalse(repromote.surfaceDidReset, "a steady frame at stable dims is not a resize")
        XCTAssertEqual(repromote.commands.count, 2, "a 128x64 surface at grid 64 has two tiles")
        for command in repromote.commands {
            guard case .cacheTile = command else {
                return XCTFail("post-resize promotion must be fresh cacheTiles, got \(command)")
            }
        }
    }

    // Review MINOR-2: when the cache is full, a settled cell whose slot was evicted by LRU
    // must not silently keep claiming crisp. The next observe finds no cached slot for its
    // hash and re-promotes via a fresh cacheTile, never a drawCachedTile against the slot
    // that now holds another tile's pixels.
    func testEvictedSlotRePromotesViaFreshCacheTile() {
        var c = RegionCrispController(config: config(slots: 1))
        // One slot. Promote content A (claims the only slot).
        _ = observe(&c, surface(0xAA), at: 0)
        let promoteA = observe(&c, surface(0xAA), at: 200)
        guard case let .cacheTile(slotA, _, _, _, _, _, _) = promoteA.commands.first else {
            return XCTFail("expected content A to promote")
        }
        // Switch to B: revert A, then settle and promote B, which evicts A from the slot.
        _ = observe(&c, surface(0xBB), at: 300) // revert A
        let promoteB = observe(&c, surface(0xBB), at: 500)
        guard case let .cacheTile(slotB, _, _, _, _, _, _) = promoteB.commands.first else {
            return XCTFail("expected content B to promote and evict A")
        }
        XCTAssertEqual(slotB, slotA, "with one slot, B must reuse A's evicted slot")
        // Back to A: A's slot now holds B, so A must re-cache fresh, not draw a stale slot.
        _ = observe(&c, surface(0xAA), at: 600) // revert B
        let reAchievesA = observe(&c, surface(0xAA), at: 800)
        guard case let .cacheTile(_, _, _, _, _, _, br) = reAchievesA.commands.first else {
            return XCTFail("evicted content must re-promote via a fresh cacheTile, got \(String(describing: reAchievesA.commands.first))")
        }
        XCTAssertGreaterThan(br.length, 0, "a fresh cacheTile must carry its compressed payload")
        XCTAssertEqual(reAchievesA.payload.count, br.length)
    }

    // Behavior 6: normal promotion never increments the dropped-crisp counter; the
    // counter exists so a genuine compression failure is diagnosable, not silent.
    func testDroppedCrispTileCountStaysZeroInNormalFlow() {
        var c = RegionCrispController(config: config())
        _ = observe(&c, surface(0x10), at: 0)
        _ = observe(&c, surface(0x10), at: 200)
        XCTAssertEqual(c.droppedCrispTileCount, 0)
        XCTAssertEqual(c.throttledCrispTileCount, 0)
    }

    // A surface whose every 64-px tile holds a distinct byte, so each needs its own fresh
    // cacheTile (no dedup across tiles). Used to exercise the per-window byte budget.
    private func distinctTilesSurface(width: Int, height: Int) -> Data {
        var d = Data(count: width * height * 4)
        d.withUnsafeMutableBytes { raw in
            let p = raw.bindMemory(to: UInt8.self)
            let cols = max(1, width / grid)
            for ty in stride(from: 0, to: height, by: grid) {
                for tx in stride(from: 0, to: width, by: grid) {
                    let tileByte = UInt8((tx / grid + (ty / grid) * cols) % 250 + 1)
                    for yy in ty..<min(ty + grid, height) {
                        for xx in tx..<min(tx + grid, width) {
                            let i = (yy * width + xx) * 4
                            p[i] = tileByte; p[i + 1] = tileByte; p[i + 2] = tileByte; p[i + 3] = 0xFF
                        }
                    }
                }
            }
        }
        return d
    }

    // Eager revert (input latency): OS damage over a crisp tile reverts it to the video floor
    // immediately, on the video cadence, instead of waiting for the next hash pass. The tile
    // stops being crisp and must re-settle before it sharpens again.
    func testDamageEagerlyRevertsCrispTileToVideo() {
        var c = RegionCrispController(config: config())
        _ = observe(&c, surface(0xAB), at: 0)
        guard case .cacheTile = observe(&c, surface(0xAB), at: 200).commands.first else {
            return XCTFail("expected the tile to promote to crisp")
        }
        let reverts = c.reactToDamage([PixelRect(x: 10, y: 10, width: 5, height: 5)], nowMs: 250)
        guard case let .revertTileToVideo(x, y, w, h) = reverts.first, reverts.count == 1 else {
            return XCTFail("damage over a crisp tile must revert exactly it, got \(reverts)")
        }
        XCTAssertEqual([x, y, w, h], [0, 0, 64, 64])
        // No longer crisp: the unchanged content must re-settle (not dedup as still-crisp),
        // then re-promote from the still-cached slot once the settle window passes again.
        XCTAssertTrue(observe(&c, surface(0xAB), at: 300).isEmpty, "a freshly reverted tile is not immediately crisp")
        guard case .drawCachedTile = observe(&c, surface(0xAB), at: 600).commands.first else {
            return XCTFail("after an eager revert the unchanged tile re-promotes from cache")
        }
    }

    // Eager revert only touches crisp tiles the damage overlaps; an already-reverted or
    // non-crisp tile is a no-op (no redundant reverts).
    func testDamageRevertsOnlyOverlappedCrispTiles() {
        var c = RegionCrispController(config: config())
        let s = surface(0xCD, width: 128, height: 128)
        _ = observe(&c, s, at: 0, width: 128, height: 128)
        _ = observe(&c, s, at: 200, width: 128, height: 128) // all four tiles crisp
        let reverts = c.reactToDamage([PixelRect(x: 0, y: 0, width: 10, height: 10)], nowMs: 250)
        XCTAssertEqual(reverts.count, 1, "only the crisp tile the damage overlaps reverts")
        XCTAssertTrue(c.reactToDamage([PixelRect(x: 0, y: 0, width: 10, height: 10)], nowMs: 260).isEmpty,
                      "an already-reverted tile must not revert again")
        XCTAssertTrue(c.reactToDamage([], nowMs: 270).isEmpty, "no damage means no reverts")
    }

    // Per-window byte budget: a full-surface settle does not emit every cacheTile at once;
    // the excess throttles and the next window emits more, spreading the re-cache over time.
    func testByteBudgetSpreadsFullSurfaceCacheOverWindows() {
        let cfg = RegionCrispConfig(tileGridPx: grid, settleWindowMs: settle, cacheSlots: 16, maxBytesPerWindow: 1)
        var c = RegionCrispController(config: cfg)
        let s = distinctTilesSurface(width: 128, height: 128) // four distinct tiles
        _ = observe(&c, s, at: 0, width: 128, height: 128)
        func cacheTileCount(_ e: RegionCrispEmission) -> Int {
            e.commands.filter { if case .cacheTile = $0 { return true }; return false }.count
        }
        let w1 = observe(&c, s, at: 200, width: 128, height: 128)
        XCTAssertEqual(cacheTileCount(w1), 1, "a 1-byte budget admits one fresh cacheTile per window")
        XCTAssertGreaterThan(c.throttledCrispTileCount, 0, "the over-budget settled tiles throttle")
        let w2 = observe(&c, s, at: 300, width: 128, height: 128)
        XCTAssertEqual(cacheTileCount(w2), 1, "the next window emits the next throttled tile")
    }
}
