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

    func testResetClearsEverything() {
        var cache = TileContentCache(slotCount: 2)
        let a = bytes(0x05)
        _ = cache.assign(hash: TileContentCache.hash(a), bytes: a); cache.commitPending()
        cache.reset()
        XCTAssertNil(cache.lookup(hash: TileContentCache.hash(a), bytes: a))
    }
}
