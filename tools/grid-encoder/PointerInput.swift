import ApplicationServices
import CoreGraphics
import Foundation
import QuartzCore

/// The native last hop for the live RTP tile's relative pointer mode.
///
/// Gesture recognition and acceleration stay in TypeScript. This process owns only the state
/// macOS requires to turn those normalized commands into coherent CGEvents: an integrated cursor
/// position, click count, fractional scroll remainders, and phase fields.
// Constructed before the stdin thread starts, then mutated only by that one reader thread.
// `isTrusted` is the only main-task read and does not touch controller state.
final class PointerInputController: @unchecked Sendable {
    private let bounds: CGRect
    private let source: CGEventSource?
    private var cursorPosition: CGPoint?
    private var lastCursorMoveTime: CFTimeInterval = 0
    private var lastLeftClickTime: CFTimeInterval = 0
    private var lastLeftClickLocation: CGPoint = .zero
    private var lastLeftClickState: Int64 = 0
    private var scrollRemainderX: CGFloat = 0
    private var scrollRemainderY: CGFloat = 0
    private var scrollActive = false
    private var loggedUntrusted = false

    private static let cursorResyncIdleInterval: CFTimeInterval = 0.2
    private static let doubleClickInterval: CFTimeInterval = 0.5
    private static let doubleClickRadius: CGFloat = 5
    private static let maximumDelta: CGFloat = 10_000

    init(bounds: CGRect) {
        self.bounds = bounds
        let source = CGEventSource(stateID: .hidSystemState)
        source?.localEventsSuppressionInterval = 0
        self.source = source
    }

    var isTrusted: Bool { AXIsProcessTrusted() }

    /// Returns true when the line belongs to the pointer protocol, including a malformed command
    /// with a known verb. Encoder commands can then be considered only when this returns false.
    @discardableResult
    func handle(_ line: String) -> Bool {
        let fields = line.split(separator: " ", omittingEmptySubsequences: true)
        guard let verb = fields.first else { return false }
        switch verb {
        case "M":
            guard fields.count == 3,
                  let dx = bounded(fields[1]),
                  let dy = bounded(fields[2]) else { return true }
            withTrust { move(dx: dx, dy: dy) }
            return true
        case "C":
            guard fields.count == 2 else { return true }
            withTrust {
                if fields[1] == "L" { click(.left) }
                else if fields[1] == "R" { click(.right) }
            }
            return true
        case "S":
            guard fields.count == 4,
                  let dx = bounded(fields[1]),
                  let dy = bounded(fields[2]),
                  let phase = scrollPhase(String(fields[3])) else { return true }
            withTrust { scroll(dx: dx, dy: dy, phase: phase) }
            return true
        case "X":
            withTrust { reset() }
            return true
        default:
            return false
        }
    }

    private func withTrust(_ work: () -> Void) {
        guard isTrusted else {
            if !loggedUntrusted {
                FileHandle.standardError.write(Data("grid-encoder: Accessibility not granted; dropping pointer input\n".utf8))
                loggedUntrusted = true
            }
            return
        }
        loggedUntrusted = false
        work()
    }

    private func bounded(_ raw: Substring) -> CGFloat? {
        guard let value = Double(raw), value.isFinite, abs(value) <= Self.maximumDelta else {
            return nil
        }
        return CGFloat(value)
    }

    private func cursorBase() -> CGPoint {
        let now = CACurrentMediaTime()
        if let cursorPosition, now - lastCursorMoveTime <= Self.cursorResyncIdleInterval {
            return cursorPosition
        }
        return CGEvent(source: nil)?.location ?? bounds.origin
    }

    private func move(dx: CGFloat, dy: CGFloat) {
        let base = cursorBase()
        let next = clamp(CGPoint(x: base.x + dx, y: base.y + dy))
        cursorPosition = next
        lastCursorMoveTime = CACurrentMediaTime()
        guard let event = CGEvent(
            mouseEventSource: source,
            mouseType: .mouseMoved,
            mouseCursorPosition: next,
            mouseButton: .left
        ) else { return }
        event.flags = []
        event.post(tap: .cghidEventTap)
    }

