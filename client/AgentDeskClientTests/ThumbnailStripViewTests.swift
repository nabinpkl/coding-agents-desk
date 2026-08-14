import Foundation
import Testing
import UIKit
import AgentDeskWire

@MainActor
struct ThumbnailStripViewTests {
    // MARK: - Pure progress math
    //
    // The new strip rides on UICollectionView; the host contract is
    // unchanged (one .switchSpaceGesture(.began|.changed|.ended) frame
    // per scroll-view callback, signed progress in [-1, 1], signed
    // velocity). The pure math that maps contentOffset onto that
    // progress lives on the type so tests don't need a real
    // UIScrollView to exercise the sign and clamp logic.

    @Test func progressIsZeroAtRestingOffset() {
        let p = ThumbnailStripView.computeRawProgress(
            currentOffsetX: 100, activeRestingOffsetX: 100, pageWidth: 72
        )
        #expect(p == 0)
    }

    @Test func progressIsPositiveWhenScrolledOppositeOfFinger() {
        // Dragging the finger RIGHT pulls content right, DECREASING
        // contentOffset.x. "Translation-equivalent" is positive, so
        // progress before sign-flip is positive.
        let p = ThumbnailStripView.computeRawProgress(
            currentOffsetX: 64, activeRestingOffsetX: 100, pageWidth: 72
        )
        #expect(p > 0)
        #expect(p < 1)
    }

    @Test func progressIsNegativeWhenScrolledWithFinger() {
        let p = ThumbnailStripView.computeRawProgress(
            currentOffsetX: 140, activeRestingOffsetX: 100, pageWidth: 72
        )
        #expect(p < 0)
        #expect(p > -1)
    }

    @Test func progressClampsToSignedUnitInterval() {
        let high = ThumbnailStripView.computeRawProgress(
            currentOffsetX: -500, activeRestingOffsetX: 100, pageWidth: 72
        )
        #expect(high == 1.0)
        let low = ThumbnailStripView.computeRawProgress(
            currentOffsetX: 500, activeRestingOffsetX: 100, pageWidth: 72
        )
        #expect(low == -1.0)
    }

    @Test func progressIsZeroIfPageWidthIsZero() {
        let p = ThumbnailStripView.computeRawProgress(
            currentOffsetX: 50, activeRestingOffsetX: 0, pageWidth: 0
        )
        #expect(p == 0)
    }

    @Test func nudgeMovesExactZeroOffSoDockGuardPasses() {
        #expect(ThumbnailStripView.nudgeAwayFromZero(0) != 0)
        #expect(abs(ThumbnailStripView.nudgeAwayFromZero(0)) <= Float.leastNormalMagnitude)
        // Non-zero passes through.
        #expect(ThumbnailStripView.nudgeAwayFromZero(0.5) == 0.5)
        #expect(ThumbnailStripView.nudgeAwayFromZero(-0.5) == -0.5)
    }

    // MARK: - Sign-flip / direction handling
    //
    // emitSwipeFrame is the production seam between the strip's
    // internal progress (old translation.x sign convention: finger-
    // right positive) and the wire emit. useMacOSDirection toggles
    // whether to flip.

    @Test func defaultDirectionInvertsRawSign() {
        // Per AGENTS.md "Scroll and slide direction", the default is
        // OPPOSITE of Mac native: finger LEFT (rawProgress negative
        // under the translation = -(currentOffset - resting) convention)
        // commits the right-neighbour Space. Verified on hardware
        // 2026-05-24 that the wire sign needs to be INVERTED from raw
        // under the default toggle for the Dock to commit in the
        // correct direction.
        let recorder = StripRecorder()
        let view = ThumbnailStripView()
        view.delegate = recorder

        view.emitSwipeFrame(phase: .changed, rawProgress: 0.5, velocityX: 1200)

        guard case let .switchSpaceGesture(_, progress, velocityX) = recorder.events.last else {
            Issue.record("expected switchSpaceGesture")
            return
        }
        #expect(progress == -0.5)
        #expect(velocityX == -1200)
    }

