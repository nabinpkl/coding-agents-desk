import QuartzCore
import UIKit

// R9.2 SPEC §13 module. Owns the UIKit gesture recognizers on the trackpad
// zone and emits NormalizedInput to its delegate. Only cursorMove and
// click(.left) are produced in R9; two-finger and modifier-arm slots are
// reserved on the enum but not wired here yet.

protocol GestureTranslatorDelegate: AnyObject {
    @MainActor func gestureTranslator(_ translator: GestureTranslator, didProduce input: NormalizedInput)
}

// UIPanGestureRecognizer waits ~10 points of finger travel before recognizing.
// That feels like "I have to press into the strip to start scrolling" on the
// scroll strip where users expect Mac-trackpad-style instant response. This
// subclass promotes to .began on touchDown so the first move event is
// translated 1:1, with no swallowed slop.
final class InstantPanGestureRecognizer: UIPanGestureRecognizer {
    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesBegan(touches, with: event)
        if state == .possible { state = .began }
    }

    // Without this override, forcing .began in touchesBegan can leave the
    // recognizer in a half-state where touchesMoved arrives but the parent
    // recognizer never transitions to .changed (because its internal pan
    // tracker is still waiting to "cross slop"). Promote to .changed on
    // first movement so the action target sees the deltas.
    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesMoved(touches, with: event)
        if state == .began { state = .changed }
    }
}

// Cursor trackpad variant: the default ~10pt slop swallows rapid micro-
// drags entirely (gesture .fails before crossing slop, no cursor move
// emitted), but zero-slop InstantPan amplifies orthogonal finger tremor
// into visible cursor stutter. 3pt is the middle ground: still above
// typical finger tremor (~1pt) so the cursor doesn't jitter on a still
// touch, but small enough that intentional 3-10pt drags register.
final class SmallSlopPanGestureRecognizer: UIPanGestureRecognizer {
    private static let slopThreshold: CGFloat = 3.0
    private var startLocation: CGPoint?

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesBegan(touches, with: event)
        startLocation = touches.first?.location(in: view)
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesMoved(touches, with: event)
        guard let touch = touches.first,
              let view = view,
              let start = startLocation else { return }
        let current = touch.location(in: view)
        let distance = hypot(current.x - start.x, current.y - start.y)
        if state == .possible && distance >= Self.slopThreshold {
            state = .began
        } else if state == .began {
            state = .changed
        }
    }

    override func reset() {
        super.reset()
        startLocation = nil
    }
}

// Acceleration curve over the iPhone's hardware touch velocity (points per
// second from UIPanGestureRecognizer.velocity). Slow drags keep a small
// floor so precision still works; fast flicks multiply much more so the
// cursor can cross the Mac display in a single sweep without exhausting
// the iPhone's trackpad zone.
struct GestureAcceleration: Sendable {
    let scale: @Sendable (CGFloat) -> CGFloat

    static let identity = GestureAcceleration { _ in 1.0 }

    // Approximation of Mac trackpad pointer accel applied client-side.
    // The IOKit-level macOS pointer-accel curve doesn't run on CGEvents we
    // post from userspace, so we shape the deltas before sending.
    //
    // Floor 1.5 keeps base motion smooth and lets the UIPan slop filter
    // orthogonal finger tremor (lowering it to 1.0 previously caused
    // visible cursor stutter). Steeper top end so a hard flick lands at
    // the far edge of the Mac display in one sweep.
    //   0     -> 1.5  (precision floor)
    //   200   -> 2.5
    //   500   -> 4.0
    //   1000  -> 6.5
    //   1700+ -> 10.0 (fast flick, capped)
    static let mac = GestureAcceleration { velocity in
        1.5 + min(velocity * 0.005, 8.5)
    }

