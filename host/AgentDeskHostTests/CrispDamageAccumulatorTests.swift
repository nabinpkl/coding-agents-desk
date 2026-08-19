import XCTest
@testable import AgentDeskHost

// The crisp window runs on its own ~100ms timer while capture delivers up to 60fps, so the
// accumulator is what stops a window from seeing one frame's damage and discarding the rest.
// That discard was not a lost optimization: since ADR-0102 the crisp pass is the only thing
// entitled to revert a tile, and it only re-hashes tiles it visits, so damage that landed on
// a frame between two window boundaries left its tile showing stale pixels until the next
// full heal. These pin the three properties the transport depends on: accumulation across
// frames, take-clears-once, and the bounded collapse.
final class CrispDamageAccumulatorTests: XCTestCase {
    func testAccumulatesDamageAcrossEveryIngestedFrame() {
        var accumulator = CrispDamageAccumulator()
        XCTAssertTrue(accumulator.isEmpty)

        // Six capture frames inside one 100ms window, each damaging a different band. Before
        // accumulation only the last frame's band would have been visited.
        for index in 0..<6 {
            accumulator.add([PixelRect(x: 0, y: index * 128, width: 256, height: 128)])
        }

        let taken = accumulator.take()
        XCTAssertEqual(taken.count, 6)
        XCTAssertEqual(taken.map(\.y), [0, 128, 256, 384, 512, 640])
        XCTAssertTrue(accumulator.isEmpty, "take() must start a fresh accumulation")
        XCTAssertTrue(accumulator.take().isEmpty, "a second take() must not replay the first")
    }

    func testEmptyDamageDoesNotGrowTheSet() {
        var accumulator = CrispDamageAccumulator()
        accumulator.add([])
        XCTAssertTrue(accumulator.isEmpty)
        accumulator.add([PixelRect(x: 4, y: 8, width: 16, height: 32)])
        accumulator.add([])
        XCTAssertEqual(accumulator.rects.count, 1)
    }

    func testCollapsesToUnionBoundingBoxPastTheCap() {
        var accumulator = CrispDamageAccumulator()
        // One rect per row of a finely-fragmented redraw, past the cap.
        let count = CrispDamageAccumulator.maxRects + 1
        for index in 0..<count {
            accumulator.add([PixelRect(x: index, y: index * 2, width: 3, height: 4)])
        }
        let taken = accumulator.take()
        XCTAssertEqual(taken.count, 1, "the set must not grow without bound")
        // A union is a safe over-approximation: it can only make the pass visit more tiles.
        let union = taken[0]
        XCTAssertEqual(union.x, 0)
        XCTAssertEqual(union.y, 0)
        XCTAssertEqual(union.maxX, (count - 1) + 3)
        XCTAssertEqual(union.maxY, (count - 1) * 2 + 4)
    }

    func testRestoredDamageSurvivesAWindowThatBailed() {
        // A window takes the damage, fails to render, and hands it back; the next window must
        // still visit those tiles, or the reverts they would have produced are lost.
        var accumulator = CrispDamageAccumulator()
        accumulator.add([PixelRect(x: 0, y: 0, width: 64, height: 64)])
        let taken = accumulator.take()
        XCTAssertTrue(accumulator.isEmpty)

        accumulator.add(taken)
        accumulator.add([PixelRect(x: 128, y: 128, width: 64, height: 64)])
        let next = accumulator.take()
        XCTAssertEqual(next.count, 2)
        XCTAssertEqual(next[0], PixelRect(x: 0, y: 0, width: 64, height: 64))
        XCTAssertEqual(next[1], PixelRect(x: 128, y: 128, width: 64, height: 64))
    }
}
