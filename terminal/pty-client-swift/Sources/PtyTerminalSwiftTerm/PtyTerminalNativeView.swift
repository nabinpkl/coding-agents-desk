import SwiftTerm

#if canImport(AppKit)
import AppKit

final class PtyTerminalNativeView: TerminalView {
    var pasteHandler: ((String) -> Void)?

    override func paste(_ sender: Any) {
        guard let text = NSPasteboard.general.string(forType: .string) else { return }
        pasteHandler?(text)
    }
}
#elseif canImport(UIKit)
import UIKit

final class PtyTerminalNativeView: TerminalView, UIGestureRecognizerDelegate {
    var interactionHandler: (() -> Void)?
    private enum WheelDirection {
        case up
        case down
    }

    private enum MouseWheel {
        static let stepDistance: CGFloat = 18

        static func gridPosition(
            point: CGPoint,
            bounds: CGRect,
            columns: Int,
            rows: Int
        ) -> (column: Int, row: Int) {
            let safeColumns = max(columns, 1)
            let safeRows = max(rows, 1)
            guard bounds.width > 0, bounds.height > 0 else { return (0, 0) }

            let clampedX = min(max(point.x, 0), bounds.width.nextDown)
            let clampedY = min(max(point.y, 0), bounds.height.nextDown)
            let column = min(max(Int((clampedX / bounds.width) * CGFloat(safeColumns)), 0), safeColumns - 1)
            let row = min(max(Int((clampedY / bounds.height) * CGFloat(safeRows)), 0), safeRows - 1)
            return (column, row)
        }
    }

    private var terminalWheelPanGesture: UIPanGestureRecognizer?
    private var wheelRemainderY: CGFloat = 0

    func installInteractionTracking() {
        let recognizer = UITapGestureRecognizer(
            target: self,
            action: #selector(handleInteractionTap(_:))
        )
        recognizer.cancelsTouchesInView = false
        recognizer.delegate = self
        addGestureRecognizer(recognizer)
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldReceive touch: UITouch
    ) -> Bool {
        interactionHandler?()
        return true
    }

    @objc private func handleInteractionTap(_ recognizer: UITapGestureRecognizer) {}

    override func mouseModeChanged(source: Terminal) {
        if source.mouseMode != .off {
            enableTerminalWheelPanGesture()
        } else {
            disableTerminalWheelPanGesture()
        }
    }

    private func enableTerminalWheelPanGesture() {
        guard terminalWheelPanGesture == nil else { return }
        let gesture = UIPanGestureRecognizer(target: self, action: #selector(handleTerminalWheelPan(_:)))
        gesture.cancelsTouchesInView = true
        gesture.maximumNumberOfTouches = 1
        addGestureRecognizer(gesture)
        panGestureRecognizer.require(toFail: gesture)
        terminalWheelPanGesture = gesture
    }

    private func disableTerminalWheelPanGesture() {
        guard let terminalWheelPanGesture else { return }
        removeGestureRecognizer(terminalWheelPanGesture)
        self.terminalWheelPanGesture = nil
        wheelRemainderY = 0
    }

    @objc private func handleTerminalWheelPan(_ gesture: UIPanGestureRecognizer) {
        switch gesture.state {
        case .began:
            interactionHandler?()
            wheelRemainderY = 0
            gesture.setTranslation(.zero, in: self)
        case .changed:
            let translation = gesture.translation(in: self)
            gesture.setTranslation(.zero, in: self)
            wheelRemainderY += translation.y
            flushWheelEvents(at: gesture.location(in: self))
        case .cancelled, .ended, .failed:
            wheelRemainderY = 0
        default:
            break
        }
    }

    private func flushWheelEvents(at location: CGPoint) {
        guard abs(wheelRemainderY) >= MouseWheel.stepDistance else { return }

        let terminal = getTerminal()
        let grid = MouseWheel.gridPosition(
            point: location,
            bounds: bounds,
            columns: terminal.cols,
            rows: terminal.rows
        )

        while abs(wheelRemainderY) >= MouseWheel.stepDistance {
            let direction: WheelDirection = wheelRemainderY > 0 ? .up : .down
            sendWheelEvent(direction: direction, column: grid.column, row: grid.row)
            wheelRemainderY += direction == .up ? -MouseWheel.stepDistance : MouseWheel.stepDistance
        }
    }

    private func sendWheelEvent(direction: WheelDirection, column: Int, row: Int) {
        let terminal = getTerminal()
        let button = direction == .up ? 4 : 5
        let buttonFlags = terminal.encodeButton(
            button: button,
            release: false,
            shift: false,
            meta: false,
            control: false
        )
        terminal.sendEvent(buttonFlags: buttonFlags, x: column, y: row)
    }
}
#endif
