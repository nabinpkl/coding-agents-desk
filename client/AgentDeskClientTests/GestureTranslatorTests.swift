import Foundation
import Testing
import UIKit
import AgentDeskWire

@MainActor
struct GestureTranslatorTests {
    @Test func panEmitsCursorMoveDeltasSinceLastChangedCallback() {
        let recorder = InputRecorder()
        let translator = GestureTranslator()
        translator.delegate = recorder

        translator.processPan(state: .began, translation: CGPoint(x: 0, y: 0))
        translator.processPan(state: .changed, translation: CGPoint(x: 5, y: 7))
        translator.processPan(state: .changed, translation: CGPoint(x: 12, y: 4))
        translator.processPan(state: .changed, translation: CGPoint(x: 12, y: 4))
        translator.processPan(state: .ended, translation: CGPoint(x: 12, y: 4))

        #expect(recorder.events.count == 2)
        #expect(recorder.events[0] == .cursorMove(dx: 5, dy: 7))
        #expect(recorder.events[1] == .cursorMove(dx: 7, dy: -3))
    }

    @Test func panWithNoMovementBetweenChangedCallbacksEmitsNothing() {
        let recorder = InputRecorder()
        let translator = GestureTranslator()
        translator.delegate = recorder

        translator.processPan(state: .began, translation: CGPoint(x: 10, y: 10))
        translator.processPan(state: .changed, translation: CGPoint(x: 10, y: 10))

        #expect(recorder.events.isEmpty)
    }

    @Test func newGestureAfterEndStartsDeltaFromBeganTranslation() {
        let recorder = InputRecorder()
        let translator = GestureTranslator()
        translator.delegate = recorder

        translator.processPan(state: .began, translation: .zero)
        translator.processPan(state: .changed, translation: CGPoint(x: 20, y: 0))
        translator.processPan(state: .ended, translation: CGPoint(x: 20, y: 0))

        translator.processPan(state: .began, translation: CGPoint(x: 100, y: 100))
        translator.processPan(state: .changed, translation: CGPoint(x: 105, y: 100))

        #expect(recorder.events.count == 2)
        #expect(recorder.events[0] == .cursorMove(dx: 20, dy: 0))
        #expect(recorder.events[1] == .cursorMove(dx: 5, dy: 0))
    }

    @Test func tapEndedEmitsLeftClick() {
        let recorder = InputRecorder()
        let translator = GestureTranslator()
        translator.delegate = recorder

        translator.processTap(state: .ended)

        #expect(recorder.events.count == 1)
        #expect(recorder.events[0] == .click(button: .left))
    }

    @Test func scrollStripLocksVerticalAndEmitsDyDeltasOnly() {
        let recorder = InputRecorder()
        let translator = GestureTranslator()
        translator.delegate = recorder

        translator.processScrollPan(state: .began, translation: CGPoint(x: 0, y: 0))
        translator.processScrollPan(state: .changed, translation: CGPoint(x: 3, y: 13), velocity: CGPoint(x: 20, y: 200))
        translator.processScrollPan(state: .changed, translation: CGPoint(x: 5, y: 25), velocity: CGPoint(x: 30, y: 220))
        translator.processScrollPan(state: .ended, translation: CGPoint(x: 5, y: 25))

        // First .changed emits .began phase (drag start), second is .changed,
        // .ended emits a zero-delta .ended delimiter so macOS knows the touch
        // drag is over.
        #expect(recorder.events.count == 3)
        #expect(recorder.events[0] == .scroll(dx: 0, dy: 13, phase: .began))
        #expect(recorder.events[1] == .scroll(dx: 0, dy: 12, phase: .changed))
        #expect(recorder.events[2] == .scroll(dx: 0, dy: 0, phase: .ended))
    }

    @Test func scrollStripLocksHorizontalAndEmitsDxDeltasOnly() {
        let recorder = InputRecorder()
        let translator = GestureTranslator()
        translator.delegate = recorder

        translator.processScrollPan(state: .began, translation: .zero)
        translator.processScrollPan(state: .changed, translation: CGPoint(x: 13, y: 3), velocity: CGPoint(x: 240, y: 10))
        translator.processScrollPan(state: .changed, translation: CGPoint(x: 31, y: 8), velocity: CGPoint(x: 260, y: 20))
        translator.processScrollPan(state: .ended, translation: CGPoint(x: 31, y: 8))

        #expect(recorder.events.count == 3)
        #expect(recorder.events[0] == .scroll(dx: 13, dy: 0, phase: .began))
        #expect(recorder.events[1] == .scroll(dx: 18, dy: 0, phase: .changed))
        #expect(recorder.events[2] == .scroll(dx: 0, dy: 0, phase: .ended))
    }

