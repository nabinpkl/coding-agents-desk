import Foundation
import Testing
import UIKit

@MainActor
struct SpacesStripViewTests {
    @Test func horizontalRightwardSwipeAboveThresholdEmitsRightSwitch() {
        let recorder = StripRecorder()
        let strip = SpacesStripView()
        strip.delegate = recorder

        strip.processSwipe(state: .began, translation: .zero)
        strip.processSwipe(state: .changed, translation: CGPoint(x: 80, y: 10))

        #expect(recorder.events == [.switchSpace(direction: .right)])
    }

    @Test func horizontalLeftwardSwipeAboveThresholdEmitsLeftSwitch() {
        let recorder = StripRecorder()
        let strip = SpacesStripView()
        strip.delegate = recorder

        strip.processSwipe(state: .began, translation: .zero)
        strip.processSwipe(state: .changed, translation: CGPoint(x: -80, y: -10))

        #expect(recorder.events == [.switchSpace(direction: .left)])
    }

    @Test func swipeBelowHorizontalThresholdEmitsNothing() {
        let recorder = StripRecorder()
        let strip = SpacesStripView()
        strip.delegate = recorder

        strip.processSwipe(state: .began, translation: .zero)
        strip.processSwipe(state: .changed, translation: CGPoint(x: 40, y: 5))
        strip.processSwipe(state: .ended, translation: CGPoint(x: 40, y: 5))

        #expect(recorder.events.isEmpty)
    }

    @Test func verticallyDominantSwipeEmitsNothing() {
        // A diagonal where vertical movement dominates (e.g. user
        // accidentally caught the strip while reaching for the trackpad)
        // must not switch Spaces.
        let recorder = StripRecorder()
        let strip = SpacesStripView()
        strip.delegate = recorder

        strip.processSwipe(state: .began, translation: .zero)
        strip.processSwipe(state: .changed, translation: CGPoint(x: 70, y: 80))

        #expect(recorder.events.isEmpty)
    }

    @Test func singleGestureFiresAtMostOnceEvenIfThresholdCrossedRepeatedly() {
        // Once the threshold is crossed, the gesture has "spent" its
        // emission for the current touch. Further .changed callbacks
        // (the finger keeps dragging past the trigger) must not produce
        // a stream of switches.
        let recorder = StripRecorder()
        let strip = SpacesStripView()
        strip.delegate = recorder

        strip.processSwipe(state: .began, translation: .zero)
        strip.processSwipe(state: .changed, translation: CGPoint(x: 80, y: 0))
        strip.processSwipe(state: .changed, translation: CGPoint(x: 150, y: 0))
        strip.processSwipe(state: .changed, translation: CGPoint(x: 220, y: 0))
        strip.processSwipe(state: .ended, translation: CGPoint(x: 220, y: 0))

        #expect(recorder.events == [.switchSpace(direction: .right)])
    }

    @Test func secondGestureAfterEndCanFireAgain() {
        let recorder = StripRecorder()
        let strip = SpacesStripView()
        strip.delegate = recorder

        strip.processSwipe(state: .began, translation: .zero)
        strip.processSwipe(state: .changed, translation: CGPoint(x: 80, y: 0))
        strip.processSwipe(state: .ended, translation: CGPoint(x: 80, y: 0))

        strip.processSwipe(state: .began, translation: .zero)
        strip.processSwipe(state: .changed, translation: CGPoint(x: -80, y: 0))

        #expect(recorder.events == [
            .switchSpace(direction: .right),
            .switchSpace(direction: .left)
        ])
    }

    @Test func exactThresholdWithDominanceTriggers() {
        // At exactly the 60pt threshold the swipe should still fire so the
        // boundary user (a precise finger drag landing right on the
        // threshold) doesn't get silent failure.
        let recorder = StripRecorder()
        let strip = SpacesStripView()
        strip.delegate = recorder

        strip.processSwipe(state: .began, translation: .zero)
        strip.processSwipe(state: .changed, translation: CGPoint(x: 60, y: 0))

        #expect(recorder.events == [.switchSpace(direction: .right)])
    }
}

@MainActor
private final class StripRecorder: SpacesStripViewDelegate {
    private(set) var events: [NormalizedInput] = []
    func spacesStrip(_ view: SpacesStripView, didProduce input: NormalizedInput) {
        events.append(input)
    }
}
