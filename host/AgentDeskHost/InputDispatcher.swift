import ApplicationServices
import CoreGraphics
import Foundation
import QuartzCore
import os
import AgentDeskWire

// R9.3 NormalizedInput sink. Consumes decoded events and posts CGEvents.
// The eventPoster seam lets tests capture posted events without hitting
// the real HID tap. Accessibility gating lives here so the call site does
// not have to think about TCC; an untrusted process logs once and drops.

final class InputDispatcher: @unchecked Sendable {
    typealias EventPoster = (CGEvent) -> Void
    typealias LocationProvider = () -> CGPoint
    typealias DisplayBoundsProvider = () -> CGRect
    typealias SelectedDisplayIdProvider = () -> String?
    typealias Clock = () -> CFTimeInterval
    typealias SwitchSpaceGestureHandler = (NormalizedInput.SwipePhase, Float, Float) -> Void
    typealias SwitchSpaceStepHandler = (Int) -> Void
    typealias SystemCommandHandler = (NormalizedInput.SystemCommand) -> Void
    typealias ScrollFocusHandler = @Sendable (NormalizedInput, ScrollFocusSnapshot) -> Void
    typealias CursorPositionHandler = (CGPoint) -> Void

    struct ScrollFocusSnapshot: Sendable {
        let focusPoint: CGPoint
        let displayBounds: CGRect
    }

    private let logger = Logger(subsystem: Config.logSubsystem, category: "input")
    private let eventPoster: EventPoster
    private let isTrusted: () -> Bool
    private let locationProvider: LocationProvider
    private let displayBoundsProvider: DisplayBoundsProvider
    private let selectedDisplayIdProvider: SelectedDisplayIdProvider
    private let clock: Clock

    // R11: AppDelegate installs this to forward continuous
    // .switchSpaceGesture frames into the SpacesProvider dock-swipe
    // synthesis path. Default no-op so unit tests can leave it unset.
    // One handler call per wire frame; the dispatcher's serial queue
    // preserves the Began -> Changed* -> Ended order the Dock expects.
    var switchSpaceGestureHandler: SwitchSpaceGestureHandler?
    // Tap-to-jump: client sends one .switchSpaceStep(delta:) frame; the
    // handler expands it into |delta| dock-swipe cycles on a dedicated
    // queue inside SpacesProvider. Default no-op so unit tests can
    // leave it unset.
    var switchSpaceStepHandler: SwitchSpaceStepHandler?
    var systemCommandHandler: SystemCommandHandler?
    var cursorPositionHandler: CursorPositionHandler?
    private var loggedUntrusted = false
    // Custom event source so we can disable the 0.25s synthetic-event
    // suppression interval macOS otherwise applies. Without this, posted
    // moves overlapping with the user's local trackpad or other CGEvent
    // sources cause visible cursor hitches.
    private let cursorEventSource: CGEventSource?
    // Sub-pixel scroll deltas (precision drags after lowering the iPhone
    // scroll gain floor to 1.0) round to zero individually and would never
    // emit. Accumulate independent fractional remainders across calls so
    // vertical and horizontal precision drags eventually trip the threshold
    // without leaking into each other.
    private var scrollRemainderX: CGFloat = 0
    private var scrollRemainderY: CGFloat = 0
    // R10.2: while the iPhone-side double-tap-drag is held, cursorMove
    // events promote to leftMouseDragged on the host so apps see one
    // continuous click-drag rather than a click followed by free cursor
    // motion. dragStart sets this true, dragEnd clears it.
    private var inDrag = false
    // Click state tracking for the left button: a click within 500ms of
    // the previous one at roughly the same point increments the state
    // field. macOS apps key off this for double-click word selection,
    // triple-click line/paragraph selection, quadruple-click select-all
    // (TextEdit, Xcode, Pages), and the matching click-and-drag selection
    // extensions. State is unbounded so any N-click pattern an app wires
    // up keeps working. Without this, two rapid taps register as two
    // independent single clicks and no text view selects a word.
    private var lastLeftClickTime: CFTimeInterval = 0
    private var lastLeftClickLocation: CGPoint = .zero
    private var lastLeftClickState: Int64 = 0
    private static let doubleClickInterval: CFTimeInterval = 0.5
    private static let doubleClickRadius: CGFloat = 5
    // Click state for the in-flight drag, captured at dragStart so all
    // leftMouseDragged events plus the closing leftMouseUp carry the
    // same state. This is what makes tap-then-tap-and-hold-and-drag
    // extend selection word-by-word rather than character-by-character.
    private var dragClickState: Int64 = 1
    // Authoritative cursor position the dispatcher integrates deltas into.
    // CGEvent(source: nil).location lags rapid synthetic posts: the window
    // server updates the queried position asynchronously, so re-reading it
    // as the base for every move makes a fast drag progressively undershoot
    // (each delta lands on a stale, behind position). The iPhone client
    // dead-reckons into its own full-precision model and never undershoots,
    // so the two drift apart proportional to drag speed and stay apart at
    // rest. Holding our own position and integrating into it keeps the host
    // cursor locked to the client's predicted dot.
    private var cursorPosition: CGPoint?
    private var lastCursorMoveTime: CFTimeInterval = 0
    private var lastCursorPositionEmitTime: CFTimeInterval = -Double.infinity
    // Re-sync the held position from the OS when the move stream has been
    // idle this long, so a physical mouse / trackpad move between remote
    // strokes is picked up. During an active stream we trust our own
    // integrated position over the lagging OS query.
    private static let cursorResyncIdleInterval: CFTimeInterval = 0.2
    private static let cursorPositionEmitInterval: CFTimeInterval = 0.05
    // Serial queue so dispatch() is callable from any context (network
    // Task, MainActor, tests) without racing on loggedUntrusted /
    // scrollRemainder. Previously the AppDelegate forced every input
    // through MainActor.run, which serialized CGEvent.post behind UI
    // work (popover redraws, signaling logs) and produced visible cursor
    // cadence stalls. CGEvent.post is itself thread-safe, so the only
    // reason to serialize is to keep our own state coherent.
    private let queue = DispatchQueue(label: "com.example.agentdesk.agentdesk.input", qos: .userInteractive)