    private func clamp(_ point: CGPoint) -> CGPoint {
        CGPoint(
            x: min(max(bounds.minX, point.x), bounds.maxX - 1),
            y: min(max(bounds.minY, point.y), bounds.maxY - 1)
        )
    }

    private func click(_ button: CGMouseButton) {
        let location = cursorBase()
        if button == .left {
            let state = nextLeftClickState(at: location)
            postClick(.leftMouseDown, at: location, button: .left, clickState: state)
            postClick(.leftMouseUp, at: location, button: .left, clickState: state)
        } else {
            postClick(.rightMouseDown, at: location, button: .right, clickState: 1)
            postClick(.rightMouseUp, at: location, button: .right, clickState: 1)
        }
    }

    private func postClick(
        _ type: CGEventType,
        at point: CGPoint,
        button: CGMouseButton,
        clickState: Int64
    ) {
        guard let event = CGEvent(
            mouseEventSource: source,
            mouseType: type,
            mouseCursorPosition: point,
            mouseButton: button
        ) else { return }
        event.flags = []
        event.setIntegerValueField(.mouseEventClickState, value: clickState)
        event.post(tap: .cghidEventTap)
    }

    private func nextLeftClickState(at location: CGPoint) -> Int64 {
        let now = CACurrentMediaTime()
        let distance = hypot(
            location.x - lastLeftClickLocation.x,
            location.y - lastLeftClickLocation.y
        )
        let state = now - lastLeftClickTime <= Self.doubleClickInterval
            && distance <= Self.doubleClickRadius
            ? lastLeftClickState + 1
            : 1
        lastLeftClickTime = now
        lastLeftClickLocation = location
        lastLeftClickState = state
        return state
    }

    private enum ScrollPhase: Equatable {
        case began, changed, ended, momentumBegan, momentumChanged, momentumEnded
    }

    private func scrollPhase(_ raw: String) -> ScrollPhase? {
        switch raw {
        case "b": return .began
        case "c": return .changed
        case "e": return .ended
        case "mb": return .momentumBegan
        case "mc": return .momentumChanged
        case "me": return .momentumEnded
        default: return nil
        }
    }

    private func scroll(dx: CGFloat, dy: CGFloat, phase: ScrollPhase) {
        if phase == .began || phase == .ended || phase == .momentumEnded {
            scrollRemainderX = 0
            scrollRemainderY = 0
        }
        scrollActive = phase == .began || phase == .changed
        scrollRemainderX += dx
        scrollRemainderY += dy
        let dxInt = Int32(scrollRemainderX.rounded(.towardZero))
        let dyInt = Int32(scrollRemainderY.rounded(.towardZero))
        scrollRemainderX -= CGFloat(dxInt)
        scrollRemainderY -= CGFloat(dyInt)
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
        let values = cgPhaseValues(phase)
        event.setIntegerValueField(.scrollWheelEventScrollPhase, value: values.scroll)
        event.setIntegerValueField(.scrollWheelEventMomentumPhase, value: values.momentum)
        event.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
        event.post(tap: .cghidEventTap)
    }

    private func cgPhaseValues(_ phase: ScrollPhase) -> (scroll: Int64, momentum: Int64) {
        switch phase {
        case .began: return (1, 0)
        case .changed: return (2, 0)
        case .ended: return (4, 0)
        case .momentumBegan: return (0, 1)
        case .momentumChanged: return (0, 2)
        case .momentumEnded: return (0, 3)
        }
    }

    private func reset() {
        if scrollActive { scroll(dx: 0, dy: 0, phase: .ended) }
        scrollActive = false
        scrollRemainderX = 0
        scrollRemainderY = 0
        cursorPosition = nil
    }
}
