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
        case .scroll(let dx, let dy):
            postScroll(dx: dx, dy: dy)
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

    private func postScroll(dx: Float, dy: Float) {
        // Vertical only for now (wheelCount=1). Accumulate fractional dy so
        // a stream of sub-pixel deltas (slow precision drag) still emits
        // events at the integer threshold rather than rounding each call
        // independently to zero. Truncate toward zero so emitted pixels
        // never exceed the accumulated input.
        scrollRemainder += CGFloat(dy)
        let dyInt = Int32(scrollRemainder.rounded(.towardZero))
        scrollRemainder -= CGFloat(dyInt)
        if dyInt == 0 { return }
        guard let event = CGEvent(
            scrollWheelEvent2Source: nil,
            units: .pixel,
            wheelCount: 1,
            wheel1: dyInt,
            wheel2: 0,
            wheel3: 0
        ) else { return }
        eventPoster(event)
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
