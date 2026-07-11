import AppKit
import CoreGraphics
import Foundation
import Testing
import AgentDeskWire

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
        #expect(tiles[0].desktopNumber == 1)
        #expect(tiles[0].isActive == false)
        #expect(tiles[0].stepDelta == -1)
        #expect(tiles[0].thumbnail == Data([1, 2, 3]))
        #expect(tiles[1].title == "Desktop 2")
        #expect(tiles[1].desktopNumber == 2)
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

    /// R42 (ADR-0054): with the workspace shell on, SpaceAgent parks below a clearance that clears
    /// the revealed top bar, so the two floating all-Spaces panels do not overlap. The legacy 24pt
    /// default overlapped that strip, which is why the re-park (and the v3 key bump) exist.
    @Test func defaultOriginParksClearOfTheWorkspaceTopBar() {
        let screen = CGRect(x: 0, y: 0, width: 1440, height: 900)
        let size = CGSize(width: 320, height: 120)
        let topBarStrip = CGRect(x: screen.minX, y: screen.maxY - 38, width: screen.width, height: 38)

        let origin = SpaceAgentPanelPlacement.defaultOrigin(
            size: size, visibleFrames: [screen], topBarClearance: 52
        )
        #expect(!CGRect(origin: origin, size: size).intersects(topBarStrip))
        #expect(origin.x == screen.midX - size.width / 2) // still horizontally centered

        // The legacy default (no shell) parks only 24 below the top edge and overlaps the strip.
        let legacy = SpaceAgentPanelPlacement.defaultOrigin(size: size, visibleFrames: [screen])
        #expect(CGRect(origin: legacy, size: size).intersects(topBarStrip))
    }

    @Test func expandedPanelCapsWidthForScrollableTiles() {
        let controller = SpaceAgentViewController(layout: .horizontal)
        _ = controller.view
        controller.popoverMaxWidth = 400
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

        #expect(controller.preferredPanelSize.width == 400)
    }

    @Test func expandedPanelKeepsTileStripInsideBounds() throws {
        let controller = SpaceAgentViewController(layout: .horizontal)
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

    @Test func expandedPanelHintsWhenTilesOverflow() throws {
        let controller = SpaceAgentViewController(layout: .horizontal)
        _ = controller.view
        controller.popoverMaxWidth = 400
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
        controller.view.frame = CGRect(origin: .zero, size: controller.preferredPanelSize)
        controller.view.layoutSubtreeIfNeeded()

        var hints = controller.overflowHintState
        #expect(!hints.start)
        #expect(hints.end)

        let scrollView = try #require(firstScrollView(in: controller.view))
        let maxOffsetX = max(
            0,
            (scrollView.documentView?.frame.width ?? 0) - scrollView.contentView.bounds.width
        )
        scrollView.contentView.scroll(to: CGPoint(x: maxOffsetX, y: 0))
        scrollView.reflectScrolledClipView(scrollView.contentView)

        hints = controller.overflowHintState
        #expect(hints.start)
        #expect(!hints.end)
    }

    @Test func verticalPanelCapsHeightForScrollableTiles() {
        let controller = SpaceAgentViewController(layout: .vertical)
        _ = controller.view
        controller.popoverMaxHeight = 300
        controller.isExpanded = true
        controller.render(tiles: (0..<20).map { index in
            SpaceAgentTile(
                spaceId: UInt64(index + 1),
                title: "Desktop \(index + 1)",
                isActive: index == 0,
                stepDelta: index,
                thumbnail: nil
            )
        })

        // Height caps at the override.
        #expect(controller.preferredPanelSize.height == 300)

        // Width is fixed: it does not grow with the row count (unlike the
        // horizontal strip), so a small set yields the same width as the large.
        let wideWidth = controller.preferredPanelSize.width
        controller.render(tiles: [
            SpaceAgentTile(spaceId: 99, title: "Desktop 1", isActive: true, stepDelta: 0, thumbnail: nil)
        ])
        #expect(controller.preferredPanelSize.width == wideWidth)
    }
    @Test func tileGlyphIsFirstLetterUppercasedWithNumberFallback() {
        let named = SpaceAgentTile(
            spaceId: 1, title: "agent-desk", desktopNumber: 3,
            isActive: false, stepDelta: 1, thumbnail: nil
        )
        #expect(named.glyph == "A")

        let leadingPunct = SpaceAgentTile(
            spaceId: 2, title: "  .env.example", desktopNumber: 4,
            isActive: false, stepDelta: 1, thumbnail: nil
        )
        #expect(leadingPunct.glyph == "E")

        // No name: fall back to the desktop number.
        let nameless = SpaceAgentTile(
            spaceId: 3, title: "", desktopNumber: 7,
            isActive: false, stepDelta: 1, thumbnail: nil
        )
        #expect(nameless.glyph == "7")
    }

    @Test func collapsedRailUsesNarrowWidthRegardlessOfCount() {
        let controller = SpaceAgentViewController(layout: .vertical)
        _ = controller.view
        controller.popoverMaxHeight = 300
        controller.isExpanded = true
        controller.isRailCollapsed = true
        controller.render(tiles: (0..<20).map { index in
            SpaceAgentTile(
                spaceId: UInt64(index + 1),
                title: "Desktop \(index + 1)",
                isActive: index == 0,
                stepDelta: index,
                thumbnail: nil
            )
        })

        let railWidth = controller.preferredPanelSize.width
        // The rail is much narrower than the full column (which reserves 280pt).
        #expect(railWidth < 100)
        #expect(controller.preferredPanelSize.height == 300)

        // Width is fixed: it does not grow or shrink with the icon count.
        controller.render(tiles: [
            SpaceAgentTile(spaceId: 99, title: "Desktop 1", isActive: true, stepDelta: 0, thumbnail: nil)
        ])
        #expect(controller.preferredPanelSize.width == railWidth)
    }

    @Test func verticalPanelHintsWhenTilesOverflow() throws {
        let controller = SpaceAgentViewController(layout: .vertical)
        _ = controller.view
        controller.popoverMaxHeight = 240
        controller.isExpanded = true
        controller.render(tiles: (0..<20).map { index in
            SpaceAgentTile(
                spaceId: UInt64(index + 1),
                title: "Desktop \(index + 1)",
                isActive: index == 0,
                stepDelta: index,
                thumbnail: nil
            )
        })
        controller.view.frame = CGRect(origin: .zero, size: controller.preferredPanelSize)
        controller.view.layoutSubtreeIfNeeded()

        // At the top: only the bottom (end) hint shows.
        var hints = controller.overflowHintState
        #expect(!hints.start)
        #expect(hints.end)

        let scrollView = try #require(firstScrollView(in: controller.view))
        let maxOffsetY = max(
            0,
            (scrollView.documentView?.frame.height ?? 0) - scrollView.contentView.bounds.height
        )
        scrollView.contentView.scroll(to: CGPoint(x: 0, y: maxOffsetY))
        scrollView.reflectScrolledClipView(scrollView.contentView)

        // At the bottom: only the top (start) hint shows.
        hints = controller.overflowHintState
        #expect(hints.start)
        #expect(!hints.end)
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

    @Test func resolveSplitsTitleAndAppNameAcrossTwoRows() {
        let topWindow = SpaceTopWindow(
            title: "Inbox - dev@agent",
            appName: "Google Chrome"
        )
        let resolved = SpaceAgentLabelResolver.resolve(topWindow: topWindow, fallback: "Desktop 1")
        #expect(resolved.primary == "Inbox - dev@agent")
        #expect(resolved.secondary == "Google Chrome")
    }

    @Test func resolveReturnsFullUntruncatedRows() {
        let topWindow = SpaceTopWindow(
            title: "this is a very very long browser tab title",
            appName: "Visual Studio Code Insiders Build"
        )
        let resolved = SpaceAgentLabelResolver.resolve(topWindow: topWindow, fallback: "Desktop X")
        // The resolver no longer truncates; the renderer fits each row at draw
        // time and search matches against the full text.
        #expect(resolved.primary == "this is a very very long browser tab title")
        #expect(resolved.secondary == "Visual Studio Code Insiders Build")
    }

    @Test func resolvePromotesAppNameToPrimaryWhenTitleEmpty() {
        let topWindow = SpaceTopWindow(title: "", appName: "Slack")
        let resolved = SpaceAgentLabelResolver.resolve(topWindow: topWindow, fallback: "Desktop 3")
        #expect(resolved.primary == "Slack")
        #expect(resolved.secondary == "")
    }

    @Test func resolveFallsBackWhenWindowIsNil() {
        let resolved = SpaceAgentLabelResolver.resolve(topWindow: nil, fallback: "Desktop 4")
        #expect(resolved.primary == "Desktop 4")
        #expect(resolved.secondary == "")
    }

    @Test func resolveSplitsVSCodeTitleIntoWorkspaceAndFile() {
        let topWindow = SpaceTopWindow(
            title: "SpaceAgentViewController.swift \u{2014} agent-desk",
            appName: "Code"
        )
        let resolved = SpaceAgentLabelResolver.resolve(topWindow: topWindow, fallback: "Desktop 1")
        // Workspace on top (stable identity), file below (transient). Full,
        // untruncated; the renderer fits each row at draw time.
        #expect(resolved.primary == "agent-desk")
        #expect(resolved.secondary == "SpaceAgentViewController.swift")
    }

    @Test func resolveSplitsXcodeTitleIntoProjectAndFile() {
        let topWindow = SpaceTopWindow(
            title: "ContentView.swift \u{2014} MyApp",
            appName: "Xcode"
        )
        let resolved = SpaceAgentLabelResolver.resolve(topWindow: topWindow, fallback: "Desktop 1")
        #expect(resolved.primary == "MyApp")
        #expect(resolved.secondary == "ContentView.swift")
    }

    @Test func resolveSplitsCursorTitleSameAsVSCode() {
        let topWindow = SpaceTopWindow(
            title: "package.json \u{2014} my-project",
            appName: "Cursor"
        )
        let resolved = SpaceAgentLabelResolver.resolve(topWindow: topWindow, fallback: "Desktop 1")
        #expect(resolved.primary == "my-project")
        #expect(resolved.secondary == "package.json")
    }

    @Test func resolveEditorTitleWithNoSeparatorFallsBackToAppName() {
        // Single-segment editor title is the workspace (no file
        // focused). Workspace stays in primary; secondary falls back to
        // the app name so every tile carries a populated subtitle and
        // the row-2 baseline stays uniform across the strip.
        let topWindow = SpaceTopWindow(title: "agent-desk", appName: "Code")
        let resolved = SpaceAgentLabelResolver.resolve(topWindow: topWindow, fallback: "Desktop 1")
        #expect(resolved.primary == "agent-desk")
        #expect(resolved.secondary == "Code")
    }

    @Test func resolveEditorTitleKeepsDirtyMarker() {
        let topWindow = SpaceTopWindow(
            title: "\u{25CF} foo.swift \u{2014} agent-desk",
            appName: "Code"
        )
        let resolved = SpaceAgentLabelResolver.resolve(topWindow: topWindow, fallback: "Desktop 1")
        #expect(resolved.primary == "agent-desk")
        #expect(resolved.secondary == "\u{25CF} foo.swift")
    }

    @Test func resolveEditorMultiSegmentTakesWorkspaceAndFile() {
        let topWindow = SpaceTopWindow(
            title: "foo.swift \u{2014} subdir \u{2014} agent-desk",
            appName: "Code"
        )
        let resolved = SpaceAgentLabelResolver.resolve(topWindow: topWindow, fallback: "Desktop 1")
        #expect(resolved.primary == "agent-desk")
        #expect(resolved.secondary == "foo.swift")
    }

    @Test func resolveNonEditorAppDoesNotSplit() {
        // A non-editor app with an em-dash title keeps the title intact
        // and shows the app name on row 2. Confirms we only hand-split
        // for known editors.
        let topWindow = SpaceTopWindow(
            title: "Inbox \u{2014} dev@agent",
            appName: "Mail"
        )
        let resolved = SpaceAgentLabelResolver.resolve(topWindow: topWindow, fallback: "Desktop 1")
        #expect(resolved.primary == "Inbox \u{2014} dev@agent")
        #expect(resolved.secondary == "Mail")
    }

    @Test func tileTitlesPreferTopWindowLabels() {
        let state = DesktopState(
            displays: [DisplayMetadata(id: "display-a", widthPoints: 1000, heightPoints: 800)],
            spaces: [
                SpaceMetadata(id: 10, displayId: "display-a", index: 0, type: 0),
                SpaceMetadata(id: 11, displayId: "display-a", index: 1, type: 0)
            ],
            activeDisplayId: "display-a",
            activeSpaceId: 10
        )
        let topWindows: [UInt64: SpaceTopWindow] = [
            10: SpaceTopWindow(title: "Inbox - dev@agent", appName: "Google Chrome")
        ]

        let tiles = SpaceAgentModel.tiles(state: state, thumbnails: [:], topWindows: topWindows)

        #expect(tiles[0].title == "Inbox - dev@agent")
        #expect(tiles[0].secondary == "Google Chrome")
        #expect(tiles[0].desktopNumber == 1)
        #expect(tiles[1].title == "Desktop 2")
        #expect(tiles[1].secondary == "")
        #expect(tiles[1].desktopNumber == 2)
    }
}

// Placement math that keeps the dictation bar clear of the SpaceAgent handle.
struct SpaceAgentPanelPlacementTests {
    private let screen = CGRect(x: 0, y: 0, width: 1000, height: 800)
    private let barSize = CGSize(width: 60, height: 52)
    private let handle = CGRect(x: 100, y: 100, width: 52, height: 52)

    @Test func keepsProposedOriginWhenItDoesNotOverlap() {
        let origin = CGPoint(x: 500, y: 500)
        let result = SpaceAgentPanelPlacement.nonOverlappingOrigin(
            proposed: origin, size: barSize, avoid: handle, visibleFrames: [screen]
        )
        #expect(result == origin)
    }

    @Test func slidesClearOfAnOverlappingHandleWithinScreen() {
        let result = SpaceAgentPanelPlacement.nonOverlappingOrigin(
            proposed: CGPoint(x: 110, y: 110), size: barSize, avoid: handle, visibleFrames: [screen]
        )
        let placed = CGRect(origin: result, size: barSize)
        #expect(!placed.intersects(handle))
        #expect(screen.contains(placed))
    }
}