    @Test func useMacOSDirectionPassesSignThrough() {
        let recorder = StripRecorder()
        let view = ThumbnailStripView()
        view.delegate = recorder
        view.useMacOSDirection = true

        view.emitSwipeFrame(phase: .changed, rawProgress: 0.5, velocityX: 1200)

        guard case let .switchSpaceGesture(_, progress, velocityX) = recorder.events.last else {
            Issue.record("expected switchSpaceGesture")
            return
        }
        #expect(progress == 0.5)
        #expect(velocityX == 1200)
    }

    @Test func eachEmitProducesOnePhasedFrame() {
        let recorder = StripRecorder()
        let view = ThumbnailStripView()
        view.delegate = recorder

        view.emitSwipeFrame(phase: .began, rawProgress: 0, velocityX: 0)
        view.emitSwipeFrame(phase: .changed, rawProgress: 0.3, velocityX: 800)
        view.emitSwipeFrame(phase: .ended, rawProgress: 0.7, velocityX: 1400)

        #expect(recorder.events.count == 3)
        if case let .switchSpaceGesture(p0, _, _) = recorder.events[0] { #expect(p0 == .began) }
        if case let .switchSpaceGesture(p1, _, _) = recorder.events[1] { #expect(p1 == .changed) }
        if case let .switchSpaceGesture(p2, _, _) = recorder.events[2] { #expect(p2 == .ended) }
    }

    // MARK: - Tile rendering from DesktopState
    //
    // The strip's visibility is owned by PairingViewController
    // (refreshThumbnailStripVisibility), so these tests assert
    // userSpaceCount and activeIndex rather than the view's own
    // isHidden.

    @Test func applyStateRendersOneTilePerUserSpaceOnActiveDisplay() {
        let view = ThumbnailStripView()
        view.apply(state: DesktopState(
            displays: [DisplayMetadata(id: "DISP-1", widthPoints: 1512, heightPoints: 982)],
            spaces: [
                SpaceMetadata(id: 100, displayId: "DISP-1", index: 0, type: 0),
                SpaceMetadata(id: 200, displayId: "DISP-1", index: 1, type: 0),
                SpaceMetadata(id: 300, displayId: "DISP-1", index: 2, type: 0),
            ],
            activeDisplayId: "DISP-1",
            activeSpaceId: 200
        ))
        #expect(view.userSpaceCount == 3)
        #expect(view.activeIndex == 1)
    }

    @Test func applyStateSkipsFullscreenSpaces() {
        let view = ThumbnailStripView()
        view.apply(state: DesktopState(
            displays: [DisplayMetadata(id: "DISP-1", widthPoints: 1512, heightPoints: 982)],
            spaces: [
                SpaceMetadata(id: 100, displayId: "DISP-1", index: 0, type: 0),
                SpaceMetadata(id: 150, displayId: "DISP-1", index: nil, type: 4),
                SpaceMetadata(id: 200, displayId: "DISP-1", index: 1, type: 0),
            ],
            activeDisplayId: "DISP-1",
            activeSpaceId: 100
        ))
        #expect(view.userSpaceCount == 2)
        #expect(view.activeIndex == 0)
    }

    @Test func applyStateOnlyCountsSelectedDisplaySpacesWhenPresent() {
        let view = ThumbnailStripView()
        view.apply(state: DesktopState(
            displays: [
                DisplayMetadata(id: "DISP-1", widthPoints: 1512, heightPoints: 982),
                DisplayMetadata(id: "DISP-2", widthPoints: 1512, heightPoints: 982),
            ],
            spaces: [
                SpaceMetadata(id: 100, displayId: "DISP-1", index: 0, type: 0),
                SpaceMetadata(id: 200, displayId: "DISP-1", index: 1, type: 0),
                SpaceMetadata(id: 500, displayId: "DISP-2", index: 0, type: 0),
                SpaceMetadata(id: 600, displayId: "DISP-2", index: 1, type: 0),
                SpaceMetadata(id: 700, displayId: "DISP-2", index: 2, type: 0),
            ],
            activeDisplayId: "DISP-1",
            selectedDisplayId: "DISP-2",
            activeSpaceId: 200
        ))
        #expect(view.userSpaceCount == 3)
        #expect(view.activeIndex == nil)
    }

    @Test func applyStateFallsBackToActiveDisplayWhenSelectedDisplayMissing() {
        let view = ThumbnailStripView()
        view.apply(state: DesktopState(
            displays: [
                DisplayMetadata(id: "DISP-1", widthPoints: 1512, heightPoints: 982),
                DisplayMetadata(id: "DISP-2", widthPoints: 1512, heightPoints: 982),
            ],
            spaces: [
                SpaceMetadata(id: 100, displayId: "DISP-1", index: 0, type: 0),
                SpaceMetadata(id: 200, displayId: "DISP-1", index: 1, type: 0),
                SpaceMetadata(id: 500, displayId: "DISP-2", index: 0, type: 0),
            ],
            activeDisplayId: "DISP-1",
            activeSpaceId: 200
        ))
        #expect(view.userSpaceCount == 2)
        #expect(view.activeIndex == 1)
    }

    @Test func applyStateFallsBackWhenSelectedDisplayIsStale() {
        let view = ThumbnailStripView()
        view.apply(state: DesktopState(
            displays: [
                DisplayMetadata(id: "DISP-1", widthPoints: 1512, heightPoints: 982),
            ],
            spaces: [
                SpaceMetadata(id: 100, displayId: "DISP-1", index: 0, type: 0),
                SpaceMetadata(id: 200, displayId: "DISP-1", index: 1, type: 0),
            ],
            activeDisplayId: "DISP-1",
            selectedDisplayId: "STALE-DISPLAY",
            activeSpaceId: 100
        ))
        #expect(view.userSpaceCount == 2)
        #expect(view.activeIndex == 0)
    }

    @Test func displayRailRendersLabelsForMultipleDisplays() {
        let view = DisplayRailView()
        view.apply(state: DesktopState(
            displays: [
                DisplayMetadata(id: "DISP-1", label: "Built-in", isMain: true, widthPoints: 1512, heightPoints: 982),
                DisplayMetadata(id: "DISP-2", label: "Studio", widthPoints: 2560, heightPoints: 1440),
            ],
            spaces: [],
            activeDisplayId: "DISP-1",
            selectedDisplayId: "DISP-2",
            activeSpaceId: nil
        ))

        #expect(view.displayCount == 2)
        #expect(view.isHidden == false)
        #expect(DisplayRailView.title(for: DisplayMetadata(id: "x", isMain: true, widthPoints: 1, heightPoints: 1), fallbackIndex: 0) == "Main")
    }

    @Test func applyStateHandlesSingleUserSpace() {
        let view = ThumbnailStripView()
        view.apply(state: DesktopState(
            displays: [DisplayMetadata(id: "DISP-1", widthPoints: 1512, heightPoints: 982)],
            spaces: [
                SpaceMetadata(id: 100, displayId: "DISP-1", index: 0, type: 0),
            ],
            activeDisplayId: "DISP-1",
            activeSpaceId: 100
        ))
        #expect(view.userSpaceCount == 1)
        #expect(view.activeIndex == 0)
    }

    @Test func applyStateHandlesNoActiveDisplay() {
        let view = ThumbnailStripView()
        view.apply(state: DesktopState(
            displays: [],
            spaces: [],
            activeDisplayId: nil,
            activeSpaceId: nil
        ))
        #expect(view.userSpaceCount == 0)
        #expect(view.activeIndex == nil)
    }

    // MARK: - Compact row and on-demand previews
    //
    // The strip rests as a compact row of Desktop pills, which is also its bar: Desktop
    // switching is never a tap deep. A leading glyph grows those pills into preview tiles,
    // and exists only when the host is capturing previews at all. The row height is what the
    // layout owner installs, so it is asserted through `preferredHeight`.

    private func threeSpaceState() -> DesktopState {
        DesktopState(
            displays: [DisplayMetadata(id: "DISP-1", widthPoints: 1512, heightPoints: 982)],
            spaces: [
                SpaceMetadata(id: 100, displayId: "DISP-1", index: 0, type: 0),
                SpaceMetadata(id: 200, displayId: "DISP-1", index: 1, type: 0),
                SpaceMetadata(id: 300, displayId: "DISP-1", index: 2, type: 0),
            ],
            activeDisplayId: "DISP-1",
            activeSpaceId: 200
        )
    }

    @Test func restsAsTheBar() {
        let view = ThumbnailStripView()
        view.apply(state: threeSpaceState())

        #expect(view.isExpanded == false)
        #expect(view.preferredHeight == ThumbnailStripView.barHeight)
    }

    // Previews off is the setting's own default, and the bar still opens: the pills are a
    // useful row without capture, they are just not preview tiles.
    @Test func opensToThePillRowWhenPreviewsAreOff() {
        let view = ThumbnailStripView()
        let recorder = StripRecorder()
        view.delegate = recorder
        view.showsPreviews = false
        view.apply(state: threeSpaceState())
        view.setExpanded(true)

        #expect(view.isExpanded)
        #expect(view.showsPreviewTiles == false)
        #expect(view.currentTileWidth == ThumbnailStripView.compactTileWidth)
        #expect(view.preferredHeight == ThumbnailStripView.compactRowHeight + ThumbnailStripView.rowVerticalPadding * 2)
        #expect(recorder.heightChanges == 1)
    }

    @Test func opensToThePreviewRowWhenPreviewsAreOn() {
        let view = ThumbnailStripView()
        view.showsPreviews = true
        view.apply(state: threeSpaceState())
        view.setExpanded(true)

        #expect(view.showsPreviewTiles)
        #expect(view.currentTileWidth == ThumbnailStripView.tileWidth)
        #expect(view.preferredHeight == ThumbnailStripView.previewRowHeight + ThumbnailStripView.rowVerticalPadding * 2)
    }

    @Test func closingReturnsToTheBarHeight() {
        let view = ThumbnailStripView()
        let recorder = StripRecorder()
        view.delegate = recorder
        view.showsPreviews = true
        view.apply(state: threeSpaceState())
        view.setExpanded(true)
        view.setExpanded(true)
        view.setExpanded(false)

        #expect(view.isExpanded == false)
        #expect(view.preferredHeight == ThumbnailStripView.barHeight)
        // Re-opening an open strip is not a height change.
        #expect(recorder.heightChanges == 2)
    }

    // Turning capture off under an open strip swaps the tiles in place rather than closing
    // it, and the layout owner has to hear the shorter row without a tap.
    @Test func turningPreviewsOffWhileOpenShrinksToThePillRow() {
        let view = ThumbnailStripView()
        let recorder = StripRecorder()
        view.delegate = recorder
        view.showsPreviews = true
        view.apply(state: threeSpaceState())
        view.setExpanded(true)
        let afterOpen = recorder.heightChanges

        view.showsPreviews = false
        #expect(view.isExpanded)
        #expect(view.preferredHeight == ThumbnailStripView.compactRowHeight + ThumbnailStripView.rowVerticalPadding * 2)
        #expect(recorder.heightChanges == afterOpen + 1)
    }

    // Closed, the strip is the bar whatever the setting says, so flipping capture while
    // closed is not something the layout owner needs to animate.
    @Test func togglingPreviewsWhileClosedIsSilent() {
        let view = ThumbnailStripView()
        let recorder = StripRecorder()
        view.delegate = recorder
        view.apply(state: threeSpaceState())

        view.showsPreviews = true
        #expect(recorder.heightChanges == 0)
        #expect(view.preferredHeight == ThumbnailStripView.barHeight)
    }

    @Test func renderEmptyCollapses() {
        let view = ThumbnailStripView()
        view.showsPreviews = true
        view.apply(state: threeSpaceState())
        view.setExpanded(true)
        view.renderEmpty()

        #expect(view.isExpanded == false)
        #expect(view.preferredHeight == ThumbnailStripView.barHeight)
        #expect(view.userSpaceCount == 0)
    }

    // MARK: - How many Desktops the pill row holds at rest
    //
    // The reason the pill shrank and the strip went edge-to-edge. On a Mac with seven
    // Desktops the row used to overflow, so reaching D7 pushed D1 out of sight -- the strip
    // was a scrollbar you had to scroll to read. These assert the property, not the numbers:
    // they compose the real geometry from the real constants, so any later change to the
    // pill, the spacing, the lead column, or the strip's insets has to keep seven visible or
    // fail here.

    // Portrait width of the phones this ships to, with the strip flush to both edges.
    private static func pillRow(spaces: Int, screenWidth: CGFloat) -> ThumbnailStripGeometry {
        ThumbnailStripGeometry(
            tileCount: spaces,
            tileWidth: ThumbnailStripView.compactTileWidth,
            tileHeight: ThumbnailStripView.compactRowHeight,
            spacing: ThumbnailStripView.defaultTileSpacing,
            viewportWidth: screenWidth
                - ThumbnailStripView.leadColumnWidth
                - ThumbnailStripView.leadColumnGap
        )
    }

    @Test func sevenDesktopsFitAtRestOnAStandardPhone() {
        // iPhone 15/16 portrait, the narrowest common width.
        let row = Self.pillRow(spaces: 7, screenWidth: 393)
        #expect(row.maxOffsetX == 0)
        // Fitting means centred, not merely reachable: the row is inset to span the viewport.
        #expect(row.sectionInset > 0)
        // And D1 is the first thing in view, which is the whole point.
        #expect(row.restingOffsetX(for: 0) == 0)
        #expect(row.restingOffsetX(for: 6) == 0)
    }

    @Test func sevenDesktopsFitAtRestOnTheSmallestSupportedPhone() {
        #expect(Self.pillRow(spaces: 7, screenWidth: 375).maxOffsetX == 0)
    }

    // Eight is past the row's honest capacity at this pill width, so it scrolls. Asserted so
    // the boundary is a decision on record rather than something rediscovered on a device.
    @Test func eightDesktopsOverflowAndScroll() {
        let row = Self.pillRow(spaces: 8, screenWidth: 393)
        #expect(row.maxOffsetX > 0)
        #expect(row.sectionInset == 0)
    }

    // Preview tiles are 88pt and were never going to fit seven. The strip is honest about it
    // by scrolling; nothing above claims otherwise for this mode.
    @Test func previewTilesStillOverflowAtSevenDesktops() {
        let row = ThumbnailStripGeometry(
            tileCount: 7,
            tileWidth: ThumbnailStripView.tileWidth,
            tileHeight: ThumbnailStripView.previewRowHeight,
            spacing: ThumbnailStripView.defaultTileSpacing,
            viewportWidth: 393
                - ThumbnailStripView.leadColumnWidth
                - ThumbnailStripView.leadColumnGap
        )
        #expect(row.maxOffsetX > 0)
    }
}

@MainActor
private final class StripRecorder: ThumbnailStripViewDelegate {
    private(set) var events: [NormalizedInput] = []
    private(set) var heightChanges = 0
    private(set) var toggles: [Bool] = []
    func thumbnailStrip(_ view: ThumbnailStripView, didTapStepDelta delta: Int) {}
    func thumbnailStrip(_ view: ThumbnailStripView, didLongPressSpaceId spaceId: UInt64) {}
    func thumbnailStrip(_ view: ThumbnailStripView, didProduce input: NormalizedInput) {
        events.append(input)
    }
    func thumbnailStripDidChangePreferredHeight(_ view: ThumbnailStripView) {
        heightChanges += 1
    }
    func thumbnailStripDidToggleExpansion(_ view: ThumbnailStripView) {
        toggles.append(view.isExpanded)
    }
}