    init(
        eventPoster: @escaping EventPoster = { $0.post(tap: .cghidEventTap) },
        isTrusted: @escaping () -> Bool = { AXIsProcessTrusted() },
        locationProvider: @escaping LocationProvider = { CGEvent(source: nil)?.location ?? .zero },
        displayBoundsProvider: @escaping DisplayBoundsProvider = { CGDisplayBounds(CGMainDisplayID()) },
        selectedDisplayIdProvider: @escaping SelectedDisplayIdProvider = { nil },
        clock: @escaping Clock = { CACurrentMediaTime() }
    ) {
        self.eventPoster = eventPoster
        self.isTrusted = isTrusted
        self.locationProvider = locationProvider
        self.displayBoundsProvider = displayBoundsProvider
        self.selectedDisplayIdProvider = selectedDisplayIdProvider
        self.clock = clock
        let source = CGEventSource(stateID: .hidSystemState)
        source?.localEventsSuppressionInterval = 0.0
        self.cursorEventSource = source
    }

    func dispatch(
        _ input: NormalizedInput,
        scrollFocusHandler: ScrollFocusHandler? = nil,
        afterDispatch: (@Sendable () -> Void)? = nil
    ) {
        // async so the caller's Task moves on while CGEvent.post runs on
        // our queue. The queue is serial, so events stay in order.
        queue.async { [self] in
            if case .scroll = input, let scrollFocusHandler {
                scrollFocusHandler(input, makeScrollFocusSnapshot())
            }
            performDispatch(input)
            afterDispatch?()
        }
    }

    func scrollFocusSnapshot() -> ScrollFocusSnapshot {
        queue.sync { makeScrollFocusSnapshot() }
    }

    func isCursorInputActive() -> Bool {
        queue.sync {
            cursorPosition != nil && clock() - lastCursorMoveTime <= Self.cursorResyncIdleInterval
        }
    }

