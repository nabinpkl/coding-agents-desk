import CoreGraphics
import Foundation
import Testing

@MainActor
struct InputDispatcherTests {
    @Test func cursorMovePostsOneMouseMovedEventAtOffset() {
        let recorder = EventRecorder()
        let dispatcher = InputDispatcher(
            eventPoster: { recorder.record($0) },
            isTrusted: { true },
            locationProvider: { CGPoint(x: 100, y: 200) }
        )

        dispatcher.performDispatch(.cursorMove(dx: 10, dy: -20))

        #expect(recorder.events.count == 1)
        #expect(recorder.events[0].type == .mouseMoved)
        #expect(recorder.events[0].location == CGPoint(x: 110, y: 180))
    }

    @Test func cursorMoveClampsAtDisplayEdge() {
        let recorder = EventRecorder()
        let dispatcher = InputDispatcher(
            eventPoster: { recorder.record($0) },
            isTrusted: { true },
            locationProvider: { CGPoint(x: 1490, y: 500) },
            displayBoundsProvider: { CGRect(x: 0, y: 0, width: 1500, height: 1000) }
        )

        // Requesting +100 in X from x=1490 with maxX=1499 should land on
        // (1499, 500), the last in-bounds pixel, not (1590, 500).
        dispatcher.performDispatch(.cursorMove(dx: 100, dy: 0))

        #expect(recorder.events.count == 1)
        #expect(recorder.events[0].location == CGPoint(x: 1499, y: 500))
    }

    @Test func leftClickPostsMouseDownThenMouseUpAtCurrentLocation() {
        let recorder = EventRecorder()
        let dispatcher = InputDispatcher(
            eventPoster: { recorder.record($0) },
            isTrusted: { true },
            locationProvider: { CGPoint(x: 500, y: 400) }
        )

        dispatcher.performDispatch(.click(button: .left))

        #expect(recorder.events.count == 2)
        #expect(recorder.events[0].type == .leftMouseDown)
        #expect(recorder.events[0].location == CGPoint(x: 500, y: 400))
        #expect(recorder.events[1].type == .leftMouseUp)
        #expect(recorder.events[1].location == CGPoint(x: 500, y: 400))
    }

    @Test func untrustedProcessDropsEvents() {
        let recorder = EventRecorder()
        let dispatcher = InputDispatcher(
            eventPoster: { recorder.record($0) },
            isTrusted: { false },
            locationProvider: { .zero }
        )

        dispatcher.performDispatch(.cursorMove(dx: 10, dy: 10))
        dispatcher.performDispatch(.click(button: .left))

        #expect(recorder.events.isEmpty)
    }

    @Test func cursorMoveClampsToDisplayBounds() {
        let recorder = EventRecorder()
        let dispatcher = InputDispatcher(
            eventPoster: { recorder.record($0) },
            isTrusted: { true },
            locationProvider: { CGPoint(x: 1000, y: 500) },
            displayBoundsProvider: { CGRect(x: 0, y: 0, width: 1500, height: 1000) }
        )

        dispatcher.performDispatch(.cursorMove(dx: 2000, dy: 2000))
        dispatcher.performDispatch(.cursorMove(dx: -5000, dy: -5000))

        #expect(recorder.events.count == 2)
        #expect(recorder.events[0].location == CGPoint(x: 1499, y: 999))
        #expect(recorder.events[1].location == CGPoint(x: 0, y: 0))
    }

    @Test func scrollPostsScrollWheelEventWithDyOnWheel1() {
        let recorder = EventRecorder()
        let dispatcher = InputDispatcher(
            eventPoster: { recorder.record($0) },
            isTrusted: { true },
            locationProvider: { .zero }
        )

        dispatcher.performDispatch(.scroll(dx: 0, dy: 30, phase: .changed))

        #expect(recorder.events.count == 1)
        #expect(recorder.events[0].type == .scrollWheel)
        // Pixel-units scroll wheel deltas live on wheel1 (vertical). dy
        // passes through unchanged: iPhone finger-up emits -dy which
        // maps to -wheel1 (document moves forward, content visibly up).
        let pixelDelta = recorder.events[0].getIntegerValueField(.scrollWheelEventPointDeltaAxis1)
        #expect(pixelDelta == 30)
    }