    // Vertical scroll curve. Floor sits at 1.0 so a glacial finger drag is
    // near 1:1 with the Mac scroll position (the precision range), and
    // velocity carries the multiplier up for normal reading and flicks.
    // Previous 3.0 floor amplified every move and killed precision.
    //   0     -> 1.0  (true precision)
    //   500   -> 2.25 (typical drag)
    //   2000+ -> 6.0  (flick, capped)
    static let scroll = GestureAcceleration { velocity in
        1.0 + min(velocity * 0.0025, 5.0)
    }
}

@MainActor
final class GestureTranslator: NSObject {
    weak var delegate: GestureTranslatorDelegate?
    private let acceleration: GestureAcceleration
    private let scrollAcceleration: GestureAcceleration
    // User-tunable multipliers driven by SettingsViewController via
    // SettingsStore. PairingViewController sets these on store changes.
    // 1.0 = default behavior; sliders cover 0.5x - 3.0x.
    var cursorSpeedMultiplier: CGFloat = 1.0
    var cursorAccelMultiplier: CGFloat = 1.0
    var scrollSpeedMultiplier: CGFloat = 1.0
    // When true, scroll dy is negated before emission so a finger flick
    // up moves content down (traditional / mouse-wheel-style). Default
    // false = natural / iOS scroll.
    var scrollInverted: Bool = false
    // The pan recognizer reports cumulative translation, but we want
    // deltas-since-last-callback so the receiver can integrate them as
    // relative cursor motion without knowing the trackpad size.
    private var lastPanTranslation: CGPoint = .zero
    private var lastScrollTranslation: CGPoint = .zero
    // Momentum: after the finger lifts with non-trivial velocity, emit
    // decaying scroll events on a display link until velocity falls below
    // the cutoff. Approximates the Mac trackpad's inertia tail.
    private var momentumDisplayLink: CADisplayLink?
    private var momentumVelocity: CGFloat = 0
    private var momentumLastTime: CFTimeInterval = 0
    // UIPanGestureRecognizer.velocity(in:) at .ended is unreliable: it can
    // be 0 or a stale sample even after a hard flick. Capture velocity at
    // every .changed callback and use the most recent non-zero value as
    // the momentum seed at .ended.
    private var lastScrollVelocityY: CGFloat = 0
    // The first emitted scroll event of a touch drag carries phase=.began;
    // subsequent ones carry .changed. Reset at each gesture .began.
    private var didEmitScrollBegan = false
    // Same idea for the inertia tail.
    private var didEmitMomentumBegan = false
    // Velocity threshold (points/sec) below which a finger-lift is treated
    // as a slow drag finishing, not a flick. No momentum below this.
    private static let momentumFlickThreshold: CGFloat = 200
    // Velocity threshold (points/sec) below which momentum stops on its
    // own. ~30 px/sec is about one pixel every two frames; visually static.
    private static let momentumStopThreshold: CGFloat = 30
    // Exponential decay k. With k=4: half-life ~173ms, ~13% at 500ms,
    // fully spent by ~700ms. Close to Mac trackpad inertia feel.
    private static let momentumDecayK: CGFloat = 4

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
        // 3pt slop: filters tremor (which is sub-pixel) while letting
        // rapid micro-drags register. The standard 10pt slop was causing
        // user-reported "fails to register on rapid finger lift and use".
        let pan = SmallSlopPanGestureRecognizer(target: self, action: #selector(handlePanGesture(_:)))
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
        // InstantPan eliminates the ~10pt slop before .began fires, so first
        // finger move maps 1:1 to first scroll event.
        let pan = InstantPanGestureRecognizer(target: self, action: #selector(handleScrollGesture(_:)))
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
            let gain = acceleration.scale(speed) * cursorAccelMultiplier
            let dx = Float(rawDx * gain * cursorSpeedMultiplier)
            let dy = Float(rawDy * gain * cursorSpeedMultiplier)
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
            // A fresh touch on the scroll strip cancels any in-flight
            // momentum (matches the Mac trackpad: touching aborts inertia).
            stopMomentum(emitEnd: true)
            lastScrollTranslation = translation
            lastScrollVelocityY = 0
            didEmitScrollBegan = false
        case .changed:
            let rawDy = translation.y - lastScrollTranslation.y
            lastScrollTranslation = translation
            if velocity.y != 0 { lastScrollVelocityY = velocity.y }
            if rawDy == 0 { return }
            let speed = abs(velocity.y)
            let gain = scrollAcceleration.scale(speed)
            let sign: CGFloat = scrollInverted ? -1.0 : 1.0
            let dy = Float(rawDy * gain * scrollSpeedMultiplier * sign)
            let phase: NormalizedInput.ScrollPhase = didEmitScrollBegan ? .changed : .began
            didEmitScrollBegan = true
            delegate?.gestureTranslator(self, didProduce: .scroll(dx: 0, dy: dy, phase: phase))
        case .ended:
            lastScrollTranslation = .zero
            // Tell macOS the touch drag has ended even when no actual
            // movement occurred; without this, the next drag's .began
            // event can be coalesced into the previous gesture.
            if didEmitScrollBegan {
                delegate?.gestureTranslator(self, didProduce: .scroll(dx: 0, dy: 0, phase: .ended))
            }
            didEmitScrollBegan = false
            // Recognizer-reported velocity at .ended is unreliable. Prefer
            // the last non-zero velocity sampled during .changed; fall back
            // to whatever the recognizer reports if that's all we have.
            let liftV = lastScrollVelocityY != 0 ? lastScrollVelocityY : velocity.y
            if abs(liftV) >= Self.momentumFlickThreshold {
                startMomentum(initialVelocity: liftV)
            }
        case .cancelled, .failed:
            lastScrollTranslation = .zero
            if didEmitScrollBegan {
                delegate?.gestureTranslator(self, didProduce: .scroll(dx: 0, dy: 0, phase: .ended))
            }
            didEmitScrollBegan = false
        default:
            break
        }
    }

