import UIKit

// R9.2 SPEC §13 module. Owns the UIKit gesture recognizers on the trackpad
// zone and emits NormalizedInput to its delegate. Only cursorMove and
// click(.left) are produced in R9; two-finger and modifier-arm slots are
// reserved on the enum but not wired here yet.

protocol GestureTranslatorDelegate: AnyObject {
    @MainActor func gestureTranslator(_ translator: GestureTranslator, didProduce input: NormalizedInput)
}

@MainActor
final class GestureTranslator: NSObject {
    weak var delegate: GestureTranslatorDelegate?
    // The pan recognizer reports cumulative translation, but we want
    // deltas-since-last-callback so the receiver can integrate them as
    // relative cursor motion without knowing the trackpad size.
    private var lastPanTranslation: CGPoint = .zero

    func attach(to view: UIView) {
        view.isUserInteractionEnabled = true
        let pan = UIPanGestureRecognizer(target: self, action: #selector(handlePanGesture(_:)))
        pan.minimumNumberOfTouches = 1
        pan.maximumNumberOfTouches = 1
        view.addGestureRecognizer(pan)

        let tap = UITapGestureRecognizer(target: self, action: #selector(handleTapGesture(_:)))
        tap.numberOfTouchesRequired = 1
        tap.numberOfTapsRequired = 1
        view.addGestureRecognizer(tap)
    }

    // Pure functions over (state, translation) so tests can drive them
    // without a live UIWindow attaching synthetic touches. The @objc shims
    // below pull the gesture's current state and forward in.
    func processPan(state: UIGestureRecognizer.State, translation: CGPoint) {
        switch state {
        case .began:
            lastPanTranslation = translation
        case .changed:
            let dx = Float(translation.x - lastPanTranslation.x)
            let dy = Float(translation.y - lastPanTranslation.y)
            lastPanTranslation = translation
            if dx != 0 || dy != 0 {
                delegate?.gestureTranslator(self, didProduce: .cursorMove(dx: dx, dy: dy))
            }
        case .ended, .cancelled, .failed:
            lastPanTranslation = .zero
        default:
            break
        }
    }

    func processTap(state: UIGestureRecognizer.State) {
        guard state == .ended else { return }
        delegate?.gestureTranslator(self, didProduce: .click(button: .left))
    }

    @objc private func handlePanGesture(_ gesture: UIPanGestureRecognizer) {
        guard let view = gesture.view else { return }
        processPan(state: gesture.state, translation: gesture.translation(in: view))
    }

    @objc private func handleTapGesture(_ gesture: UITapGestureRecognizer) {
        processTap(state: gesture.state)
    }
}
