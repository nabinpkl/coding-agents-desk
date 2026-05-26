import AppKit
import CoreGraphics
import Foundation
import Testing

@MainActor
struct SpaceAgentModelTests {
    @Test func tilesUseActiveDisplayUserSpacesOnly() {
        let state = DesktopState(
            displays: [
                DisplayMetadata(id: "display-a", widthPoints: 1000, heightPoints: 800),
                DisplayMetadata(id: "display-b", widthPoints: 1000, heightPoints: 800)
            ],
            spaces: [
                SpaceMetadata(id: 10, displayId: "display-a", index: 0, type: 0),
                SpaceMetadata(id: 11, displayId: "display-a", index: 1, type: 0),
                SpaceMetadata(id: 12, displayId: "display-a", index: nil, type: 4),
                SpaceMetadata(id: 20, displayId: "display-b", index: 0, type: 0)
            ],
            activeDisplayId: "display-a",
            activeSpaceId: 11
        )

        let tiles = SpaceAgentModel.tiles(state: state, thumbnails: [10: Data([1, 2, 3])])

        #expect(tiles.map(\.spaceId) == [10, 11])
        #expect(tiles[0].title == "Desktop 1")
        #expect(tiles[0].isActive == false)
        #expect(tiles[0].stepDelta == -1)
        #expect(tiles[0].thumbnail == Data([1, 2, 3]))
        #expect(tiles[1].title == "Desktop 2")
        #expect(tiles[1].isActive == true)
        #expect(tiles[1].stepDelta == 0)
    }

    @Test func higherIndexProducesPositiveDelta() {
        let state = DesktopState(
            displays: [DisplayMetadata(id: "display-a", widthPoints: 1000, heightPoints: 800)],
            spaces: [
                SpaceMetadata(id: 10, displayId: "display-a", index: 0, type: 0),
                SpaceMetadata(id: 11, displayId: "display-a", index: 1, type: 0),
                SpaceMetadata(id: 12, displayId: "display-a", index: 2, type: 0)
            ],
            activeDisplayId: "display-a",
            activeSpaceId: 10
        )

        let tiles = SpaceAgentModel.tiles(state: state, thumbnails: [:])

        #expect(tiles.map(\.stepDelta) == [0, 1, 2])
    }

    @Test func clampedOriginKeepsPanelVisible() {
        let visible = [CGRect(x: 100, y: 50, width: 500, height: 400)]

        let low = SpaceAgentPanelPlacement.clampedOrigin(
            proposed: CGPoint(x: 10, y: 0),
            size: CGSize(width: 120, height: 80),
            visibleFrames: visible
        )
        let high = SpaceAgentPanelPlacement.clampedOrigin(
            proposed: CGPoint(x: 700, y: 600),
            size: CGSize(width: 120, height: 80),
            visibleFrames: visible
        )

        #expect(low == CGPoint(x: 100, y: 50))
        #expect(high == CGPoint(x: 480, y: 370))
    }

    @Test func expandedPanelCapsWidthForScrollableTiles() {
        let controller = SpaceAgentViewController()
        _ = controller.view
        controller.isExpanded = true
        controller.render(tiles: (0..<8).map { index in
            SpaceAgentTile(
                spaceId: UInt64(index + 1),
                title: "Desktop \(index + 1)",
                isActive: index == 0,
                stepDelta: index,
                thumbnail: nil
            )
        })

        #expect(controller.preferredPanelSize.width == 640)
    }

    @Test func expandedPanelKeepsTileStripInsideBounds() throws {
        let controller = SpaceAgentViewController()
        _ = controller.view
        controller.isExpanded = true
        controller.render(tiles: [
            SpaceAgentTile(spaceId: 1, title: "Desktop 1", isActive: true, stepDelta: 0, thumbnail: nil),
            SpaceAgentTile(spaceId: 2, title: "Desktop 2", isActive: false, stepDelta: 1, thumbnail: nil)
        ])
        controller.view.frame = CGRect(origin: .zero, size: controller.preferredPanelSize)
        controller.view.layoutSubtreeIfNeeded()

        let scrollView = try #require(firstScrollView(in: controller.view))

        #expect(scrollView.frame.minY >= controller.view.bounds.minY)
        #expect(scrollView.frame.maxY <= controller.view.bounds.maxY)
    }

    private func firstScrollView(in view: NSView) -> NSScrollView? {
        if let scrollView = view as? NSScrollView {
            return scrollView
        }
        for subview in view.subviews {
            if let scrollView = firstScrollView(in: subview) {
                return scrollView
            }
        }
        return nil
    }
}