    @Test func scrollStripWaitsForDominantAxisBeforeEmitting() {
        let recorder = InputRecorder()
        let translator = GestureTranslator()
        translator.delegate = recorder

        translator.processScrollPan(state: .began, translation: .zero)
        translator.processScrollPan(state: .changed, translation: CGPoint(x: 10, y: 10), velocity: CGPoint(x: 200, y: 200))
        translator.processScrollPan(state: .changed, translation: CGPoint(x: 20, y: 12), velocity: CGPoint(x: 240, y: 80))

        #expect(recorder.events == [.scroll(dx: 20, dy: 0, phase: .began)])
    }

    @Test func scrollEndedWithoutAnyChangedEmitsNothing() {
        let recorder = InputRecorder()
        let translator = GestureTranslator()
        translator.delegate = recorder

        // Touch and lift without movement: no .began ever emitted, so the
        // .ended delimiter must also be suppressed.
        translator.processScrollPan(state: .began, translation: .zero)
        translator.processScrollPan(state: .ended, translation: .zero)

        #expect(recorder.events.isEmpty)
    }

    @Test func tapStatesOtherThanEndedEmitNothing() {
        let recorder = InputRecorder()
        let translator = GestureTranslator()
        translator.delegate = recorder

        translator.processTap(state: .began)
        translator.processTap(state: .changed)
        translator.processTap(state: .cancelled)
        translator.processTap(state: .failed)
        translator.processTap(state: .possible)

        #expect(recorder.events.isEmpty)
    }

    @Test func missionControlSwipeEndedEmitsSystemCommand() {
        let recorder = InputRecorder()
        let translator = GestureTranslator()
        translator.delegate = recorder

        translator.processMissionControlSwipe(state: .ended)

        #expect(recorder.events == [.systemCommand(.missionControl)])
    }

    @Test func missionControlSwipeIgnoresNonEndedStates() {
        let recorder = InputRecorder()
        let translator = GestureTranslator()
        translator.delegate = recorder

        translator.processMissionControlSwipe(state: .began)
        translator.processMissionControlSwipe(state: .changed)
        translator.processMissionControlSwipe(state: .cancelled)
        translator.processMissionControlSwipe(state: .failed)
        translator.processMissionControlSwipe(state: .possible)

        #expect(recorder.events.isEmpty)
    }

    @Test func dragBeganEmitsDragStart() {
        let recorder = InputRecorder()
        let translator = GestureTranslator()
        translator.delegate = recorder

        translator.processDrag(state: .began, point: CGPoint(x: 50, y: 50))

        #expect(recorder.events.count == 1)
        #expect(recorder.events[0] == .dragStart)
    }

    @Test func dragChangedEmitsCursorMoveDeltasSinceLastPoint() {
        let recorder = InputRecorder()
        let translator = GestureTranslator()
        translator.delegate = recorder

        translator.processDrag(state: .began, point: CGPoint(x: 50, y: 50))
        translator.processDrag(state: .changed, point: CGPoint(x: 60, y: 70))
        translator.processDrag(state: .changed, point: CGPoint(x: 75, y: 70))

        #expect(recorder.events.count == 3)
        #expect(recorder.events[0] == .dragStart)
        #expect(recorder.events[1] == .cursorMove(dx: 10, dy: 20))
        #expect(recorder.events[2] == .cursorMove(dx: 15, dy: 0))
    }