    private func makeScrollFocusSnapshot() -> ScrollFocusSnapshot {
        ScrollFocusSnapshot(
            focusPoint: cursorBase(),
            displayBounds: displayBoundsProvider()
        )
    }

    // Synchronous core, called only from `queue`. Exposed-internal so tests
    // can drive it without paying the async hop.
    func performDispatch(_ input: NormalizedInput) {
        guard isTrusted() else {
            if !loggedUntrusted {
                logger.warning("Accessibility not granted; dropping input events")
                loggedUntrusted = true
            }
            return
        }
        loggedUntrusted = false
        switch input {
        case .cursorSet(let displayId, let x, let y):
            postCursorSet(displayId: displayId, x: CGFloat(x), y: CGFloat(y))
        case .cursorMove(let dx, let dy):
            postCursorMove(dx: CGFloat(dx), dy: CGFloat(dy))
        case .click(let button):
            postClick(button)
        case .scroll(let dx, let dy, let phase):
            postScroll(dx: dx, dy: dy, phase: phase)
        case .dragStart:
            postDragStart()
        case .dragEnd:
            postDragEnd()
        case .key(let code, let modifiers):
            postKey(code: code, modifiers: modifiers)
        case .modifierArm:
            // iOS composes modifiers before sending (per issue #8 and
            // SPEC §3). The host treats .modifierArm as a no-op; it
            // exists on the wire for future / alternate clients that
            // compose host-side.
            break
        case .switchSpaceGesture(let phase, let progress, let velocityX):
            // Forward one dock-swipe phase. The Dock animates the
            // Spaces transition driven by the progress stream and
            // commits-or-snaps-back at Ended. See SpacesProvider.
            if let switchSpaceGestureHandler {
                switchSpaceGestureHandler(phase, progress, velocityX)
            }
        case .switchSpaceStep(let delta):
            // Hand off to SpacesProvider.commitStep, which expands the
            // step into |delta| Began/Changed/Ended cycles on its own
            // serial queue. The expansion can't run on this queue:
            // commitStep sleeps between cycles and would block cursor
            // and click dispatch for the duration of the jump.
            if let switchSpaceStepHandler {
                switchSpaceStepHandler(delta)
            }
        case .systemCommand(let command):
            logger.notice("systemCommand received command=\(command.rawValue, privacy: .public)")
            if let systemCommandHandler {
                systemCommandHandler(command)
            }
        }
    }

    private func currentLocation() -> CGPoint {
        locationProvider()
    }

    // Base position to integrate the next event against. Returns the held
    // authoritative position while the stream is active; falls back to the
    // live OS location on first use and after an idle gap so external
    // cursor moves are absorbed. See cursorPosition for why the held
    // value, not a fresh OS query, is the integration base mid-stream.
    private func cursorBase() -> CGPoint {
        if let pos = cursorPosition, clock() - lastCursorMoveTime <= Self.cursorResyncIdleInterval {
            return pos
        }
        return currentLocation()
    }

    private func postCursorSet(displayId: String, x: CGFloat, y: CGFloat) {
        guard selectedDisplayIdProvider() == displayId else {
            logger.notice("dropping cursorSet for stale display id=\(displayId, privacy: .public)")
            return
        }
        let bounds = displayBoundsProvider()
        let next = Self.clamp(CGPoint(x: x, y: y), to: bounds)
        cursorPosition = next
        lastCursorMoveTime = clock()
        guard let event = CGEvent(
            mouseEventSource: cursorEventSource,
            mouseType: .mouseMoved,
            mouseCursorPosition: next,
            mouseButton: .left
        ) else {
            return
        }
        event.flags = []
        eventPoster(event)
        emitCursorPosition(next, force: true)
    }

