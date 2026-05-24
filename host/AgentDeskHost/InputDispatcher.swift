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
    typealias DisplayBoundsProvider = () -> CGRect

    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "input")
    private let eventPoster: EventPoster
    private let isTrusted: () -> Bool
    private let locationProvider: LocationProvider
    private let displayBoundsProvider: DisplayBoundsProvider
    private var loggedUntrusted = false
    // Sub-pixel scroll deltas (precision drags after lowering the iPhone
    // scroll gain floor to 1.0) round to zero individually and would never
    // emit. Accumulate the fractional remainder across calls so they
    // eventually trip the threshold and emit a single-pixel event.
    private var scrollRemainder: CGFloat = 0

    init(
        eventPoster: @escaping EventPoster = { $0.post(tap: .cghidEventTap) },
        isTrusted: @escaping () -> Bool = { AXIsProcessTrusted() },
        locationProvider: @escaping LocationProvider = { CGEvent(source: nil)?.location ?? .zero },
        displayBoundsProvider: @escaping DisplayBoundsProvider = { CGDisplayBounds(CGMainDisplayID()) }
    ) {
        self.eventPoster = eventPoster
        self.isTrusted = isTrusted
        self.locationProvider = locationProvider
        self.displayBoundsProvider = displayBoundsProvider
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
        let current = currentLocation()
        let raw = CGPoint(x: current.x + dx, y: current.y + dy)
        let next = clamp(raw, to: displayBoundsProvider())
        guard let event = CGEvent(
            mouseEventSource: nil,
            mouseType: .mouseMoved,
            mouseCursorPosition: next,
            mouseButton: .left
        ) else { return }
        eventPoster(event)
    }

    private func clamp(_ point: CGPoint, to bounds: CGRect) -> CGPoint {
        // maxX - 1 / maxY - 1 because CGDisplayBounds is exclusive on the
        // far edges; posting at exactly maxX has been seen to flick the
        // cursor onto an adjacent display in multi-monitor setups.
        CGPoint(
            x: min(max(bounds.minX, point.x), bounds.maxX - 1),
            y: min(max(bounds.minY, point.y), bounds.maxY - 1)
        )
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
