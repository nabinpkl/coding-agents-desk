import XCTest
@testable import AgentDeskHost

final class TileContentCacheTests: XCTestCase {
    private func bytes(_ b: UInt8, count: Int = 16) -> Data { Data(repeating: b, count: count) }

    func testLookupMissThenHitAfterCommit() {
        var cache = TileContentCache(slotCount: 4)
        let a = bytes(0x10)
        XCTAssertNil(cache.lookup(hash: TileContentCache.hash(a), bytes: a))
        let slot = cache.assign(hash: TileContentCache.hash(a), bytes: a)
        XCTAssertNil(cache.lookup(hash: TileContentCache.hash(a), bytes: a)) // not visible until commit
        cache.commitPending()
        XCTAssertEqual(cache.lookup(hash: TileContentCache.hash(a), bytes: a), slot)
    }

    func testDiscardPendingDropsUncommitted() {
        var cache = TileContentCache(slotCount: 4)
        let a = bytes(0x11)
        _ = cache.assign(hash: TileContentCache.hash(a), bytes: a)
        cache.discardPending()
        cache.commitPending()
        XCTAssertNil(cache.lookup(hash: TileContentCache.hash(a), bytes: a))
    }

    func testHashCollisionIsVerifiedByBytes() {
        var cache = TileContentCache(slotCount: 4)
        let a = bytes(0x12)
        let b = bytes(0x34)
        let slot = cache.assign(hash: TileContentCache.hash(a), bytes: a)
        cache.commitPending()
        // Force a's hash with b's bytes: lookup must reject (bytes differ).
        XCTAssertEqual(cache.lookup(hash: TileContentCache.hash(a), bytes: a), slot)
        XCTAssertNil(cache.lookup(hash: TileContentCache.hash(a), bytes: b))
    }

    func testLRUEvictsOldestAfterSlotCountDistinctTiles() {
        var cache = TileContentCache(slotCount: 2)
        let a = bytes(0x01), b = bytes(0x02), c = bytes(0x03)
        _ = cache.assign(hash: TileContentCache.hash(a), bytes: a); cache.commitPending()
        _ = cache.assign(hash: TileContentCache.hash(b), bytes: b); cache.commitPending()
        _ = cache.assign(hash: TileContentCache.hash(c), bytes: c); cache.commitPending() // evicts a
        XCTAssertNil(cache.lookup(hash: TileContentCache.hash(a), bytes: a))
        XCTAssertNotNil(cache.lookup(hash: TileContentCache.hash(b), bytes: b))
        XCTAssertNotNil(cache.lookup(hash: TileContentCache.hash(c), bytes: c))
    }

    // A slot referenced via a rung-2 draw-cached hit must have its recency
    // refreshed so it is not the next eviction victim. Without the touch, A is at
    // the LRU front and is wrongly evicted when C is assigned, even though A was
    // referenced more recently than B.
    func testTouchRefreshesRecencyAndSavesSlotFromEviction() {
        var cache = TileContentCache(slotCount: 2)
        let a = bytes(0x01), b = bytes(0x02), c = bytes(0x03)
        _ = cache.assign(hash: TileContentCache.hash(a), bytes: a); cache.commitPending()
        _ = cache.assign(hash: TileContentCache.hash(b), bytes: b); cache.commitPending()
        // A is the LRU front. Reference A this frame (rung-2 hit) and touch it.
        let slotA = cache.lookup(hash: TileContentCache.hash(a), bytes: a)
        XCTAssertNotNil(slotA)
        cache.touch(slot: slotA!)
        cache.commitPending()
        // Now A is MRU and B is LRU. Assigning C must evict B, not A.
        _ = cache.assign(hash: TileContentCache.hash(c), bytes: c); cache.commitPending()
        XCTAssertNotNil(cache.lookup(hash: TileContentCache.hash(a), bytes: a))
        XCTAssertNil(cache.lookup(hash: TileContentCache.hash(b), bytes: b))
        XCTAssertNotNil(cache.lookup(hash: TileContentCache.hash(c), bytes: c))
    }

    // A touch must ride send-success: if the frame is discarded (held or failed),
    // the recency refresh must not apply, so the slot stays at the LRU front.
    func testDiscardPendingDropsTouches() {
        var cache = TileContentCache(slotCount: 2)
        let a = bytes(0x01), b = bytes(0x02), c = bytes(0x03)
        _ = cache.assign(hash: TileContentCache.hash(a), bytes: a); cache.commitPending()
        _ = cache.assign(hash: TileContentCache.hash(b), bytes: b); cache.commitPending()
        let slotA = cache.lookup(hash: TileContentCache.hash(a), bytes: a)
        XCTAssertNotNil(slotA)
        cache.touch(slot: slotA!)
        cache.discardPending()   // the frame never reached the client
        cache.commitPending()
        // The touch was dropped, so A stays LRU and is evicted by C.
        _ = cache.assign(hash: TileContentCache.hash(c), bytes: c); cache.commitPending()
        XCTAssertNil(cache.lookup(hash: TileContentCache.hash(a), bytes: a))
        XCTAssertNotNil(cache.lookup(hash: TileContentCache.hash(b), bytes: b))
        XCTAssertNotNil(cache.lookup(hash: TileContentCache.hash(c), bytes: c))
    }

    func testResetClearsEverything() {
        var cache = TileContentCache(slotCount: 2)
        let a = bytes(0x05)
        _ = cache.assign(hash: TileContentCache.hash(a), bytes: a); cache.commitPending()
        cache.reset()
        XCTAssertNil(cache.lookup(hash: TileContentCache.hash(a), bytes: a))
    }
}
