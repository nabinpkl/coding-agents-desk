import ApplicationServices
import CoreGraphics
import Foundation
import os

// R9.3 NormalizedInput sink. Consumes decoded events and posts CGEvents.
// The eventPoster seam lets tests capture posted events without hitting
// the real HID tap. Accessibility gating lives here so the call site does
// not have to think about TCC; an untrusted process logs once and drops.

final class InputDispatcher: @unchecked Sendable {
    typealias EventPoster = (CGEvent) -> Void
    typealias LocationProvider = () -> CGPoint

    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "input")
    private let eventPoster: EventPoster
    private let isTrusted: () -> Bool
    private let locationProvider: LocationProvider
    private var loggedUntrusted = false
    // Custom event source so we can disable the 0.25s synthetic-event
    // suppression interval macOS otherwise applies. Without this, posted
    // moves overlapping with the user's local trackpad or other CGEvent
    // sources cause visible cursor hitches.
    private let cursorEventSource: CGEventSource?
    // Sub-pixel scroll deltas (precision drags after lowering the iPhone
    // scroll gain floor to 1.0) round to zero individually and would never
    // emit. Accumulate the fractional remainder across calls so they
    // eventually trip the threshold and emit a single-pixel event.
    private var scrollRemainder: CGFloat = 0

    init(
        eventPoster: @escaping EventPoster = { $0.post(tap: .cghidEventTap) },
        isTrusted: @escaping () -> Bool = { AXIsProcessTrusted() },
        locationProvider: @escaping LocationProvider = { CGEvent(source: nil)?.location ?? .zero }
    ) {
        self.eventPoster = eventPoster
        self.isTrusted = isTrusted
        self.locationProvider = locationProvider
        let source = CGEventSource(stateID: .hidSystemState)
        source?.localEventsSuppressionInterval = 0.0
        self.cursorEventSource = source
    }

    func dispatch(_ input: NormalizedInput) {
        guard isTrusted() else {
            if !loggedUntrusted {
                logger.warning("Accessibility not granted; dropping input events")
                loggedUntrusted = true
            }
            return
        }
        loggedUntrusted = false
        switch input {
        case .cursorMove(let dx, let dy):
            postCursorMove(dx: CGFloat(dx), dy: CGFloat(dy))
        case .click(let button):
            postClick(button)
        case .scroll(let dx, let dy, let phase):
            postScroll(dx: dx, dy: dy, phase: phase)
        case .dragStart, .dragEnd, .switchSpace, .key, .modifierArm:
            // Out of scope for R9 / R10. Wired in later iterations.
            break
        }
    }

    private func currentLocation() -> CGPoint {
        locationProvider()
    }

    private func postCursorMove(dx: CGFloat, dy: CGFloat) {
        // Delta-only mouseMoved event: macOS reads kCGMouseEventDeltaX/Y
        // through the HID pointer-accel pipeline, applies the user's
        // "Tracking speed" curve, moves the cursor itself, and clamps to
        // display bounds. Setting mouseCursorPosition alongside the delta
        // (as we did before) made macOS warp to the absolute coordinate
        // and bypass the accel curve entirely — that's why the previous
        // attempt felt like raw pixel-by-pixel motion. Barrier and
        // Multi.app use this same delta-only pattern.
        guard let event = CGEvent(source: cursorEventSource) else { return }
        event.type = .mouseMoved
        event.setIntegerValueField(.mouseEventDeltaX, value: Int64(dx.rounded()))
        event.setIntegerValueField(.mouseEventDeltaY, value: Int64(dy.rounded()))
        event.setDoubleValueField(.mouseEventDeltaX, value: Double(dx))
        event.setDoubleValueField(.mouseEventDeltaY, value: Double(dy))
        eventPoster(event)
    }

    private func postClick(_ button: NormalizedInput.MouseButton) {
        let location = currentLocation()
        switch button {
        case .left:
            postMouseEvent(.leftMouseDown, at: location, button: .left)
            postMouseEvent(.leftMouseUp, at: location, button: .left)
        case .right, .double:
            // R10 territory.
            break
        }
    }

    private func postScroll(dx: Float, dy: Float, phase: NormalizedInput.ScrollPhase) {
        // Vertical only for now (wheelCount=1). Accumulate fractional dy so
        // a stream of sub-pixel deltas (slow precision drag) still emits
        // events at the integer threshold rather than rounding each call
        // independently to zero. Truncate toward zero so emitted pixels
        // never exceed the accumulated input.
        scrollRemainder += CGFloat(dy)
        let dyInt = Int32(scrollRemainder.rounded(.towardZero))
        scrollRemainder -= CGFloat(dyInt)
        // Skip zero-delta posts only for continuous "changed" phases. The
        // delimiter phases (began / ended / momentumBegan / momentumEnded)
        // carry phase info macOS needs even when their delta is zero.
        let isDelimiter = phase != .changed && phase != .momentumChanged
        if dyInt == 0 && !isDelimiter { return }
        guard let event = CGEvent(
            scrollWheelEvent2Source: nil,
            units: .pixel,
            wheelCount: 1,
            wheel1: dyInt,
            wheel2: 0,
            wheel3: 0
        ) else { return }
        let (scrollPhase, momentumPhase) = cgPhaseValues(phase)
        event.setIntegerValueField(.scrollWheelEventScrollPhase, value: scrollPhase)
        event.setIntegerValueField(.scrollWheelEventMomentumPhase, value: momentumPhase)
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

    private func postMouseEvent(_ type: CGEventType, at point: CGPoint, button: CGMouseButton) {
        guard let event = CGEvent(
            mouseEventSource: nil,
            mouseType: type,
            mouseCursorPosition: point,
            mouseButton: button
        ) else { return }
        eventPoster(event)
    }
}
