import Foundation
import Testing
import UIKit

@MainActor
struct SpacesDotsViewTests {
    // MARK: - Continuous gesture emission

    @Test func panBeganEmitsBeganFrameWithZeroProgress() {
        let recorder = DotsRecorder()
        let view = SpacesDotsView()
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
        let recorder = DotsRecorder()
        let view = SpacesDotsView()
        view.delegate = recorder
        view.useMacOSDirection = true  // raw-sign pass-through for layout assertions

        // Began captures the bandWidth used for normalisation.
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
            // 100 / 200 = 0.5.
            #expect(progress == 0.5)
            #expect(velocityX == 800)
        } else {
            Issue.record("expected switchSpaceGesture changed")
        }
    }

    @Test func progressClampsToSignedUnitInterval() {
        // A long flick past the band edge produces translation >
        // bandWidth. Dock treats progress > 1 as "swipe done"; we cap
        // at ±1 so the wire payload is stable.
        let recorder = DotsRecorder()
        let view = SpacesDotsView()
        view.delegate = recorder
        view.useMacOSDirection = true  // raw-sign pass-through for clamp assertion

        view.processGesture(state: .began, translation: .zero, velocity: .zero, bandWidth: 200)
        view.processGesture(
            state: .changed,
            translation: CGPoint(x: 500, y: 0),  // 2.5x bandWidth
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
        let recorder = DotsRecorder()
        let view = SpacesDotsView()
        view.delegate = recorder
        view.useMacOSDirection = true  // raw-sign pass-through

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
        let recorder = DotsRecorder()
        let view = SpacesDotsView()
        view.delegate = recorder
        view.useMacOSDirection = true  // raw-sign pass-through

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
            #expect(progress == 0.75)  // 150/200
            #expect(velocityX == 1600)
        } else {
            Issue.record("expected switchSpaceGesture ended")
        }
    }

    @Test func defaultDirectionFlipsSignFromNative() {
        // Default (useMacOSDirection == false) inverts the wire-level
        // sign so finger-right on the band switches to the Space on
        // the left (scrollbar-reading feel). The flip happens at emit
        // time on both progress and velocity; the host never sees the
        // user preference.
        let recorder = DotsRecorder()
        let view = SpacesDotsView()
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
            #expect(progress < 0)  // raw 0.4 -> -0.4
            #expect(velocityX < 0)  // raw 1200 -> -1200
        } else {
            Issue.record("expected switchSpaceGesture changed")
        }
    }

    @Test func useMacOSDirectionPassesSignThrough() {
        // Toggle ON = use macOS-native direction. Sign is unchanged.
        let recorder = DotsRecorder()
        let view = SpacesDotsView()
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
            #expect(progress > 0)  // raw 0.4 stays +0.4
            #expect(velocityX > 0)
        } else {
            Issue.record("expected switchSpaceGesture changed")
        }
    }

    @Test func panCancelledEmitsCancelledFrame() {
        let recorder = DotsRecorder()
        let view = SpacesDotsView()
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
        // Dock drops .changed frames with progress=0 (reads as "no
        // gesture in progress"); the view substitutes FLT_TRUE_MIN so
        // the direction-required guard still passes through.
        let recorder = DotsRecorder()
        let view = SpacesDotsView()
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

    // MARK: - Dot rendering from DesktopState

    @Test func applyStateRendersOneDotPerUserSpaceOnActiveDisplay() {
        let view = SpacesDotsView()
        view.apply(state: DesktopState(
            displays: [DisplayMetadata(id: "DISP-1")],
            spaces: [
                SpaceMetadata(id: 100, displayId: "DISP-1", index: 0, type: 0),
                SpaceMetadata(id: 200, displayId: "DISP-1", index: 1, type: 0),
                SpaceMetadata(id: 300, displayId: "DISP-1", index: 2, type: 0),
            ],
            activeDisplayId: "DISP-1",
            activeSpaceId: 200
        ))
        #expect(view.renderedDotCount == 3)
        #expect(view.renderedActiveIndex == 1)
        #expect(view.isHidden == false)
    }

    @Test func applyStateSkipsFullscreenSpaces() {
        let view = SpacesDotsView()
        view.apply(state: DesktopState(
            displays: [DisplayMetadata(id: "DISP-1")],
            spaces: [
                SpaceMetadata(id: 100, displayId: "DISP-1", index: 0, type: 0),
                SpaceMetadata(id: 150, displayId: "DISP-1", index: nil, type: 4),
                SpaceMetadata(id: 200, displayId: "DISP-1", index: 1, type: 0),
            ],
            activeDisplayId: "DISP-1",
            activeSpaceId: 100
        ))
        #expect(view.renderedDotCount == 2)
        #expect(view.renderedActiveIndex == 0)
    }

    @Test func applyStateOnlyCountsActiveDisplaySpaces() {
        let view = SpacesDotsView()
        view.apply(state: DesktopState(
            displays: [
                DisplayMetadata(id: "DISP-1"),
                DisplayMetadata(id: "DISP-2"),
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
        #expect(view.renderedDotCount == 2)
        #expect(view.renderedActiveIndex == 1)
    }

    @Test func applyStateHidesViewWhenOnlyOneUserSpaceExists() {
        let view = SpacesDotsView()
        view.apply(state: DesktopState(
            displays: [DisplayMetadata(id: "DISP-1")],
            spaces: [
                SpaceMetadata(id: 100, displayId: "DISP-1", index: 0, type: 0),
            ],
            activeDisplayId: "DISP-1",
            activeSpaceId: 100
        ))
        #expect(view.renderedDotCount == 1)
        #expect(view.isHidden == true)
    }

    @Test func applyStateHidesViewWhenNoActiveDisplay() {
        let view = SpacesDotsView()
        view.apply(state: DesktopState(
            displays: [],
            spaces: [],
            activeDisplayId: nil,
            activeSpaceId: nil
        ))
        #expect(view.renderedDotCount == 0)
        #expect(view.isHidden == true)
    }
}

@MainActor
private final class DotsRecorder: SpacesDotsViewDelegate {
    private(set) var events: [NormalizedInput] = []
    func spacesDots(_ view: SpacesDotsView, didProduce input: NormalizedInput) {
        events.append(input)
    }
}