    private func postCursorMove(dx: CGFloat, dy: CGFloat) {
        let base = cursorBase()
        let raw = CGPoint(x: base.x + dx, y: base.y + dy)
        let bounds = displayBoundsProvider()
        let next = Self.clamp(raw, to: bounds)
        cursorPosition = next
        lastCursorMoveTime = clock()
        // Only mouseCursorPosition drives the visible cursor when set this
        // way; macOS pointer acceleration runs in the HID layer below
        // CGEvent and can't be invoked from userspace injection. Earlier
        // iterations also wrote kCGMouseEventDeltaX/Y hoping the OS curve
        // would shape the motion, but those fields are inert once we set
        // position, so the client-side curve in GestureTranslator is the
        // only one that matters.
        //
        // While inDrag, the same cursor stream becomes leftMouseDragged so
        // the OS treats it as a continuation of the leftMouseDown that
        // opened the drag, not a separate cursor pass that loses the click.
        let type: CGEventType = inDrag ? .leftMouseDragged : .mouseMoved
        guard let event = CGEvent(
            mouseEventSource: cursorEventSource,
            mouseType: type,
            mouseCursorPosition: next,
            mouseButton: .left
        ) else {
            return
        }
        event.flags = []
        if inDrag {
            // Inherit the click state captured at dragStart so all
            // dragged events form one cohesive click-and-drag from the
            // OS's perspective (state=2 extends word selection, state=3
            // extends paragraph selection, etc.).
            event.setIntegerValueField(.mouseEventClickState, value: dragClickState)
        }
        eventPoster(event)
        emitCursorPosition(next, force: false)
    }

    private func emitCursorPosition(_ point: CGPoint, force: Bool) {
        let now = clock()
        guard force || now - lastCursorPositionEmitTime >= Self.cursorPositionEmitInterval else { return }
        lastCursorPositionEmitTime = now
        cursorPositionHandler?(point)
    }

    private func postDragStart() {
        if inDrag { return }
        inDrag = true
        let location = cursorBase()
        // Tick the click tracker so a tap-then-tap-and-hold sequence
        // opens the drag at click state 2 (double-click-drag = extend
        // word selection), tap-tap-tap-hold opens at 3 (triple = line
        // / paragraph), and a bare hold opens at 1. The dragged events
        // and closing mouseUp inherit this via dragClickState.
        dragClickState = nextLeftClickState(at: location)
        postClickEvent(.leftMouseDown, at: location, button: .left, clickState: dragClickState)
    }

    private func postDragEnd() {
        if !inDrag { return }
        let location = cursorBase()
        postClickEvent(.leftMouseUp, at: location, button: .left, clickState: dragClickState)
        inDrag = false
    }

    static func clamp(_ point: CGPoint, to bounds: CGRect) -> CGPoint {
        // maxX - 1 / maxY - 1 because CGDisplayBounds is exclusive on the
        // far edges; posting at exactly maxX has been seen to flick the
        // cursor onto an adjacent display in multi-monitor setups.
        CGPoint(
            x: min(max(bounds.minX, point.x), bounds.maxX - 1),
            y: min(max(bounds.minY, point.y), bounds.maxY - 1)
        )
    }

    private func postClick(_ button: NormalizedInput.MouseButton) {
        let location = cursorBase()
        switch button {
        case .left:
            let state = nextLeftClickState(at: location)
            postClickEvent(.leftMouseDown, at: location, button: .left, clickState: state)
            postClickEvent(.leftMouseUp, at: location, button: .left, clickState: state)
        case .right:
            // Without an explicit click state, some macOS text views treat
            // synthesised rightMouseDown/Up as the start of a right-button
            // drag and extend the selection on top of the context menu.
            // Setting state=1 marks both events as a single discrete click
            // so the OS routes them as "click then release" not "drag".
            // cursorEventSource carries localEventsSuppressionInterval=0 so
            // the events don't get swallowed if a user mouse event is near.
            postClickEvent(.rightMouseDown, at: location, button: .right)
            postClickEvent(.rightMouseUp, at: location, button: .right)
        case .double:
            // R10.2 territory (double-tap-drag); .double is the synthesised
            // double-click button code, not a separate gesture path yet.
            break
        }
    }

