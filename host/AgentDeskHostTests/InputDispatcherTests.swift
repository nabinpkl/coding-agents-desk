import Carbon.HIToolbox
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

    @Test func scrollFocusSnapshotUsesIntegratedCursorPositionAfterMove() {
        let recorder = EventRecorder()
        var now: CFTimeInterval = 10
        let dispatcher = InputDispatcher(
            eventPoster: { recorder.record($0) },
            isTrusted: { true },
            locationProvider: { CGPoint(x: 100, y: 200) },
            displayBoundsProvider: { CGRect(x: 0, y: 0, width: 1500, height: 1000) },
            clock: { now }
        )

        dispatcher.performDispatch(.cursorMove(dx: 40, dy: -10))
        now += 0.05
        let focus = dispatcher.scrollFocusSnapshot()

        #expect(focus.focusPoint == CGPoint(x: 140, y: 190))
        #expect(focus.displayBounds == CGRect(x: 0, y: 0, width: 1500, height: 1000))
    }

    @Test func cursorInputActiveTracksIdleResyncWindow() {
        let recorder = EventRecorder()
        var now: CFTimeInterval = 10
        let dispatcher = InputDispatcher(
            eventPoster: { recorder.record($0) },
            isTrusted: { true },
            locationProvider: { CGPoint(x: 100, y: 200) },
            clock: { now }
        )

        #expect(!dispatcher.isCursorInputActive())
        dispatcher.performDispatch(.cursorMove(dx: 40, dy: -10))
        #expect(dispatcher.isCursorInputActive())

        now += 0.25
        #expect(!dispatcher.isCursorInputActive())
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

    @Test func cursorSetPostsOneMouseMovedEventAtAbsolutePoint() {
        let recorder = EventRecorder()
        let dispatcher = InputDispatcher(
            eventPoster: { recorder.record($0) },
            isTrusted: { true },
            locationProvider: { .zero },
            displayBoundsProvider: { CGRect(x: 100, y: 200, width: 1500, height: 1000) },
            selectedDisplayIdProvider: { "display-a" }
        )

        dispatcher.performDispatch(.cursorSet(displayId: "display-a", x: 450, y: 650))

        #expect(recorder.events.count == 1)
        #expect(recorder.events[0].type == .mouseMoved)
        #expect(recorder.events[0].location == CGPoint(x: 450, y: 650))
    }

    @Test func cursorSetEmitsPositionCorrectionAtPostedPoint() {
        let recorder = EventRecorder()
        var corrections: [CGPoint] = []
        let dispatcher = InputDispatcher(
            eventPoster: { recorder.record($0) },
            isTrusted: { true },
            locationProvider: { .zero },
            displayBoundsProvider: { CGRect(x: 100, y: 200, width: 1500, height: 1000) },
            selectedDisplayIdProvider: { "display-a" }
        )
        dispatcher.cursorPositionHandler = { corrections.append($0) }

        dispatcher.performDispatch(.cursorSet(displayId: "display-a", x: 450, y: 650))

        #expect(corrections == [CGPoint(x: 450, y: 650)])
    }

    @Test func staleCursorSetDoesNotEmitPositionCorrection() {
        let recorder = EventRecorder()
        var corrections: [CGPoint] = []
        let dispatcher = InputDispatcher(
            eventPoster: { recorder.record($0) },
            isTrusted: { true },
            locationProvider: { .zero },
            displayBoundsProvider: { CGRect(x: 100, y: 200, width: 1500, height: 1000) },
            selectedDisplayIdProvider: { "display-a" }
        )
        dispatcher.cursorPositionHandler = { corrections.append($0) }

        dispatcher.performDispatch(.cursorSet(displayId: "display-b", x: 450, y: 650))

        #expect(corrections.isEmpty)
    }

    @Test func cursorMoveEmitsBoundedPositionCorrections() {
        let recorder = EventRecorder()
        var now: CFTimeInterval = 10
        var corrections: [CGPoint] = []
        let dispatcher = InputDispatcher(
            eventPoster: { recorder.record($0) },
            isTrusted: { true },
            locationProvider: { CGPoint(x: 100, y: 200) },
            displayBoundsProvider: { CGRect(x: 0, y: 0, width: 1500, height: 1000) },
            clock: { now }
        )
        dispatcher.cursorPositionHandler = { corrections.append($0) }

        dispatcher.performDispatch(.cursorMove(dx: 10, dy: 0))
        now += 0.02
        dispatcher.performDispatch(.cursorMove(dx: 10, dy: 0))
        now += 0.04
        dispatcher.performDispatch(.cursorMove(dx: 10, dy: 0))

        #expect(corrections == [
            CGPoint(x: 110, y: 200),
            CGPoint(x: 130, y: 200)
        ])
    }

    @Test func cursorSetClampsToSelectedDisplayBounds() {
        let recorder = EventRecorder()
        let dispatcher = InputDispatcher(
            eventPoster: { recorder.record($0) },
            isTrusted: { true },
            locationProvider: { .zero },
            displayBoundsProvider: { CGRect(x: 100, y: 200, width: 1500, height: 1000) },
            selectedDisplayIdProvider: { "display-a" }
        )

        dispatcher.performDispatch(.cursorSet(displayId: "display-a", x: 2_000, y: 2_000))

        #expect(recorder.events.count == 1)
        #expect(recorder.events[0].location == CGPoint(x: 1599, y: 1199))
    }

    @Test func cursorSetUpdatesScrollFocusSnapshot() {
        let recorder = EventRecorder()
        let dispatcher = InputDispatcher(
            eventPoster: { recorder.record($0) },
            isTrusted: { true },
            locationProvider: { .zero },
            displayBoundsProvider: { CGRect(x: 100, y: 200, width: 1500, height: 1000) },
            selectedDisplayIdProvider: { "display-a" }
        )

        dispatcher.performDispatch(.cursorSet(displayId: "display-a", x: 450, y: 650))
        let focus = dispatcher.scrollFocusSnapshot()

        #expect(focus.focusPoint == CGPoint(x: 450, y: 650))
        #expect(focus.displayBounds == CGRect(x: 100, y: 200, width: 1500, height: 1000))
    }

    @Test func cursorSetWithStaleDisplayIdDropsEvent() {
        let recorder = EventRecorder()
        let dispatcher = InputDispatcher(
            eventPoster: { recorder.record($0) },
            isTrusted: { true },
            locationProvider: { .zero },
            displayBoundsProvider: { CGRect(x: 100, y: 200, width: 1500, height: 1000) },
            selectedDisplayIdProvider: { "display-a" }
        )

        dispatcher.performDispatch(.cursorSet(displayId: "display-b", x: 450, y: 650))

        #expect(recorder.events.isEmpty)
    }

    @Test func cursorMoveAfterCursorSetStartsFromSetPoint() {
        let recorder = EventRecorder()
        let dispatcher = InputDispatcher(
            eventPoster: { recorder.record($0) },
            isTrusted: { true },
            locationProvider: { .zero },
            displayBoundsProvider: { CGRect(x: 100, y: 200, width: 1500, height: 1000) },
            selectedDisplayIdProvider: { "display-a" }
        )

        dispatcher.performDispatch(.cursorSet(displayId: "display-a", x: 450, y: 650))
        dispatcher.performDispatch(.cursorMove(dx: 10, dy: -20))

        #expect(recorder.events.count == 2)
        #expect(recorder.events[1].location == CGPoint(x: 460, y: 630))
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

    @Test func consecutiveLeftClicksAtSameLocationIncrementClickState() {
        let recorder = EventRecorder()
        var now: CFTimeInterval = 1000
        let dispatcher = InputDispatcher(
            eventPoster: { recorder.record($0) },
            isTrusted: { true },
            locationProvider: { CGPoint(x: 100, y: 100) },
            clock: { now }
        )

        for _ in 0..<4 {
            dispatcher.performDispatch(.click(button: .left))
            now += 0.1
        }

        #expect(recorder.events.count == 8)
        // 1: single click. 2: word select. 3: line / paragraph select.
        // 4: TextEdit / Xcode / Pages select-all. State is unbounded so
        // any N-click pattern an app wires up keeps working.
        #expect(recorder.events[0].getIntegerValueField(.mouseEventClickState) == 1)
        #expect(recorder.events[1].getIntegerValueField(.mouseEventClickState) == 1)
        #expect(recorder.events[2].getIntegerValueField(.mouseEventClickState) == 2)
        #expect(recorder.events[3].getIntegerValueField(.mouseEventClickState) == 2)
        #expect(recorder.events[4].getIntegerValueField(.mouseEventClickState) == 3)
        #expect(recorder.events[5].getIntegerValueField(.mouseEventClickState) == 3)
        #expect(recorder.events[6].getIntegerValueField(.mouseEventClickState) == 4)
        #expect(recorder.events[7].getIntegerValueField(.mouseEventClickState) == 4)
    }

    @Test func leftClickFarFromPreviousResetsClickState() {
        let recorder = EventRecorder()
        var loc = CGPoint(x: 100, y: 100)
        let dispatcher = InputDispatcher(
            eventPoster: { recorder.record($0) },
            isTrusted: { true },
            locationProvider: { loc }
        )

        dispatcher.performDispatch(.click(button: .left))
        loc = CGPoint(x: 500, y: 500)
        dispatcher.performDispatch(.click(button: .left))

        #expect(recorder.events.count == 4)
        // Second click is far from the first (>5pt), so state resets to 1.
        #expect(recorder.events[2].getIntegerValueField(.mouseEventClickState) == 1)
    }

    @Test func leftClickAfterDoubleClickIntervalResetsClickState() {
        let recorder = EventRecorder()
        var now: CFTimeInterval = 1000
        let dispatcher = InputDispatcher(
            eventPoster: { recorder.record($0) },
            isTrusted: { true },
            locationProvider: { CGPoint(x: 100, y: 100) },
            clock: { now }
        )

        dispatcher.performDispatch(.click(button: .left))
        now += 0.6  // >500ms; outside the double-click window
        dispatcher.performDispatch(.click(button: .left))

        #expect(recorder.events.count == 4)
        #expect(recorder.events[2].getIntegerValueField(.mouseEventClickState) == 1)
    }

    @Test func tapThenDragOpensAtClickStateTwo() {
        // Tap-then-tap-and-hold-and-drag is the Mac word-by-word selection
        // gesture: the first tap is state 1, the drag opens at state 2 so
        // dragged events extend selection word-by-word rather than char.
        let recorder = EventRecorder()
        var now: CFTimeInterval = 1000
        let dispatcher = InputDispatcher(
            eventPoster: { recorder.record($0) },
            isTrusted: { true },
            locationProvider: { CGPoint(x: 100, y: 100) },
            clock: { now }
        )

        dispatcher.performDispatch(.click(button: .left))
        now += 0.1
        dispatcher.performDispatch(.dragStart)
        dispatcher.performDispatch(.cursorMove(dx: 10, dy: 0))
        dispatcher.performDispatch(.dragEnd)

        #expect(recorder.events.count == 5)
        // First click pair: state 1.
        #expect(recorder.events[0].getIntegerValueField(.mouseEventClickState) == 1)
        #expect(recorder.events[1].getIntegerValueField(.mouseEventClickState) == 1)
        // Drag's leftMouseDown, leftMouseDragged, leftMouseUp all at state 2.
        #expect(recorder.events[2].type == .leftMouseDown)
        #expect(recorder.events[2].getIntegerValueField(.mouseEventClickState) == 2)
        #expect(recorder.events[3].type == .leftMouseDragged)
        #expect(recorder.events[3].getIntegerValueField(.mouseEventClickState) == 2)
        #expect(recorder.events[4].type == .leftMouseUp)
        #expect(recorder.events[4].getIntegerValueField(.mouseEventClickState) == 2)
    }

    @Test func keyEventPostsKeyDownThenKeyUpAtMappedVirtualKey() {
        let recorder = EventRecorder()
        let dispatcher = InputDispatcher(
            eventPoster: { recorder.record($0) },
            isTrusted: { true },
            locationProvider: { .zero }
        )

        dispatcher.performDispatch(.key(code: "ansi-S", modifiers: []))

        #expect(recorder.events.count == 2)
        #expect(recorder.events[0].type == .keyDown)
        #expect(recorder.events[1].type == .keyUp)
        #expect(recorder.events[0].getIntegerValueField(.keyboardEventKeycode) == Int64(kVK_ANSI_S))
        #expect(recorder.events[1].getIntegerValueField(.keyboardEventKeycode) == Int64(kVK_ANSI_S))
    }

    @Test func keyEventCarriesSingleModifierFlag() {
        let recorder = EventRecorder()
        let dispatcher = InputDispatcher(
            eventPoster: { recorder.record($0) },
            isTrusted: { true },
            locationProvider: { .zero }
        )

        dispatcher.performDispatch(.key(code: "ansi-S", modifiers: [.cmd]))

        #expect(recorder.events.count == 2)
        #expect(recorder.events[0].flags.contains(.maskCommand))
        #expect(recorder.events[1].flags.contains(.maskCommand))
    }

    @Test func keyEventComposesMultipleModifierFlags() {
        let recorder = EventRecorder()
        let dispatcher = InputDispatcher(
            eventPoster: { recorder.record($0) },
            isTrusted: { true },
            locationProvider: { .zero }
        )

        dispatcher.performDispatch(.key(code: "ansi-S", modifiers: [.cmd, .shift]))

        #expect(recorder.events[0].flags.contains(.maskCommand))
        #expect(recorder.events[0].flags.contains(.maskShift))
        #expect(!recorder.events[0].flags.contains(.maskControl))
        #expect(!recorder.events[0].flags.contains(.maskAlternate))
    }

    @Test func cursorMoveAfterKeyEventCarriesNoModifierFlags() {
        // Regression guard: modifier state from a key event must not bleed
        // into the next cursor move. macOS pointer drift if the OS were to
        // see a held Cmd while the cursor moves alone.
        let recorder = EventRecorder()
        let dispatcher = InputDispatcher(
            eventPoster: { recorder.record($0) },
            isTrusted: { true },
            locationProvider: { CGPoint(x: 0, y: 0) }
        )

        dispatcher.performDispatch(.key(code: "ansi-S", modifiers: [.cmd]))
        dispatcher.performDispatch(.cursorMove(dx: 10, dy: 10))

        #expect(recorder.events.count == 3)
        #expect(!recorder.events[2].flags.contains(.maskCommand))
    }

    @Test func unknownKeyCodeIsDropped() {
        let recorder = EventRecorder()
        let dispatcher = InputDispatcher(
            eventPoster: { recorder.record($0) },
            isTrusted: { true },
            locationProvider: { .zero }
        )

        dispatcher.performDispatch(.key(code: "ansi-nonexistent", modifiers: []))

        #expect(recorder.events.isEmpty)
    }

    @Test func modifierArmIsNoOp() {
        // iOS composes modifiers before sending; host treats modifierArm
        // as a no-op so the wire still carries it (for future / alternate
        // clients) but the host emits nothing.
        let recorder = EventRecorder()
        let dispatcher = InputDispatcher(
            eventPoster: { recorder.record($0) },
            isTrusted: { true },
            locationProvider: { .zero }
        )

        dispatcher.performDispatch(.modifierArm(mod: .cmd))

        #expect(recorder.events.isEmpty)
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

    @Test func switchSpaceGestureWithoutHandlerPostsNoEvents() {
        // Default-installed dispatcher (no switchSpaceGestureHandler)
        // treats every gesture frame as a no-op rather than
        // synthesising any CGEvent. AppDelegate is the only call site
        // that installs the handler.
        let recorder = EventRecorder()
        let dispatcher = InputDispatcher(
            eventPoster: { recorder.record($0) },
            isTrusted: { true },
            locationProvider: { .zero }
        )

        dispatcher.performDispatch(.switchSpaceGesture(phase: .began, progress: 0, velocityX: 0))
        dispatcher.performDispatch(.switchSpaceGesture(phase: .changed, progress: 0.5, velocityX: 800))
        dispatcher.performDispatch(.switchSpaceGesture(phase: .ended, progress: 0.95, velocityX: 1500))

        #expect(recorder.events.isEmpty)
    }

    @Test func switchSpaceGestureForwardsAllPhaseFramesToHandler() {
        let recorder = EventRecorder()
        let dispatcher = InputDispatcher(
            eventPoster: { recorder.record($0) },
            isTrusted: { true },
            locationProvider: { .zero }
        )
        var seen: [(NormalizedInput.SwipePhase, Float, Float)] = []
        dispatcher.switchSpaceGestureHandler = { phase, progress, vx in
            seen.append((phase, progress, vx))
        }

        dispatcher.performDispatch(.switchSpaceGesture(phase: .began, progress: 0, velocityX: 0))
        dispatcher.performDispatch(.switchSpaceGesture(phase: .changed, progress: 0.4, velocityX: 600))
        dispatcher.performDispatch(.switchSpaceGesture(phase: .ended, progress: 0.95, velocityX: 1800))

        #expect(seen.count == 3)
        #expect(seen[0].0 == .began)
        #expect(seen[1].0 == .changed && seen[1].1 == 0.4 && seen[1].2 == 600)
        #expect(seen[2].0 == .ended && seen[2].1 == 0.95 && seen[2].2 == 1800)
    }

    @Test func switchSpaceGestureHandlerNotCalledWhenUntrusted() {
        let recorder = EventRecorder()
        let dispatcher = InputDispatcher(
            eventPoster: { recorder.record($0) },
            isTrusted: { false },
            locationProvider: { .zero }
        )
        var calls = 0
        dispatcher.switchSpaceGestureHandler = { _, _, _ in calls += 1 }

        dispatcher.performDispatch(.switchSpaceGesture(phase: .began, progress: 0, velocityX: 0))
        dispatcher.performDispatch(.switchSpaceGesture(phase: .changed, progress: 0.5, velocityX: 800))

        #expect(calls == 0)
    }
}

private final class EventRecorder {
    private(set) var events: [CGEvent] = []
    func record(_ event: CGEvent) {
        events.append(event)
    }
}
