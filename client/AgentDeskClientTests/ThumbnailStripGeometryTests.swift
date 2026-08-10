import CoreGraphics
import Foundation
import Testing

// The Spaces strip places its selection indicator from this math before the expand animation
// starts, so these are the numbers that decide whether the indicator lands on a tile or
// between two of them. They are asserted here rather than through the view because the whole
// point of the type is that it needs no laid-out view to be correct.
struct ThumbnailStripGeometryTests {
    // Three 52pt pills with 10pt gaps: 176pt of row inside a 300pt viewport.
    private func fittingRow(tileCount: Int = 3) -> ThumbnailStripGeometry {
        ThumbnailStripGeometry(
            tileCount: tileCount, tileWidth: 52, tileHeight: 30, spacing: 10, viewportWidth: 300
        )
    }

    // The same pills in a viewport too narrow to hold them.
    private func overflowingRow() -> ThumbnailStripGeometry {
        ThumbnailStripGeometry(
            tileCount: 6, tileWidth: 52, tileHeight: 30, spacing: 10, viewportWidth: 200
        )
    }

    @Test func rowWidthCountsGapsBetweenTilesOnly() {
        #expect(fittingRow().rowWidth == 176)
        #expect(fittingRow(tileCount: 1).rowWidth == 52)
        #expect(fittingRow(tileCount: 0).rowWidth == 0)
    }

    @Test func fittingRowIsCentredAndDoesNotScroll() {
        let g = fittingRow()
        #expect(g.sectionInset == 62)
        #expect(g.contentWidth == g.viewportWidth)
        #expect(g.maxOffsetX == 0)
        // Centred means the row's own centre is the viewport's centre.
        let first = g.tileFrame(at: 0)
        let last = g.tileFrame(at: 2)
        #expect((first.minX + last.maxX) / 2 == g.viewportWidth / 2)
    }

    @Test func overflowingRowStartsFlushAndScrolls() {
        let g = overflowingRow()
        #expect(g.sectionInset == 0)
        #expect(g.tileFrame(at: 0).minX == 0)
        #expect(g.maxOffsetX == g.rowWidth - g.viewportWidth)
    }

    @Test func tilesAreLaidOutInOrderWithTheGivenSpacing() {
        let g = fittingRow()
        #expect(g.tileFrame(at: 1).minX - g.tileFrame(at: 0).maxX == g.spacing)
        #expect(g.tileFrame(at: 2).minX - g.tileFrame(at: 1).maxX == g.spacing)
        #expect(g.tileFrame(at: 0).size == CGSize(width: 52, height: 30))
        #expect(g.tileFrame(at: 0).minY == 0)
    }

    @Test func fittingRowNeverScrollsAwayFromZero() {
        let g = fittingRow()
        for idx in 0..<g.tileCount {
            #expect(g.restingOffsetX(for: idx) == 0)
        }
    }

    @Test func overflowingRowCentresTheTileWithinTheScrollableRange() {
        let g = overflowingRow()
        // Head and tail clamp; a middle tile centres exactly.
        #expect(g.restingOffsetX(for: 0) == 0)
        #expect(g.restingOffsetX(for: g.tileCount - 1) == g.maxOffsetX)
        let middle = 3
        let centred = g.restingOffsetX(for: middle)
        #expect(centred > 0 && centred < g.maxOffsetX)
        #expect(g.tileFrame(at: middle, offsetBy: centred).midX == g.viewportWidth / 2)
    }

    // What the selection indicator is actually given: the active tile's frame in the
    // container's coordinates, at the offset the row will come to rest at.
    @Test func restingIndicatorFrameCoversExactlyItsTile() {
        for g in [fittingRow(), overflowingRow()] {
            for idx in 0..<g.tileCount {
                let frame = g.tileFrame(at: idx, offsetBy: g.restingOffsetX(for: idx))
                #expect(frame.size == CGSize(width: g.tileWidth, height: g.tileHeight))
                #expect(frame.minX >= 0)
                #expect(frame.maxX <= g.viewportWidth)
            }
        }
    }

    @Test func isUsableRejectsRowsWithNothingToMeasure() {
        #expect(fittingRow().isUsable)
        #expect(!fittingRow(tileCount: 0).isUsable)
        #expect(
            !ThumbnailStripGeometry(
                tileCount: 3, tileWidth: 52, tileHeight: 30, spacing: 10, viewportWidth: 0
            ).isUsable
        )
    }
}
