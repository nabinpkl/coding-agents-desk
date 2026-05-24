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

        dispatcher.dispatch(.cursorMove(dx: 10, dy: -20))

        #expect(recorder.events.count == 1)
        #expect(recorder.events[0].type == .mouseMoved)
        #expect(recorder.events[0].location == CGPoint(x: 110, y: 180))
    }

    @Test func leftClickPostsMouseDownThenMouseUpAtCurrentLocation() {
        let recorder = EventRecorder()
        let dispatcher = InputDispatcher(
            eventPoster: { recorder.record($0) },
            isTrusted: { true },
            locationProvider: { CGPoint(x: 500, y: 400) }
        )

        dispatcher.dispatch(.click(button: .left))

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

        dispatcher.dispatch(.cursorMove(dx: 10, dy: 10))
        dispatcher.dispatch(.click(button: .left))

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

        dispatcher.dispatch(.cursorMove(dx: 2000, dy: 2000))
        dispatcher.dispatch(.cursorMove(dx: -5000, dy: -5000))

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

        dispatcher.dispatch(.scroll(dx: 0, dy: 30))

        #expect(recorder.events.count == 1)
        #expect(recorder.events[0].type == .scrollWheel)
        // Pixel-units scroll wheel deltas live on wheel1 (vertical).
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

        // Four 0.4 dy ticks: 0.4, 0.8, 1.2 -> emit 1, 0.6.
        dispatcher.dispatch(.scroll(dx: 0, dy: 0.4))
        dispatcher.dispatch(.scroll(dx: 0, dy: 0.4))
        dispatcher.dispatch(.scroll(dx: 0, dy: 0.4))

        #expect(recorder.events.count == 1)
        let delta = recorder.events[0].getIntegerValueField(.scrollWheelEventPointDeltaAxis1)
        #expect(delta == 1)
    }

    @Test func outOfScopeInputsAreNoOps() {
        let recorder = EventRecorder()
        let dispatcher = InputDispatcher(
            eventPoster: { recorder.record($0) },
            isTrusted: { true },
            locationProvider: { .zero }
        )

        dispatcher.dispatch(.dragStart)
        dispatcher.dispatch(.dragEnd)
        dispatcher.dispatch(.click(button: .right))
        dispatcher.dispatch(.click(button: .double))

        #expect(recorder.events.isEmpty)
    }
}

private final class EventRecorder {
    private(set) var events: [CGEvent] = []
    func record(_ event: CGEvent) {
        events.append(event)
    }
}
