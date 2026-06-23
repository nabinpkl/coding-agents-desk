import Testing
@testable import AgentDeskHost

// H2: damage snaps to a fixed 128x128 grid. Each overlapped grid cell becomes
// its own tile, clipped to the surface bounds. This bounds per-tile size and
// gives stable tile identity for a future content-hash cache.
struct TileGridEmissionTests {
    @Test func damageSnapsToFixed128Grid() {
        let cells = TileGrid.cells(
            covering: [PixelRect(x: 0, y: 0, width: 200, height: 200)],
            surfaceWidth: 256, surfaceHeight: 256, gridPx: 128
        )
        #expect(cells.count == 4)
        #expect(cells.allSatisfy { $0.width <= 128 && $0.height <= 128 })
        #expect(cells.contains(PixelRect(x: 0, y: 0, width: 128, height: 128)))
        #expect(cells.contains(PixelRect(x: 128, y: 128, width: 72, height: 72)))
    }
}