    private func postClickEvent(
        _ type: CGEventType,
        at point: CGPoint,
        button: CGMouseButton,
        clickState: Int64 = 1
    ) {
        guard let event = CGEvent(
            mouseEventSource: cursorEventSource,
            mouseType: type,
            mouseCursorPosition: point,
            mouseButton: button
        ) else { return }
        event.flags = []
        event.setIntegerValueField(.mouseEventClickState, value: clickState)
        eventPoster(event)
    }

    // Types arbitrary text at the focused cursor. Used by the host
    // dictation bar to inject a transcript into whatever app is frontmost.
    // Goes through the same serial queue and Accessibility gate as remote
    // input so ordering and trust handling stay in one place.
    func typeText(_ text: String) {
        guard !text.isEmpty else { return }
        queue.async { [self] in performTypeText(text) }
    }

    // Synchronous core, called only from `queue`. Internal so tests can
    // drive it without the async hop.
    func performTypeText(_ text: String) {
        guard isTrusted() else {
            if !loggedUntrusted {
                logger.warning("Accessibility not granted; dropping typed text")
                loggedUntrusted = true
            }
            return
        }
        loggedUntrusted = false
        // keyboardSetUnicodeString injects the literal characters without a
        // keycode lookup, so it is layout-independent and handles punctuation
        // and non-ASCII. Chunk the UTF-16 units; a single event with a long
        // string is unreliable, short runs post cleanly.
        let units = Array(text.utf16)
        let chunkSize = 16
        var start = 0
        while start < units.count {
            let end = min(start + chunkSize, units.count)
            postUnicodeChunk(Array(units[start..<end]))
            start = end
        }
    }

    private func postUnicodeChunk(_ utf16: [UniChar]) {
        guard let down = CGEvent(keyboardEventSource: cursorEventSource, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: cursorEventSource, virtualKey: 0, keyDown: false) else { return }
        down.flags = []
        up.flags = []
        utf16.withUnsafeBufferPointer { buffer in
            down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
            up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
        }
        eventPoster(down)
        eventPoster(up)
    }

    private func postKey(code: String, modifiers: [NormalizedInput.Modifier]) {
        guard let virtualKey = KeyCodeMap.lookup(code) else {
            logger.warning("Unknown key code from client: \(code, privacy: .public)")
            return
        }
        let flags = cgEventFlags(for: modifiers)
        postKeyEvent(virtualKey: virtualKey, keyDown: true, flags: flags)
        postKeyEvent(virtualKey: virtualKey, keyDown: false, flags: flags)
    }

    private func postKeyEvent(virtualKey: CGKeyCode, keyDown: Bool, flags: CGEventFlags) {
        guard let event = CGEvent(
            keyboardEventSource: cursorEventSource,
            virtualKey: virtualKey,
            keyDown: keyDown
        ) else { return }
        // Set flags directly rather than OR-ing into the OS-current flag
        // state so a held physical modifier on the host (e.g. user's local
        // Shift) doesn't leak into the synthesised event.
        event.flags = flags
        eventPoster(event)
    }

    private func cgEventFlags(for modifiers: [NormalizedInput.Modifier]) -> CGEventFlags {
        var flags: CGEventFlags = []
        for mod in modifiers {
            switch mod {
            case .cmd:    flags.insert(.maskCommand)
            case .ctrl:   flags.insert(.maskControl)
            case .option: flags.insert(.maskAlternate)
            case .shift:  flags.insert(.maskShift)
            }
        }
        return flags
    }

    private func nextLeftClickState(at location: CGPoint) -> Int64 {
        let now = clock()
        let dx = location.x - lastLeftClickLocation.x
        let dy = location.y - lastLeftClickLocation.y
        let distance = (dx * dx + dy * dy).squareRoot()
        let state: Int64
        if now - lastLeftClickTime <= Self.doubleClickInterval && distance <= Self.doubleClickRadius {
            state = lastLeftClickState + 1
        } else {
            state = 1
        }
        lastLeftClickTime = now
        lastLeftClickLocation = location
        lastLeftClickState = state
        return state
    }

