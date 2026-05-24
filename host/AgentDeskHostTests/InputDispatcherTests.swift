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

    @Test func outOfScopeInputsAreNoOps() {
        let recorder = EventRecorder()
        let dispatcher = InputDispatcher(
            eventPoster: { recorder.record($0) },
            isTrusted: { true },
            locationProvider: { .zero }
        )

        dispatcher.dispatch(.scroll(dx: 1, dy: 2))
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
