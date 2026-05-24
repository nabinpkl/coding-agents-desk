import Foundation
import Testing
import UIKit

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

    @Test func scrollStripEmitsScrollWithDyDeltasOnly() {
        let recorder = InputRecorder()
        let translator = GestureTranslator()
        translator.delegate = recorder

        translator.processScrollPan(state: .began, translation: CGPoint(x: 0, y: 0))
        translator.processScrollPan(state: .changed, translation: CGPoint(x: 3, y: 10))
        translator.processScrollPan(state: .changed, translation: CGPoint(x: 5, y: 25))
        translator.processScrollPan(state: .ended, translation: CGPoint(x: 5, y: 25))

        // First .changed emits .began phase (drag start), second is .changed,
        // .ended emits a zero-delta .ended delimiter so macOS knows the touch
        // drag is over.
        #expect(recorder.events.count == 3)
        #expect(recorder.events[0] == .scroll(dx: 0, dy: 10, phase: .began))
        #expect(recorder.events[1] == .scroll(dx: 0, dy: 15, phase: .changed))
        #expect(recorder.events[2] == .scroll(dx: 0, dy: 0, phase: .ended))
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
}

@MainActor
private final class InputRecorder: GestureTranslatorDelegate {
    private(set) var events: [NormalizedInput] = []
    func gestureTranslator(_ translator: GestureTranslator, didProduce input: NormalizedInput) {
        events.append(input)
    }
}
