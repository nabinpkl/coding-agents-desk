import Foundation
import Testing
import UIKit

@MainActor
struct SpacesDotsViewTests {
    // MARK: - Swipe state machine

    @Test func horizontalRightwardSwipeAboveThresholdEmitsRightSwitch() {
        let recorder = DotsRecorder()
        let view = SpacesDotsView()
        view.delegate = recorder

        view.processSwipe(state: .began, translation: .zero)
        view.processSwipe(state: .changed, translation: CGPoint(x: 80, y: 10))

        #expect(recorder.events == [.switchSpace(direction: .right)])
    }

    @Test func horizontalLeftwardSwipeAboveThresholdEmitsLeftSwitch() {
        let recorder = DotsRecorder()
        let view = SpacesDotsView()
        view.delegate = recorder

        view.processSwipe(state: .began, translation: .zero)
        view.processSwipe(state: .changed, translation: CGPoint(x: -80, y: -10))

        #expect(recorder.events == [.switchSpace(direction: .left)])
    }

    @Test func swipeBelowHorizontalThresholdEmitsNothing() {
        let recorder = DotsRecorder()
        let view = SpacesDotsView()
        view.delegate = recorder

        view.processSwipe(state: .began, translation: .zero)
        view.processSwipe(state: .changed, translation: CGPoint(x: 40, y: 5))
        view.processSwipe(state: .ended, translation: CGPoint(x: 40, y: 5))

        #expect(recorder.events.isEmpty)
    }

    @Test func verticallyDominantSwipeEmitsNothing() {
        let recorder = DotsRecorder()
        let view = SpacesDotsView()
        view.delegate = recorder

        view.processSwipe(state: .began, translation: .zero)
        view.processSwipe(state: .changed, translation: CGPoint(x: 70, y: 80))

        #expect(recorder.events.isEmpty)
    }

    @Test func singleGestureFiresAtMostOnce() {
        let recorder = DotsRecorder()
        let view = SpacesDotsView()
        view.delegate = recorder

        view.processSwipe(state: .began, translation: .zero)
        view.processSwipe(state: .changed, translation: CGPoint(x: 80, y: 0))
        view.processSwipe(state: .changed, translation: CGPoint(x: 150, y: 0))
        view.processSwipe(state: .ended, translation: CGPoint(x: 150, y: 0))

        #expect(recorder.events == [.switchSpace(direction: .right)])
    }

    @Test func secondGestureAfterEndCanFireAgain() {
        let recorder = DotsRecorder()
        let view = SpacesDotsView()
        view.delegate = recorder

        view.processSwipe(state: .began, translation: .zero)
        view.processSwipe(state: .changed, translation: CGPoint(x: 80, y: 0))
        view.processSwipe(state: .ended, translation: CGPoint(x: 80, y: 0))

        view.processSwipe(state: .began, translation: .zero)
        view.processSwipe(state: .changed, translation: CGPoint(x: -80, y: 0))

        #expect(recorder.events == [
            .switchSpace(direction: .right),
            .switchSpace(direction: .left)
        ])
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
        // Fullscreen-app Spaces (type=4) are not in the dot carousel
        // because Mission Control's left/right navigation skips them.
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
        // No carousel to drive; band stays hidden so the user does not
        // see a lone dot doing nothing.
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
        // Defensive: a malformed DesktopState (no active display) keeps
        // the band hidden rather than rendering with a default 0 index.
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
