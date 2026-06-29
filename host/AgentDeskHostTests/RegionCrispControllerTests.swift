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
        c.observe(pixels: pixels, width: width, height: height, bytesPerRow: width * 4, nowMs: nowMs)
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

    // Behavior 6: normal promotion never increments the dropped-crisp counter; the
    // counter exists so a genuine compression failure is diagnosable, not silent.
    func testDroppedCrispTileCountStaysZeroInNormalFlow() {
        var c = RegionCrispController(config: config())
        _ = observe(&c, surface(0x10), at: 0)
        _ = observe(&c, surface(0x10), at: 200)
        XCTAssertEqual(c.droppedCrispTileCount, 0)
    }
}
