import XCTest
@testable import AgentDeskClient

// Phase 4 of the mixed-mode renderer (ADR-0025): the layer-swap state machine and
// its load-bearing rule, do not reveal tiles until the post-motion refresh commits.
final class OwnedMediaCarrierHandoffTests: XCTestCase {
    func testStartsOnTiles() {
        XCTAssertEqual(OwnedMediaCarrierHandoff().visibleSurface, .tiles)
    }

    func testScrollingShowsVideo() {
        let handoff = OwnedMediaCarrierHandoff()
        XCTAssertEqual(handoff.motionStateChanged(to: .scrolling), .video)
    }

    func testRestAfterScrollHoldsVideoUntilTileRefreshCommits() {
        let handoff = OwnedMediaCarrierHandoff()
        handoff.motionStateChanged(to: .scrolling)
        // Motion stopped, but the crisp tiles are not painted yet.
        XCTAssertEqual(handoff.motionStateChanged(to: .rest), .video)
        XCTAssertTrue(handoff.isHoldingVideoForTileRefresh)
        // The post-motion full-surface refresh lands; now reveal tiles.
        XCTAssertEqual(handoff.tileRefreshCommitted(), .tiles)
        XCTAssertFalse(handoff.isHoldingVideoForTileRefresh)
    }

    func testTileRefreshWhileAlreadyOnTilesIsANoOp() {
        let handoff = OwnedMediaCarrierHandoff()
        XCTAssertEqual(handoff.tileRefreshCommitted(), .tiles)
        XCTAssertEqual(handoff.visibleSurface, .tiles)
    }

    func testScrollingAgainBeforeRefreshCancelsTheHold() {
        let handoff = OwnedMediaCarrierHandoff()
        handoff.motionStateChanged(to: .scrolling)
        handoff.motionStateChanged(to: .rest)
        XCTAssertTrue(handoff.isHoldingVideoForTileRefresh)
        // A new scroll starts before the refresh: stay on video, drop the hold.
        XCTAssertEqual(handoff.motionStateChanged(to: .scrolling), .video)
        XCTAssertFalse(handoff.isHoldingVideoForTileRefresh)
        // A late refresh from the abandoned transition must not flip us to tiles.
        XCTAssertEqual(handoff.tileRefreshCommitted(), .video)
    }

    func testRestWithoutEverScrollingStaysOnTiles() {
        let handoff = OwnedMediaCarrierHandoff()
        XCTAssertEqual(handoff.motionStateChanged(to: .rest), .tiles)
        XCTAssertFalse(handoff.isHoldingVideoForTileRefresh)
    }

    func testResetReturnsToTilesAndClearsHold() {
        let handoff = OwnedMediaCarrierHandoff()
        handoff.motionStateChanged(to: .scrolling)
        handoff.motionStateChanged(to: .rest)
        handoff.reset()
        XCTAssertEqual(handoff.visibleSurface, .tiles)
        XCTAssertFalse(handoff.isHoldingVideoForTileRefresh)
    }
}