    private func postScroll(dx: Float, dy: Float, phase: NormalizedInput.ScrollPhase) {
        // Accumulate fractional deltas so a stream of sub-pixel precision
        // drags still emits events at the integer threshold rather than
        // rounding each call independently to zero. Truncate toward zero so
        // emitted pixels never exceed the accumulated input.
        //
        // iPhone reports -dy when finger flicks UP; macOS treats positive
        // wheel1 as "scroll up the document" (you see content above the
        // current view). So a finger flick UP -> negative dy -> negative
        // wheel1 -> document scrolls forward -> content visibly moves UP
        // out of view, matching iOS Safari behavior.
        //
        // Horizontal scroll uses wheel2. The client sends positive dx when
        // the finger moves right; pass it through to keep the same natural
        // direct-manipulation sign model as vertical scroll.
        // A fresh gesture (or the end of one) must not inherit a stale
        // fractional remainder from the previous gesture; reset at the gesture
        // delimiters so the first delta of a new stroke is not skewed.
        if phase == .began || phase == .ended || phase == .momentumEnded {
            scrollRemainderX = 0
            scrollRemainderY = 0
        }
        scrollRemainderX += CGFloat(dx)
        scrollRemainderY += CGFloat(dy)
        let dxInt = Int32(scrollRemainderX.rounded(.towardZero))
        let dyInt = Int32(scrollRemainderY.rounded(.towardZero))
        scrollRemainderX -= CGFloat(dxInt)
        scrollRemainderY -= CGFloat(dyInt)
        // Skip zero-delta posts only for continuous "changed" phases. The
        // delimiter phases (began / ended / momentumBegan / momentumEnded)
        // carry phase info macOS needs even when their delta is zero.
        let isDelimiter = phase != .changed && phase != .momentumChanged
        if dxInt == 0 && dyInt == 0 && !isDelimiter { return }
        guard let event = CGEvent(
            scrollWheelEvent2Source: nil,
            units: .pixel,
            wheelCount: 2,
            wheel1: dyInt,
            wheel2: dxInt,
            wheel3: 0
        ) else { return }
        event.flags = []
        let (scrollPhase, momentumPhase) = cgPhaseValues(phase)
        event.setIntegerValueField(.scrollWheelEventScrollPhase, value: scrollPhase)
        event.setIntegerValueField(.scrollWheelEventMomentumPhase, value: momentumPhase)
        // A real trackpad continuous scroll carries isContinuous=1; native
        // AppKit scroll views key their elastic/rubber-band handling off it.
        // Known limitation: Electron/Chromium targets (e.g. the Claude desktop
        // app) still swallow reverse deltas after an overscrolled boundary even
        // with well-formed continuous-scroll events (correct began/changed/ended
        // phases, isContinuous=1, correctly-signed deltas), because Chromium's
        // scroll-latching handles synthetic scroll differently. Native apps
        // reverse out of the boundary fine, so this is target-side, not a defect
        // in this pipeline. Verified via host postScroll traces (2026-07-03).
        event.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
        logger.debug("postScroll wheel1=\(dyInt, privacy: .public) wheel2=\(dxInt, privacy: .public) scrollPhase=\(scrollPhase, privacy: .public) momentumPhase=\(momentumPhase, privacy: .public)")
        eventPoster(event)
    }

    // Map the wire-level ScrollPhase to the two CG integer field values
    // macOS expects. Values come from CGEventTypes.h:
    //   CGScrollPhase: began=1, changed=2, ended=4
    //   CGMomentumScrollPhase: none=0, begin=1, continue=2, end=3
    // Touch-drag events set ScrollPhase, leave MomentumPhase=0. Inertia
    // events set MomentumPhase, leave ScrollPhase=0.
    private func cgPhaseValues(_ phase: NormalizedInput.ScrollPhase) -> (Int64, Int64) {
        switch phase {
        case .began:           return (1, 0)
        case .changed:         return (2, 0)
        case .ended:           return (4, 0)
        case .momentumBegan:   return (0, 1)
        case .momentumChanged: return (0, 2)
        case .momentumEnded:   return (0, 3)
        }
    }
}
