import UIKit

// R9.2 SPEC §13 module. Owns the UIKit gesture recognizers on the trackpad
// zone and emits NormalizedInput to its delegate. Only cursorMove and
// click(.left) are produced in R9; two-finger and modifier-arm slots are
// reserved on the enum but not wired here yet.

protocol GestureTranslatorDelegate: AnyObject {
    @MainActor func gestureTranslator(_ translator: GestureTranslator, didProduce input: NormalizedInput)
}

// Velocity-scaled gain curve. Slow finger moves keep a small floor so
// precision dragging still works; fast moves multiply more aggressively so
// the cursor can cross the Mac display in a single sweep without exhausting
// the iPhone's trackpad zone. Speed is in points-per-changed-callback, which
// at the ~60 Hz delivery rate is roughly velocity / 60.
struct GestureAcceleration: Sendable {
    let scale: @Sendable (CGFloat) -> CGFloat

    static let identity = GestureAcceleration { _ in 1.0 }

    // Linear ramp with a floor and a ceiling. Tuned by feel against the
    // iPhone trackpad zone, not derived from macOS internals.
    //   speed = 1   -> gain 2.3 (precision-friendly)
    //   speed = 5   -> gain 3.5
    //   speed = 15+ -> gain 6.0 (clamped)
    static let mac = GestureAcceleration { speed in
        2.0 + min(speed * 0.3, 4.0)
    }
}

@MainActor
final class GestureTranslator: NSObject {
    weak var delegate: GestureTranslatorDelegate?
    private let acceleration: GestureAcceleration
    // The pan recognizer reports cumulative translation, but we want
    // deltas-since-last-callback so the receiver can integrate them as
    // relative cursor motion without knowing the trackpad size.
    private var lastPanTranslation: CGPoint = .zero

    init(acceleration: GestureAcceleration = .identity) {
        self.acceleration = acceleration
        super.init()
    }

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
            let rawDx = translation.x - lastPanTranslation.x
            let rawDy = translation.y - lastPanTranslation.y
            lastPanTranslation = translation
            if rawDx == 0 && rawDy == 0 { return }
            let speed = (rawDx * rawDx + rawDy * rawDy).squareRoot()
            let gain = acceleration.scale(speed)
            let dx = Float(rawDx * gain)
            let dy = Float(rawDy * gain)
            delegate?.gestureTranslator(self, didProduce: .cursorMove(dx: dx, dy: dy))
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
