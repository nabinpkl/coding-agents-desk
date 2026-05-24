import Foundation
import Testing
import UIKit

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

    @Test func applyStateOnlyCountsActiveDisplaySpaces() {
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
            activeSpaceId: 200
        ))
        #expect(view.userSpaceCount == 2)
        #expect(view.activeIndex == 1)
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
}

@MainActor
private final class StripRecorder: ThumbnailStripViewDelegate {
    private(set) var events: [NormalizedInput] = []
    func thumbnailStrip(_ view: ThumbnailStripView, didTapStepDelta delta: Int) {}
    func thumbnailStrip(_ view: ThumbnailStripView, didLongPressSpaceId spaceId: UInt64) {}
    func thumbnailStrip(_ view: ThumbnailStripView, didProduce input: NormalizedInput) {
        events.append(input)
    }
}
