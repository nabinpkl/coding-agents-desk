import UIKit

// R9.2 SPEC §13 module. Owns the UIKit gesture recognizers on the trackpad
// zone and emits NormalizedInput to its delegate. Only cursorMove and
// click(.left) are produced in R9; two-finger and modifier-arm slots are
// reserved on the enum but not wired here yet.

protocol GestureTranslatorDelegate: AnyObject {
    @MainActor func gestureTranslator(_ translator: GestureTranslator, didProduce input: NormalizedInput)
}

// Acceleration curve over the iPhone's hardware touch velocity (points per
// second from UIPanGestureRecognizer.velocity). Slow drags keep a small
// floor so precision still works; fast flicks multiply much more so the
// cursor can cross the Mac display in a single sweep without exhausting
// the iPhone's trackpad zone.
struct GestureAcceleration: Sendable {
    let scale: @Sendable (CGFloat) -> CGFloat

    static let identity = GestureAcceleration { _ in 1.0 }

    // Linear ramp with a precision floor and a flick ceiling. Numbers below
    // are points per second. The previous curve compounded ~26x gain across
    // many high-velocity callbacks during a flick and rocketed the cursor
    // off the screen; this version caps at 6.5x so a multi-callback flick
    // still lands within a typical 1500-pixel Mac display.
    //   0     -> 1.5  (precision floor)
    //   200   -> 2.1  (pixel-level work)
    //   800   -> 3.9  (typical drag)
    //   1700+ -> 6.5  (fast drag / flick, capped)
    static let mac = GestureAcceleration { velocity in
        1.5 + min(velocity * 0.003, 5.0)
    }

    // Vertical scroll curve. Tuned for code/document reading rather than
    // screen-traversal: a slow finger drag of one screen-height should
    // produce roughly half a screen of content scroll; a flick should
    // produce one to two screens.
    //   0     -> 3.0
    //   500   -> 5.0
    //   2000+ -> 8.0 (capped)
    static let scroll = GestureAcceleration { velocity in
        3.0 + min(velocity * 0.004, 5.0)
    }
}

@MainActor
final class GestureTranslator: NSObject {
    weak var delegate: GestureTranslatorDelegate?
    private let acceleration: GestureAcceleration
    private let scrollAcceleration: GestureAcceleration
    // The pan recognizer reports cumulative translation, but we want
    // deltas-since-last-callback so the receiver can integrate them as
    // relative cursor motion without knowing the trackpad size.
    private var lastPanTranslation: CGPoint = .zero
    private var lastScrollTranslation: CGPoint = .zero

    init(
        acceleration: GestureAcceleration = .identity,
        scrollAcceleration: GestureAcceleration = .identity
    ) {
        self.acceleration = acceleration
        self.scrollAcceleration = scrollAcceleration
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

    func attachScrollStrip(to view: UIView) {
        view.isUserInteractionEnabled = true
        let pan = UIPanGestureRecognizer(target: self, action: #selector(handleScrollGesture(_:)))
        pan.minimumNumberOfTouches = 1
        pan.maximumNumberOfTouches = 1
        view.addGestureRecognizer(pan)
    }

    // Pure functions over (state, translation, velocity) so tests can drive
    // them without a live UIWindow attaching synthetic touches. The @objc
    // shims below pull the gesture's current state and velocity in points
    // per second from UIPanGestureRecognizer.
    func processPan(state: UIGestureRecognizer.State, translation: CGPoint, velocity: CGPoint = .zero) {
        switch state {
        case .began:
            lastPanTranslation = translation
        case .changed:
            let rawDx = translation.x - lastPanTranslation.x
            let rawDy = translation.y - lastPanTranslation.y
            lastPanTranslation = translation
            if rawDx == 0 && rawDy == 0 { return }
            let speed = (velocity.x * velocity.x + velocity.y * velocity.y).squareRoot()
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

    // Right-edge scroll strip pan. Vertical only; horizontal scrolling is
    // not in R10 scope. dy is in iPhone screen coords (positive = finger
    // moved down). InputDispatcher handles the sign translation to CGEvent
    // scroll wheel conventions.
    func processScrollPan(state: UIGestureRecognizer.State, translation: CGPoint, velocity: CGPoint = .zero) {
        switch state {
        case .began:
            lastScrollTranslation = translation
        case .changed:
            let rawDy = translation.y - lastScrollTranslation.y
            lastScrollTranslation = translation
            if rawDy == 0 { return }
            let speed = abs(velocity.y)
            let gain = scrollAcceleration.scale(speed)
            let dy = Float(rawDy * gain)
            delegate?.gestureTranslator(self, didProduce: .scroll(dx: 0, dy: dy))
        case .ended, .cancelled, .failed:
            lastScrollTranslation = .zero
        default:
            break
        }
    }

    @objc private func handlePanGesture(_ gesture: UIPanGestureRecognizer) {
        guard let view = gesture.view else { return }
        processPan(
            state: gesture.state,
            translation: gesture.translation(in: view),
            velocity: gesture.velocity(in: view)
        )
    }

    @objc private func handleTapGesture(_ gesture: UITapGestureRecognizer) {
        processTap(state: gesture.state)
    }

    @objc private func handleScrollGesture(_ gesture: UIPanGestureRecognizer) {
        guard let view = gesture.view else { return }
        processScrollPan(
            state: gesture.state,
            translation: gesture.translation(in: view),
            velocity: gesture.velocity(in: view)
        )
    }
}