    @Test func dragEdgePanContinuesMotionAfterFingerStopsAtScreenEdge() {
        let recorder = InputRecorder()
        let translator = GestureTranslator()
        translator.delegate = recorder

        let bounds = CGRect(x: 0, y: 0, width: 200, height: 200)

        translator.processDrag(state: .began, point: CGPoint(x: 100, y: 100), in: bounds, timestamp: 0.0)
        translator.processDrag(state: .changed, point: CGPoint(x: 148, y: 100), in: bounds, timestamp: 0.2)
        translator.processDrag(state: .changed, point: CGPoint(x: 198, y: 100), in: bounds, timestamp: 0.3)
        translator.processDragEdgePanTick(now: 0.4)
        translator.processDragEdgePanTick(now: 0.5)
        translator.processDrag(state: .ended, point: CGPoint(x: 198, y: 100), in: bounds, timestamp: 0.6)

        #expect(recorder.events.count == 6)
        #expect(recorder.events[0] == .dragStart)
        #expect(recorder.events[1] == .cursorMove(dx: 48, dy: 0))
        #expect(recorder.events[2] == .cursorMove(dx: 50, dy: 0))
        #expect(recorder.events[3] == .cursorMove(dx: 50, dy: 0))
        #expect(recorder.events[4] == .cursorMove(dx: 50, dy: 0))
        #expect(recorder.events[5] == .dragEnd)
    }

    @Test func dragEndedEmitsDragEndAndAllowsPanAgain() {
        let recorder = InputRecorder()
        let translator = GestureTranslator()
        translator.delegate = recorder

        translator.processDrag(state: .began, point: .zero)
        translator.processDrag(state: .ended, point: CGPoint(x: 50, y: 50))

        #expect(recorder.events.count == 2)
        #expect(recorder.events[0] == .dragStart)
        #expect(recorder.events[1] == .dragEnd)

        // After the drag closes, pan emits cursor moves again.
        translator.processPan(state: .began, translation: .zero)
        translator.processPan(state: .changed, translation: CGPoint(x: 5, y: 5))

        #expect(recorder.events.count == 3)
        #expect(recorder.events[2] == .cursorMove(dx: 5, dy: 5))
    }

    @Test func panIsSuppressedDuringDrag() {
        let recorder = InputRecorder()
        let translator = GestureTranslator()
        translator.delegate = recorder

        translator.processDrag(state: .began, point: .zero)
        translator.processPan(state: .began, translation: .zero)
        translator.processPan(state: .changed, translation: CGPoint(x: 30, y: 30))
        translator.processDrag(state: .ended, point: .zero)

        // Pan deltas are dropped while drag is active; only dragStart and
        // dragEnd survive. The drag recognizer owns cursor emission for
        // the duration of the gesture so the host doesn't see double
        // motion from both pan and drag firing concurrently.
        #expect(recorder.events.count == 2)
        #expect(recorder.events[0] == .dragStart)
        #expect(recorder.events[1] == .dragEnd)
    }

    @Test func scrollChangedFirstStillEmitsScroll() {
        let recorder = InputRecorder()
        let translator = GestureTranslator()
        translator.delegate = recorder

        translator.processScrollPan(state: .changed, translation: CGPoint(x: 0, y: 13))
        translator.processScrollPan(state: .ended, translation: CGPoint(x: 0, y: 13))

        #expect(recorder.events == [
            .scroll(dx: 0, dy: 13, phase: .began),
            .scroll(dx: 0, dy: 0, phase: .ended)
        ])
    }

    @Test func horizontalScrollMomentumStaysHorizontal() {
        let recorder = InputRecorder()
        let translator = GestureTranslator()
        translator.delegate = recorder

        translator.processScrollPan(state: .began, translation: .zero)
        translator.processScrollPan(state: .changed, translation: CGPoint(x: 18, y: 2), velocity: CGPoint(x: 500, y: 40))
        translator.processScrollPan(state: .ended, translation: CGPoint(x: 18, y: 2), velocity: CGPoint(x: 500, y: 40))
        translator.processScrollMomentumTick(now: CACurrentMediaTime() + 0.05)

        guard case let .scroll(dx, dy, phase) = recorder.events.last else {
            Issue.record("expected momentum scroll")
            return
        }
        #expect(phase == .momentumBegan)
        #expect(dx > 0)
        #expect(dy == 0)
    }

    @Test func scrollTapWithoutMotionEmitsNothing() {
        let recorder = InputRecorder()
        let translator = GestureTranslator()
        translator.delegate = recorder

        translator.processScrollPan(state: .began, translation: .zero)
        translator.processScrollPan(state: .ended, translation: .zero)

        #expect(recorder.events.isEmpty)
    }
}

@MainActor
private final class InputRecorder: GestureTranslatorDelegate {
    private(set) var events: [NormalizedInput] = []
    func gestureTranslator(_ translator: GestureTranslator, didProduce input: NormalizedInput) {
        events.append(input)
    }
}