    @Test func subPixelScrollsAccumulateUntilEmitting() {
        let recorder = EventRecorder()
        let dispatcher = InputDispatcher(
            eventPoster: { recorder.record($0) },
            isTrusted: { true },
            locationProvider: { .zero }
        )

        // Four 0.4 dy ticks: 0.4, 0.8, 1.2 -> emit 1, remainder 0.2.
        dispatcher.performDispatch(.scroll(dx: 0, dy: 0.4, phase: .changed))
        dispatcher.performDispatch(.scroll(dx: 0, dy: 0.4, phase: .changed))
        dispatcher.performDispatch(.scroll(dx: 0, dy: 0.4, phase: .changed))

        #expect(recorder.events.count == 1)
        let delta = recorder.events[0].getIntegerValueField(.scrollWheelEventPointDeltaAxis1)
        #expect(delta == 1)
    }

    @Test func scrollPhaseFieldsAreSetOnCGEvent() {
        let recorder = EventRecorder()
        let dispatcher = InputDispatcher(
            eventPoster: { recorder.record($0) },
            isTrusted: { true },
            locationProvider: { .zero }
        )

        dispatcher.performDispatch(.scroll(dx: 0, dy: 5, phase: .began))
        dispatcher.performDispatch(.scroll(dx: 0, dy: 5, phase: .changed))
        dispatcher.performDispatch(.scroll(dx: 0, dy: 0, phase: .ended))
        dispatcher.performDispatch(.scroll(dx: 0, dy: 3, phase: .momentumBegan))
        dispatcher.performDispatch(.scroll(dx: 0, dy: 2, phase: .momentumChanged))
        dispatcher.performDispatch(.scroll(dx: 0, dy: 0, phase: .momentumEnded))

        #expect(recorder.events.count == 6)
        // ScrollPhase: began=1, changed=2, ended=4; MomentumPhase=0 on drag.
        #expect(recorder.events[0].getIntegerValueField(.scrollWheelEventScrollPhase) == 1)
        #expect(recorder.events[0].getIntegerValueField(.scrollWheelEventMomentumPhase) == 0)
        #expect(recorder.events[1].getIntegerValueField(.scrollWheelEventScrollPhase) == 2)
        #expect(recorder.events[2].getIntegerValueField(.scrollWheelEventScrollPhase) == 4)
        // Momentum phase events leave ScrollPhase=0; MomentumPhase: begin=1, continue=2, end=3.
        #expect(recorder.events[3].getIntegerValueField(.scrollWheelEventScrollPhase) == 0)
        #expect(recorder.events[3].getIntegerValueField(.scrollWheelEventMomentumPhase) == 1)
        #expect(recorder.events[4].getIntegerValueField(.scrollWheelEventMomentumPhase) == 2)
        #expect(recorder.events[5].getIntegerValueField(.scrollWheelEventMomentumPhase) == 3)
    }

    @Test func scrollDelimiterPhasesEmitEvenWithZeroDelta() {
        let recorder = EventRecorder()
        let dispatcher = InputDispatcher(
            eventPoster: { recorder.record($0) },
            isTrusted: { true },
            locationProvider: { .zero }
        )

        // Zero-delta changed/momentumChanged should NOT emit (continuous phases),
        // but ended/momentumEnded must emit so macOS sees the phase transition.
        dispatcher.performDispatch(.scroll(dx: 0, dy: 0, phase: .changed))
        dispatcher.performDispatch(.scroll(dx: 0, dy: 0, phase: .ended))
        dispatcher.performDispatch(.scroll(dx: 0, dy: 0, phase: .momentumChanged))
        dispatcher.performDispatch(.scroll(dx: 0, dy: 0, phase: .momentumEnded))

        #expect(recorder.events.count == 2)
        #expect(recorder.events[0].getIntegerValueField(.scrollWheelEventScrollPhase) == 4)
        #expect(recorder.events[1].getIntegerValueField(.scrollWheelEventMomentumPhase) == 3)
    }

