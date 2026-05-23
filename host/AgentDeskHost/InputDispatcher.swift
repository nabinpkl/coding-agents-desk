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

    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "input")
    private let eventPoster: EventPoster
    private let isTrusted: () -> Bool
    private var loggedUntrusted = false

    init(
        eventPoster: @escaping EventPoster = { $0.post(tap: .cghidEventTap) },
        isTrusted: @escaping () -> Bool = { AXIsProcessTrusted() }
    ) {
        self.eventPoster = eventPoster
        self.isTrusted = isTrusted
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
        case .scroll, .dragStart, .dragEnd, .switchSpace, .key, .modifierArm:
            // Out of scope for R9. Wired in later iterations.
            break
        }
    }

    private func currentLocation() -> CGPoint {
        CGEvent(source: nil)?.location ?? .zero
    }

    private func postCursorMove(dx: CGFloat, dy: CGFloat) {
        let current = currentLocation()
        let next = CGPoint(x: current.x + dx, y: current.y + dy)
        guard let event = CGEvent(
            mouseEventSource: nil,
            mouseType: .mouseMoved,
            mouseCursorPosition: next,
            mouseButton: .left
        ) else { return }
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
