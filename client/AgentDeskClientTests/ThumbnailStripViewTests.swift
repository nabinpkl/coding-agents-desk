import Foundation
import Testing
import UIKit

@MainActor
struct ThumbnailStripViewTests {
    // MARK: - Continuous gesture emission
    //
    // R25 merged the dots band's swipe state machine into
    // ThumbnailStripView. These tests mirror the retired
    // SpacesDotsViewTests so the host contract (one
    // .switchSpaceGesture frame per UIKit pan callback, with the same
    // progress / velocity / direction-flip semantics) doesn't drift.

    @Test func panBeganEmitsBeganFrameWithZeroProgress() {
        let recorder = StripRecorder()
        let view = ThumbnailStripView()
        view.delegate = recorder

        view.processGesture(state: .began, translation: .zero, velocity: .zero, bandWidth: 320)

        #expect(recorder.events.count == 1)
        if case let .switchSpaceGesture(phase, progress, velocityX) = recorder.events[0] {
            #expect(phase == .began)
            #expect(progress == 0)
            #expect(velocityX == 0)
        } else {
            Issue.record("expected switchSpaceGesture began")
        }
    }

    @Test func panChangedEmitsChangedFrameWithProgressNormalisedToBandWidth() {
        let recorder = StripRecorder()
        let view = ThumbnailStripView()
        view.delegate = recorder
        view.useMacOSDirection = true  // raw-sign pass-through for layout assertions

        view.processGesture(state: .began, translation: .zero, velocity: .zero, bandWidth: 200)
        view.processGesture(
            state: .changed,
            translation: CGPoint(x: 100, y: 0),
            velocity: CGPoint(x: 800, y: 0),
            bandWidth: 200
        )

        #expect(recorder.events.count == 2)
        if case let .switchSpaceGesture(phase, progress, velocityX) = recorder.events[1] {
            #expect(phase == .changed)
            #expect(progress == 0.5)
            #expect(velocityX == 800)
        } else {
            Issue.record("expected switchSpaceGesture changed")
        }
    }

    @Test func progressClampsToSignedUnitInterval() {
        let recorder = StripRecorder()
        let view = ThumbnailStripView()
        view.delegate = recorder
        view.useMacOSDirection = true

        view.processGesture(state: .began, translation: .zero, velocity: .zero, bandWidth: 200)
        view.processGesture(
            state: .changed,
            translation: CGPoint(x: 500, y: 0),
            velocity: CGPoint(x: 2000, y: 0),
            bandWidth: 200
        )

        if case let .switchSpaceGesture(_, progress, _) = recorder.events[1] {
            #expect(progress == 1.0)
        } else {
            Issue.record("expected switchSpaceGesture changed")
        }
    }

    @Test func leftwardDragEmitsNegativeProgressAndVelocity() {
        let recorder = StripRecorder()
        let view = ThumbnailStripView()
        view.delegate = recorder
        view.useMacOSDirection = true

        view.processGesture(state: .began, translation: .zero, velocity: .zero, bandWidth: 200)
        view.processGesture(
            state: .changed,
            translation: CGPoint(x: -80, y: 0),
            velocity: CGPoint(x: -1200, y: 0),
            bandWidth: 200
        )

        if case let .switchSpaceGesture(_, progress, velocityX) = recorder.events[1] {
            #expect(progress < 0)
            #expect(velocityX < 0)
        } else {
            Issue.record("expected switchSpaceGesture changed")
        }
    }

    @Test func panEndedEmitsEndedFrameWithTerminalProgressAndVelocity() {
        let recorder = StripRecorder()
        let view = ThumbnailStripView()
        view.delegate = recorder
        view.useMacOSDirection = true

        view.processGesture(state: .began, translation: .zero, velocity: .zero, bandWidth: 200)
        view.processGesture(
            state: .changed,
            translation: CGPoint(x: 120, y: 0),
            velocity: CGPoint(x: 1400, y: 0),
            bandWidth: 200
        )
        view.processGesture(
            state: .ended,
            translation: CGPoint(x: 150, y: 0),
            velocity: CGPoint(x: 1600, y: 0),
            bandWidth: 200
        )

        #expect(recorder.events.count == 3)
        if case let .switchSpaceGesture(phase, progress, velocityX) = recorder.events[2] {
            #expect(phase == .ended)
            #expect(progress == 0.75)
            #expect(velocityX == 1600)
        } else {
            Issue.record("expected switchSpaceGesture ended")
        }
    }

    @Test func defaultDirectionFlipsSignFromNative() {
        let recorder = StripRecorder()
        let view = ThumbnailStripView()
        view.delegate = recorder
        // view.useMacOSDirection stays at its default `false`.

        view.processGesture(state: .began, translation: .zero, velocity: .zero, bandWidth: 200)
        view.processGesture(
            state: .changed,
            translation: CGPoint(x: 80, y: 0),
            velocity: CGPoint(x: 1200, y: 0),
            bandWidth: 200
        )

        if case let .switchSpaceGesture(_, progress, velocityX) = recorder.events[1] {
            #expect(progress < 0)
            #expect(velocityX < 0)
        } else {
            Issue.record("expected switchSpaceGesture changed")
        }
    }

    @Test func useMacOSDirectionPassesSignThrough() {
        let recorder = StripRecorder()
        let view = ThumbnailStripView()
        view.delegate = recorder
        view.useMacOSDirection = true

        view.processGesture(state: .began, translation: .zero, velocity: .zero, bandWidth: 200)
        view.processGesture(
            state: .changed,
            translation: CGPoint(x: 80, y: 0),
            velocity: CGPoint(x: 1200, y: 0),
            bandWidth: 200
        )

        if case let .switchSpaceGesture(_, progress, velocityX) = recorder.events[1] {
            #expect(progress > 0)
            #expect(velocityX > 0)
        } else {
            Issue.record("expected switchSpaceGesture changed")
        }
    }

    @Test func panCancelledEmitsCancelledFrame() {
        let recorder = StripRecorder()
        let view = ThumbnailStripView()
        view.delegate = recorder

        view.processGesture(state: .began, translation: .zero, velocity: .zero, bandWidth: 200)
        view.processGesture(state: .cancelled, translation: CGPoint(x: 40, y: 0), velocity: .zero, bandWidth: 200)

        if case let .switchSpaceGesture(phase, _, _) = recorder.events.last {
            #expect(phase == .cancelled)
        } else {
            Issue.record("expected switchSpaceGesture cancelled")
        }
    }

    @Test func zeroProgressOnChangedNudgesAwayFromExactZero() {
        let recorder = StripRecorder()
        let view = ThumbnailStripView()
        view.delegate = recorder

        view.processGesture(state: .began, translation: .zero, velocity: .zero, bandWidth: 200)
        view.processGesture(state: .changed, translation: .zero, velocity: .zero, bandWidth: 200)

        if case let .switchSpaceGesture(phase, progress, _) = recorder.events[1] {
            #expect(phase == .changed)
            #expect(progress != 0)
            #expect(abs(progress) <= Float.leastNormalMagnitude)
        } else {
            Issue.record("expected switchSpaceGesture changed")
        }
    }

    // MARK: - Tile rendering from DesktopState
    //
    // The strip's visibility is owned by PairingViewController
    // (refreshThumbnailStripVisibility) post-R25, so these tests
    // assert userSpaceCount and activeIndex rather than the view's
    // own isHidden.

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