    @Test func rightClickPostsRightMouseDownThenRightMouseUpAtCurrentLocation() {
        let recorder = EventRecorder()
        let dispatcher = InputDispatcher(
            eventPoster: { recorder.record($0) },
            isTrusted: { true },
            locationProvider: { CGPoint(x: 500, y: 400) }
        )

        dispatcher.performDispatch(.click(button: .right))

        #expect(recorder.events.count == 2)
        #expect(recorder.events[0].type == .rightMouseDown)
        #expect(recorder.events[0].location == CGPoint(x: 500, y: 400))
        #expect(recorder.events[1].type == .rightMouseUp)
        #expect(recorder.events[1].location == CGPoint(x: 500, y: 400))
    }

    @Test func dragStartPostsLeftMouseDownAtCurrentLocation() {
        let recorder = EventRecorder()
        let dispatcher = InputDispatcher(
            eventPoster: { recorder.record($0) },
            isTrusted: { true },
            locationProvider: { CGPoint(x: 100, y: 100) }
        )

        dispatcher.performDispatch(.dragStart)

        #expect(recorder.events.count == 1)
        #expect(recorder.events[0].type == .leftMouseDown)
        #expect(recorder.events[0].location == CGPoint(x: 100, y: 100))
    }

    @Test func dragEndPostsLeftMouseUpAtCurrentLocation() {
        let recorder = EventRecorder()
        let dispatcher = InputDispatcher(
            eventPoster: { recorder.record($0) },
            isTrusted: { true },
            locationProvider: { CGPoint(x: 200, y: 200) }
        )

        dispatcher.performDispatch(.dragStart)
        dispatcher.performDispatch(.dragEnd)

        #expect(recorder.events.count == 2)
        #expect(recorder.events[0].type == .leftMouseDown)
        #expect(recorder.events[1].type == .leftMouseUp)
        #expect(recorder.events[1].location == CGPoint(x: 200, y: 200))
    }

    @Test func cursorMoveDuringDragPromotesToLeftMouseDragged() {
        let recorder = EventRecorder()
        let dispatcher = InputDispatcher(
            eventPoster: { recorder.record($0) },
            isTrusted: { true },
            locationProvider: { CGPoint(x: 100, y: 100) }
        )

        dispatcher.performDispatch(.dragStart)
        dispatcher.performDispatch(.cursorMove(dx: 10, dy: 10))
        dispatcher.performDispatch(.cursorMove(dx: 5, dy: 5))
        dispatcher.performDispatch(.dragEnd)

        #expect(recorder.events.count == 4)
        #expect(recorder.events[0].type == .leftMouseDown)
        #expect(recorder.events[1].type == .leftMouseDragged)
        #expect(recorder.events[2].type == .leftMouseDragged)
        #expect(recorder.events[3].type == .leftMouseUp)
    }

    @Test func cursorMoveAfterDragEndRevertsToMouseMoved() {
        let recorder = EventRecorder()
        let dispatcher = InputDispatcher(
            eventPoster: { recorder.record($0) },
            isTrusted: { true },
            locationProvider: { CGPoint(x: 100, y: 100) }
        )

        dispatcher.performDispatch(.dragStart)
        dispatcher.performDispatch(.dragEnd)
        dispatcher.performDispatch(.cursorMove(dx: 10, dy: 10))

        #expect(recorder.events.count == 3)
        #expect(recorder.events[2].type == .mouseMoved)
    }

    @Test func outOfScopeInputsAreNoOps() {
        let recorder = EventRecorder()
        let dispatcher = InputDispatcher(
            eventPoster: { recorder.record($0) },
            isTrusted: { true },
            locationProvider: { .zero }
        )

        dispatcher.performDispatch(.click(button: .double))

        #expect(recorder.events.isEmpty)
    }
}

private final class EventRecorder {
    private(set) var events: [CGEvent] = []
    func record(_ event: CGEvent) {
        events.append(event)
    }
}
