import Foundation
import Testing
import UIKit

@MainActor
struct GestureTranslatorTests {
    @Test func dualPlaneCompositorWaitsForFreshDetailFrameBeforeRestoring() {
        let compositor = DualPlaneVideoCompositor(initialPlane: .detail)

        compositor.setMotionActive(true)
        #expect(compositor.visiblePlane == .motion)

        compositor.setMotionActive(false)
        #expect(compositor.visiblePlane == .motion)

        compositor.noteFrameRendered(on: .motion)
        #expect(compositor.visiblePlane == .motion)

        compositor.noteFrameRendered(on: .detail)
        #expect(compositor.visiblePlane == .detail)
    }

    @Test func dualPlaneCompositorReportsFirstMotionFrameDelay() {
        let compositor = DualPlaneVideoCompositor(initialPlane: .detail)

        let start = compositor.setMotionActive(true, nowNs: 1_000_000)
        let firstMotion = compositor.noteFrameRendered(on: .motion, nowNs: 4_500_000)
        let duplicateMotion = compositor.noteFrameRendered(on: .motion, nowNs: 6_000_000)

        #expect(start.phase == .motionStarted)
        #expect(firstMotion?.phase == .firstMotionFrame)
        #expect(firstMotion?.delayMs == 3.5)
        #expect(duplicateMotion == nil)
    }

    @Test func dualPlaneCompositorReportsDetailRestoreDelay() {
        let compositor = DualPlaneVideoCompositor(initialPlane: .detail)

        _ = compositor.setMotionActive(true, nowNs: 1_000_000)
        _ = compositor.setMotionActive(false, nowNs: 2_000_000)
        let lateFirstMotion = compositor.noteFrameRendered(on: .motion, nowNs: 3_000_000)
        let restoredDetail = compositor.noteFrameRendered(on: .detail, nowNs: 7_000_000)

        #expect(lateFirstMotion?.phase == .firstMotionFrame)
        #expect(lateFirstMotion?.delayMs == 2.0)
        #expect(restoredDetail?.phase == .detailRestored)
        #expect(restoredDetail?.delayMs == 5.0)
        #expect(compositor.visiblePlane == .detail)
    }

    @Test func videoRenderCadenceTrackerReportsPeriodicFrameWindows() {
        let tracker = VideoRenderCadenceTracker(
            plane: .motion,
            reportEveryFrames: 3,
            lateCallbackGapMs: 20
        )

        #expect(tracker.note(VideoRenderCadenceSample(
            plane: .motion,
            callbackUptimeNs: 1_000_000,
            mediaTimestampNs: 10_000_000,
            width: 1800,
            height: 1168
        )) == nil)
        #expect(tracker.note(VideoRenderCadenceSample(
            plane: .motion,
            callbackUptimeNs: 17_000_000,
            mediaTimestampNs: 26_000_000,
            width: 1800,
            height: 1168
        )) == nil)
        let report = tracker.note(VideoRenderCadenceSample(
            plane: .motion,
            callbackUptimeNs: 67_000_000,
            mediaTimestampNs: 76_000_000,
            width: 1800,
            height: 1168
        ))

        #expect(report?.plane == .motion)
        #expect(report?.reason == "periodic")
        #expect(report?.scrollActive == false)
        #expect(report?.frames == 3)
        #expect(report?.callbackWindowMs == 66)
        #expect(report?.avgCallbackGapMs == 33)
        #expect(report?.maxCallbackGapMs == 50)
        #expect(report?.mediaWindowMs == 66)
        #expect(report?.avgMediaGapMs == 33)
        #expect(report?.maxMediaGapMs == 50)
        #expect(report?.lateCallbackGaps == 1)
        #expect(report?.width == 1800)
        #expect(report?.height == 1168)
    }

    @Test func videoRenderCadenceTrackerFlushesAtScrollTransitions() {
        let tracker = VideoRenderCadenceTracker(plane: .detail, reportEveryFrames: 30)

        _ = tracker.note(VideoRenderCadenceSample(
            plane: .detail,
            callbackUptimeNs: 1_000_000,
            mediaTimestampNs: 2_000_000,
            width: 3600,
            height: 2338
        ))
        let scrollStart = tracker.setScrollActive(true, nowNs: 5_000_000)

        #expect(scrollStart?.reason == "scroll-start")
        #expect(scrollStart?.scrollActive == false)
        #expect(scrollStart?.frames == 1)

        _ = tracker.note(VideoRenderCadenceSample(
            plane: .detail,
            callbackUptimeNs: 9_000_000,
            mediaTimestampNs: 10_000_000,
            width: 3600,
            height: 2338
        ))
        let scrollEnd = tracker.setScrollActive(false, nowNs: 12_000_000)

        #expect(scrollEnd?.reason == "scroll-end")
        #expect(scrollEnd?.scrollActive == true)
        #expect(scrollEnd?.frames == 1)
    }

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

    @Test func scrollTouchDownAndSettleEmitInteractionTransitions() {
        let recorder = InputRecorder()
        let translator = GestureTranslator()
        translator.delegate = recorder

        // Touch-down primes immediately, before any motion.
        translator.processScrollPan(state: .began, translation: .zero)
        #expect(recorder.interactionStates == [true])

        // Motion does not re-emit the transition.
        translator.processScrollPan(state: .changed, translation: CGPoint(x: 0, y: 10))
        translator.processScrollPan(state: .changed, translation: CGPoint(x: 0, y: 25))
        #expect(recorder.interactionStates == [true])

        // Lift with no flick settles the interaction.
        translator.processScrollPan(state: .ended, translation: CGPoint(x: 0, y: 25))
        #expect(recorder.interactionStates == [true, false])
    }

    @Test func scrollChangedFirstStillActivatesInteraction() {
        let recorder = InputRecorder()
        let translator = GestureTranslator()
        translator.delegate = recorder

        translator.processScrollPan(state: .changed, translation: CGPoint(x: 0, y: 10))
        translator.processScrollPan(state: .ended, translation: CGPoint(x: 0, y: 10))

        #expect(recorder.events == [
            .scroll(dx: 0, dy: 10, phase: .began),
            .scroll(dx: 0, dy: 0, phase: .ended)
        ])
        #expect(recorder.interactionStates == [true, false])
    }

    @Test func scrollTapWithoutMotionStillSettles() {
        let recorder = InputRecorder()
        let translator = GestureTranslator()
        translator.delegate = recorder

        // A rested finger / tap primes on touch-down then settles on lift,
        // so the host doesn't get stuck in scroll quality.
        translator.processScrollPan(state: .began, translation: .zero)
        translator.processScrollPan(state: .ended, translation: .zero)

        #expect(recorder.interactionStates == [true, false])
    }
}

@MainActor
private final class InputRecorder: GestureTranslatorDelegate {
    private(set) var events: [NormalizedInput] = []
    private(set) var interactionStates: [Bool] = []
    func gestureTranslator(_ translator: GestureTranslator, didProduce input: NormalizedInput) {
        events.append(input)
    }
    func gestureTranslator(_ translator: GestureTranslator, scrollInteractionActive active: Bool) {
        interactionStates.append(active)
    }
}