    private func startMomentum(initialVelocity: CGFloat) {
        stopMomentum(emitEnd: false)
        momentumVelocity = initialVelocity
        momentumLastTime = CACurrentMediaTime()
        didEmitMomentumBegan = false
        let link = CADisplayLink(target: self, selector: #selector(tickMomentum(_:)))
        link.add(to: .main, forMode: .common)
        momentumDisplayLink = link
    }

    private func stopMomentum(emitEnd: Bool) {
        let wasRunning = momentumDisplayLink != nil
        momentumDisplayLink?.invalidate()
        momentumDisplayLink = nil
        momentumVelocity = 0
        if emitEnd && wasRunning && didEmitMomentumBegan {
            delegate?.gestureTranslator(self, didProduce: .scroll(dx: 0, dy: 0, phase: .momentumEnded))
        }
        didEmitMomentumBegan = false
    }

    @objc private func tickMomentum(_ link: CADisplayLink) {
        let now = CACurrentMediaTime()
        let dt = CGFloat(now - momentumLastTime)
        momentumLastTime = now
        // v(t) = v0 * e^(-k*dt) per frame. Applied incrementally so frame
        // rate variation doesn't change the overall decay curve.
        momentumVelocity *= exp(-Self.momentumDecayK * dt)
        if abs(momentumVelocity) < Self.momentumStopThreshold {
            stopMomentum(emitEnd: true)
            return
        }
        let rawDy = momentumVelocity * dt
        let gain = scrollAcceleration.scale(abs(momentumVelocity))
        let sign: CGFloat = scrollInverted ? -1.0 : 1.0
        let dy = Float(rawDy * gain * scrollSpeedMultiplier * sign)
        let phase: NormalizedInput.ScrollPhase = didEmitMomentumBegan ? .momentumChanged : .momentumBegan
        didEmitMomentumBegan = true
        delegate?.gestureTranslator(self, didProduce: .scroll(dx: 0, dy: dy, phase: phase))
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
