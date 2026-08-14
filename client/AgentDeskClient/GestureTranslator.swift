import QuartzCore
import UIKit
import AgentDeskWire
import os

// R9.2 SPEC §13 module. Owns the UIKit gesture recognizers on the trackpad
// zone and emits NormalizedInput to its delegate. Only cursorMove and
// click(.left) are produced in R9; two-finger and modifier-arm slots are
// reserved on the enum but not wired here yet.
//
// File layout:
//   MARK: Recognizers       — UIKit gesture subclasses (Instant, Coalescing)
//   MARK: Tuning            — GestureTuning value type
//   MARK: Acceleration      — velocity-to-gain curves
//   MARK: Translator        — the main class that wires it all together

protocol GestureTranslatorDelegate: AnyObject {
    @MainActor func gestureTranslator(_ translator: GestureTranslator, didProduce input: NormalizedInput)
}

// MARK: - Recognizers

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

// Cursor trackpad recognizer. Reads UIEvent.coalescedTouches(for:) to pick
// up every hardware touch sample (up to 120Hz on ProMotion), but emits at
// the display refresh cadence via CADisplayLink rather than once per
// sample. Each tick sums all coalesced deltas since the previous tick
// and computes velocity as totalDelta / frameDt, so the acceleration
// curve sees a stable input instead of being whipsawed by per-sample dt
// jitter (raw inter-sample dt varies 1-8ms inside a single UIEvent, which
// previously produced visibly uneven cursor steps even on a smooth drag).
//
// Slop: 3pt cumulative from touchDown before any delta is accumulated, to
// filter quick taps and orthogonal finger tremor.
final class CoalescingTrackpadGestureRecognizer: UIPanGestureRecognizer {
    typealias SampleHandler = @MainActor (_ dx: CGFloat, _ dy: CGFloat, _ velocity: CGFloat) -> Void

    private static let slopThreshold: CGFloat = 3.0
    var onSampleDelta: SampleHandler?

    private var startLocation: CGPoint?
    private var lastLocation: CGPoint?
    private var didCrossSlop = false

    // Per-frame accumulator. Coalesced samples add into this; the display
    // link drains it on each tick.
    private var pendingDx: CGFloat = 0
    private var pendingDy: CGFloat = 0
    private var displayLink: CADisplayLink?
    private var lastTickTime: CFTimeInterval = 0

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesBegan(touches, with: event)
        guard let touch = touches.first, let view = view else { return }
        let p = touch.location(in: view)
        startLocation = p
        lastLocation = p
        didCrossSlop = false
        pendingDx = 0
        pendingDy = 0
        startDisplayLink()
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesMoved(touches, with: event)
        guard let touch = touches.first,
              let view = view,
              let start = startLocation else { return }

        let coalesced = event.coalescedTouches(for: touch) ?? [touch]
        for sample in coalesced {
            let p = sample.location(in: view)

            // Gate on cumulative distance from touchDown, not from the
            // last accumulated sample, so we don't swallow a large first
            // delta just because slop hasn't passed yet.
            if !didCrossSlop {
                let cumulative = hypot(p.x - start.x, p.y - start.y)
                if cumulative >= Self.slopThreshold {
                    didCrossSlop = true
                    if state == .possible { state = .began }
                } else {
                    lastLocation = p
                    continue
                }
            } else if state == .began {
                state = .changed
            }

            if let lastP = lastLocation {
                pendingDx += p.x - lastP.x
                pendingDy += p.y - lastP.y
            }
            lastLocation = p
        }
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesEnded(touches, with: event)
        flushPending()
        stopDisplayLink()
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesCancelled(touches, with: event)
        flushPending()
        stopDisplayLink()
    }

    override func reset() {
        super.reset()
        startLocation = nil
        lastLocation = nil
        didCrossSlop = false
        pendingDx = 0
        pendingDy = 0
        stopDisplayLink()
    }

    private func startDisplayLink() {
        stopDisplayLink()
        let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
        link.add(to: .main, forMode: .common)
        lastTickTime = CACurrentMediaTime()
        displayLink = link
    }

    private func stopDisplayLink() {
        displayLink?.invalidate()
        displayLink = nil
    }

    @objc private func tick(_ link: CADisplayLink) {
        let now = CACurrentMediaTime()
        let dt = max(now - lastTickTime, 0.001)
        lastTickTime = now
        emitPending(dt: dt)
    }

    private func flushPending() {
        // Drain any motion that arrived between the last tick and touch-up
        // so a short flick's tail isn't dropped. dt uses wall-clock since
        // the last tick, matching how a tick would have computed velocity.
        let now = CACurrentMediaTime()
        let dt = max(now - lastTickTime, 0.001)
        lastTickTime = now
        emitPending(dt: dt)
    }

    private func emitPending(dt: CFTimeInterval) {
        if pendingDx == 0 && pendingDy == 0 { return }
        let dx = pendingDx
        let dy = pendingDy
        pendingDx = 0
        pendingDy = 0
        let speed = hypot(dx, dy) / CGFloat(dt)
        onSampleDelta?(dx, dy, speed)
    }
}

// MARK: - Acceleration

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
    // velocity carries the multiplier up steeply so normal reading drags
    // and flicks cover real ground instead of crawling. The previous slope
    // (0.0025, cap 5) felt slow on device: a normal swipe only doubled.
    //   0     -> 1.0  (true precision)
    //   300   -> 2.35
    //   800   -> 4.6  (typical drag)
    //   1500  -> 7.75
    //   2667+ -> 12.0 (flick, capped)
    static let scroll = GestureAcceleration { velocity in
        1.0 + min(velocity * 0.0045, 11.0)
    }
}

// MARK: - Tuning

// Bundle of user-tunable knobs that affect emitted input. Driven by
// SettingsViewController via SettingsStore; PairingViewController copies
// the whole struct onto the translator on each settings change.
// 1.0 = default behavior; UI sliders cover 0.5x - 3.0x.
// scrollInverted=true negates scroll dy so a finger flick up moves content
// down (traditional / mouse-wheel-style). Default false = natural / iOS.
struct GestureTuning: Equatable, Sendable {
    var cursorSpeed: CGFloat = 1.0
    var cursorAcceleration: CGFloat = 1.0
    var scrollSpeed: CGFloat = 1.0
    var scrollInverted: Bool = false

    static let `default` = GestureTuning()
}

// MARK: - One-handed affordances
//
// Issue #6 originally called for two-finger right-click and two-finger
// scroll. Both were dropped because the v0 target user holds the phone
// in one hand and operates the trackpad with the thumb of the same
// hand; two fingers are not reachable. Substitutions ship the same wire
// shapes (NormalizedInput.click(.right), NormalizedInput.scroll) so the
// host is unaware of the affordance change:
//   right-click -> bottom-row [Right-click] button (PairingViewController)
//   scroll      -> right-edge strip (attachScrollStrip below)
//   double/triple/quad click -> consecutive single taps; host tracks
//                               click state on the wire-level .click(.left)
//                               events and emits the right kCGMouseEventClickState
//   drag        -> bare press-and-hold (UILongPressGestureRecognizer below,
//                  numberOfTapsRequired=0, minimumPressDuration=0.25)
//   switch space -> horizontal swipe + chevron taps on SpacesStripView
//                   (R11.2). Substitutes the canonical three-finger
//                   horizontal swipe; wire shape NormalizedInput.switchSpace
//                   is unchanged.
//
// Mission Control is the one multi-touch exception: it mirrors the Mac's
// three-finger-up gesture and emits a single explicit system command.

// MARK: - Translator

@MainActor
final class GestureTranslator: NSObject {
    weak var delegate: GestureTranslatorDelegate?
    private let logger = Logger(subsystem: Config.logSubsystem, category: "gestures")
    private let acceleration: GestureAcceleration
    private let scrollAcceleration: GestureAcceleration
    var tuning: GestureTuning = .default
    // The pan recognizer reports cumulative translation, but we want
    // deltas-since-last-callback so the receiver can integrate them as
    // relative cursor motion without knowing the trackpad size.
    private var lastPanTranslation: CGPoint = .zero
    private var lastScrollTranslation: CGPoint = .zero
    // R10.2: tap-then-press-and-hold drives a Mac-trackpad-style double-tap
    // drag. While isDragging is true, pan-driven cursorMove is suppressed
    // so the drag recognizer is the sole source of motion; the host promotes
    // those cursorMoves to leftMouseDragged based on its own inDrag flag.
    private var isDragging = false
    private var dragLastPoint: CGPoint = .zero
    private var dragLastTime: CFTimeInterval = 0
    private var dragEdgeDirection: CGPoint = .zero
    private var dragEdgeSpeed: CGFloat = 0
    private var dragEdgeActive = false
    private var dragEdgeDisplayLink: CADisplayLink?
    private var dragEdgeLastTime: CFTimeInterval = 0
    // Momentum: after the finger lifts with non-trivial velocity, emit
    // decaying scroll events on a display link until velocity falls below
    // the cutoff. Approximates the Mac trackpad's inertia tail.
    private var momentumDisplayLink: CADisplayLink?
    private var momentumVelocity: CGPoint = .zero
    private var momentumLastTime: CFTimeInterval = 0
    // UIPanGestureRecognizer.velocity(in:) at .ended is unreliable: it can
    // be 0 or a stale sample even after a hard flick. Capture velocity at
    // every .changed callback and use the most recent non-zero value as
    // the momentum seed at .ended.
    private var lastScrollVelocity: CGPoint = .zero
    private var scrollStartTranslation: CGPoint = .zero
    private var scrollAxis: ScrollAxis = .undecided
    // The first emitted scroll event of a touch drag carries phase=.began;
    // subsequent ones carry .changed. Reset at each gesture .began.
    private var didEmitScrollBegan = false
    // Same idea for the inertia tail.
    private var didEmitMomentumBegan = false
    // Whether the gesture that threw this momentum scrolled both axes. Captured at lift
    // because `scrollAxis` is cleared as the gesture ends, and the tail outlives it.
    private var momentumAxisIsFree = false
    // Velocity threshold (points/sec) below which a finger-lift is treated
    // as a slow drag finishing, not a flick. No momentum below this.
    private static let momentumFlickThreshold: CGFloat = 200
    // Velocity threshold (points/sec) below which momentum stops on its
    // own. ~30 px/sec is about one pixel every two frames; visually static.
    private static let momentumStopThreshold: CGFloat = 30
    // Exponential decay k. With k=2.8: half-life ~248ms, ~25% at 500ms,
    // spent by ~1.1s. Slower than Mac trackpad so a single flick coasts a
    // long page, cutting the repeated-swipe fatigue that read as "slow".
    private static let momentumDecayK: CGFloat = 2.8
    // Scroll clutch: a gesture starts on the thin strip, but the thumb can
    // leave that strip and use the whole captured pan for scroll distance.
    // Locking after a short slop prevents horizontal table scrolls from
    // leaking into vertical reading scrolls, and vice versa.
    private static let scrollAxisSlop: CGFloat = 12
    private static let scrollAxisDominanceRatio: CGFloat = 1.25
    // Drag auto-pan: once a drag reaches the edge of the screen, keep moving
    // in the last outward direction so a short phone drag can finish a much
    // longer Mac selection or window drag.
    private static let dragEdgeThreshold: CGFloat = 44
    private static let dragEdgeMinimumSpeed: CGFloat = 180
    private static let dragEdgeMaximumSpeed: CGFloat = 1400

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
        let pan = CoalescingTrackpadGestureRecognizer()
        pan.minimumNumberOfTouches = 1
        pan.maximumNumberOfTouches = 1
        pan.onSampleDelta = { [weak self] dx, dy, velocity in
            self?.emitCursorDelta(dx: dx, dy: dy, velocity: velocity)
        }
        view.addGestureRecognizer(pan)

        let tap = UITapGestureRecognizer(target: self, action: #selector(handleTapGesture(_:)))
        tap.numberOfTouchesRequired = 1
        tap.numberOfTapsRequired = 1
        view.addGestureRecognizer(tap)

        // Bare press-and-hold for ~250ms without movement past
        // allowableMovement fires .began → drag-start. iOS-native pattern:
        // matches how other apps long-press to pick up items, summon
        // context menus, or start drag-and-drop. Easier one-handed than
        // tap-then-tap-and-hold because there is no double-tap timing
        // window to hit.
        //
        // numberOfTapsRequired stays 0 (the default) so the recognizer
        // fires on a first-touch hold AND on the tap-then-touch-hold
        // muscle-memory pattern (Mac users get both). The 250ms window
        // is long enough that slow intentional taps don't accidentally
        // open a drag; tap timeout fails the tap recognizer at ~150ms
        // so click vs drag is unambiguous to the user's finger.
        let drag = UILongPressGestureRecognizer(target: self, action: #selector(handleDragGesture(_:)))
        drag.numberOfTouchesRequired = 1
        drag.minimumPressDuration = 0.25
        drag.allowableMovement = 25
        view.addGestureRecognizer(drag)

        let missionControl = UISwipeGestureRecognizer(
            target: self,
            action: #selector(handleMissionControlSwipe(_:))
        )
        missionControl.numberOfTouchesRequired = 3
        missionControl.direction = .up
        view.addGestureRecognizer(missionControl)
    }

    // Shared cursor emission used by both the new coalescing recognizer
    // (production path, ~120Hz sub-frame samples) and processPan below
    // (legacy per-frame API kept for tests). Identical math in both so
    // the test path stays representative.
    //
    // Pan output is suppressed while isDragging is true so the drag
    // recognizer's processDrag is the only producer of cursorMove events
    // during a double-tap-drag. Without this gate, both pan and drag would
    // fire deltas concurrently and the host would see twice the motion.
    private func emitCursorDelta(dx: CGFloat, dy: CGFloat, velocity: CGFloat) {
        if isDragging { return }
        let gain = acceleration.scale(velocity) * tuning.cursorAcceleration
        let outDx = Float(dx * gain * tuning.cursorSpeed)
        let outDy = Float(dy * gain * tuning.cursorSpeed)
        delegate?.gestureTranslator(self, didProduce: .cursorMove(dx: outDx, dy: outDy))
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
            emitCursorDelta(dx: rawDx, dy: rawDy, velocity: speed)
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

    func processMissionControlSwipe(state: UIGestureRecognizer.State) {
        guard state == .ended else { return }
        logger.notice("missionControlGesture recognized source=trackpad touches=3 direction=up")
        delegate?.gestureTranslator(self, didProduce: .systemCommand(.missionControl))
    }

    // Right-edge scroll strip pan. The strip is a clutch: touch starts on
    // the strip, then the captured pan can travel outside it. After a short
    // slop, the dominant axis locks the gesture to vertical or horizontal
    // app-content scrolling. dy is in iPhone screen coords (positive =
    // finger moved down), dx positive = finger moved right.
    /// How a scroll gesture treats its two axes.
    ///
    /// The right-edge strip commits to one. It is a narrow clutch you grab deliberately, the
    /// axis you meant is obvious from the first inch, and locking it stops a vertical drag
    /// from smearing content sideways on the way down.
    ///
    /// A full surface is the opposite case. There is no thin control to grab, the finger is
    /// wherever the content is, and a real trackpad scrolls both axes at once -- so a diagonal
    /// drag must move diagonally rather than doing nothing until one axis wins.
    enum ScrollAxisPolicy: Equatable, Sendable {
        case dominantAxis
        case free
    }

    func processScrollPan(
        state: UIGestureRecognizer.State,
        translation: CGPoint,
        velocity: CGPoint = .zero,
        axisPolicy: ScrollAxisPolicy = .dominantAxis
    ) {
        switch state {
        case .began:
            // A fresh touch on the scroll strip cancels any in-flight
            // momentum (matches the Mac trackpad: touching aborts inertia).
            stopMomentum(emitEnd: true)
            lastScrollTranslation = translation
            scrollStartTranslation = translation
            lastScrollVelocity = .zero
            scrollAxis = axisPolicy == .free ? .free : .undecided
            didEmitScrollBegan = false
        case .changed:
            if scrollAxis == .undecided {
                guard let locked = lockedScrollAxis(for: translation) else { return }
                scrollAxis = locked
            }

            let rawDelta = CGPoint(
                x: translation.x - lastScrollTranslation.x,
                y: translation.y - lastScrollTranslation.y
            )
            lastScrollTranslation = translation
            let projectedVelocity = projectedScrollVelocity(velocity)
            if projectedVelocity != .zero {
                lastScrollVelocity = projectedVelocity
            }
            let projectedDelta = projectedScrollDelta(rawDelta, velocity: projectedVelocity)
            if projectedDelta.x == 0 && projectedDelta.y == 0 { return }
            let phase: NormalizedInput.ScrollPhase = didEmitScrollBegan ? .changed : .began
            didEmitScrollBegan = true
            delegate?.gestureTranslator(self, didProduce: .scroll(dx: projectedDelta.x, dy: projectedDelta.y, phase: phase))
        case .ended:
            lastScrollTranslation = .zero
            scrollStartTranslation = .zero
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
            let fallbackVelocity = projectedScrollVelocity(velocity)
            let liftVelocity = lastScrollVelocity != .zero ? lastScrollVelocity : fallbackVelocity
            if scrollSpeed(liftVelocity) >= Self.momentumFlickThreshold {
                startMomentum(initialVelocity: liftVelocity)
            }
            lastScrollVelocity = .zero
            scrollAxis = .undecided
        case .cancelled, .failed:
            lastScrollTranslation = .zero
            scrollStartTranslation = .zero
            if didEmitScrollBegan {
                delegate?.gestureTranslator(self, didProduce: .scroll(dx: 0, dy: 0, phase: .ended))
            }
            didEmitScrollBegan = false
            lastScrollVelocity = .zero
            scrollAxis = .undecided
        default:
            break
        }
    }

    private func lockedScrollAxis(for translation: CGPoint) -> ScrollAxis? {
        let totalDx = translation.x - scrollStartTranslation.x
        let totalDy = translation.y - scrollStartTranslation.y
        guard hypot(totalDx, totalDy) >= Self.scrollAxisSlop else { return nil }

        let absX = abs(totalDx)
        let absY = abs(totalDy)
        if absX > absY * Self.scrollAxisDominanceRatio { return .horizontal }
        if absY > absX * Self.scrollAxisDominanceRatio { return .vertical }
        return nil
    }

    private func projectedScrollVelocity(_ velocity: CGPoint) -> CGPoint {
        switch scrollAxis {
        case .horizontal:
            CGPoint(x: velocity.x, y: 0)
        case .vertical:
            CGPoint(x: 0, y: velocity.y)
        case .free:
            velocity
        case .undecided:
            .zero
        }
    }

    private func projectedScrollDelta(_ delta: CGPoint, velocity: CGPoint) -> (x: Float, y: Float) {
        let speed = scrollSpeed(velocity)
        let gain = scrollAcceleration.scale(speed)
        switch scrollAxis {
        case .horizontal:
            return (
                Float(delta.x * gain * tuning.scrollSpeed),
                0
            )
        case .vertical:
            let sign: CGFloat = tuning.scrollInverted ? -1.0 : 1.0
            return (
                0,
                Float(delta.y * gain * tuning.scrollSpeed * sign)
            )
        case .free:
            // The direction preference applies to BOTH axes here. macOS natural scrolling
            // inverts both, and a surface that honoured it vertically while ignoring it
            // horizontally would scroll one way as asked and the other way as it pleased.
            // The locked cases keep their existing behaviour rather than inheriting this:
            // the strip's horizontal drag has never been signed, and changing a shipped
            // surface is not this policy's business.
            let sign: CGFloat = tuning.scrollInverted ? -1.0 : 1.0
            return (
                Float(delta.x * gain * tuning.scrollSpeed * sign),
                Float(delta.y * gain * tuning.scrollSpeed * sign)
            )
        case .undecided:
            return (0, 0)
        }
    }

    private func scrollSpeed(_ velocity: CGPoint) -> CGFloat {
        hypot(velocity.x, velocity.y)
    }

    private func startMomentum(initialVelocity: CGPoint) {
        stopMomentum(emitEnd: false)
        momentumVelocity = initialVelocity
        momentumLastTime = CACurrentMediaTime()
        didEmitMomentumBegan = false
        // Read before the caller clears `scrollAxis` at the end of the gesture.
        momentumAxisIsFree = scrollAxis == .free
        let link = CADisplayLink(target: self, selector: #selector(tickMomentum(_:)))
        link.add(to: .main, forMode: .common)
        momentumDisplayLink = link
    }

    private func stopMomentum(emitEnd: Bool) {
        let wasRunning = momentumDisplayLink != nil
        momentumDisplayLink?.invalidate()
        momentumDisplayLink = nil
        momentumVelocity = .zero
        if emitEnd && wasRunning && didEmitMomentumBegan {
            delegate?.gestureTranslator(self, didProduce: .scroll(dx: 0, dy: 0, phase: .momentumEnded))
        }
        didEmitMomentumBegan = false
    }

    func processScrollMomentumTick(now: CFTimeInterval) {
        let dt = CGFloat(now - momentumLastTime)
        momentumLastTime = now
        // v(t) = v0 * e^(-k*dt) per frame. Applied incrementally so frame
        // rate variation doesn't change the overall decay curve.
        let decay = exp(-Self.momentumDecayK * dt)
        momentumVelocity = CGPoint(
            x: momentumVelocity.x * decay,
            y: momentumVelocity.y * decay
        )
        if scrollSpeed(momentumVelocity) < Self.momentumStopThreshold {
            stopMomentum(emitEnd: true)
            return
        }
        let gain = scrollAcceleration.scale(scrollSpeed(momentumVelocity))
        let sign: CGFloat = tuning.scrollInverted ? -1.0 : 1.0
        // The tail has to be signed the same way the drag was, or a flick coasts back against
        // the direction that threw it. Which axes that covers is a property of the gesture
        // that started the momentum, not of the momentum itself, so it is captured at lift.
        let horizontalSign: CGFloat = momentumAxisIsFree ? sign : 1.0
        let dx = Float(momentumVelocity.x * dt * gain * tuning.scrollSpeed * horizontalSign)
        let dy = Float(momentumVelocity.y * dt * gain * tuning.scrollSpeed * sign)
        let phase: NormalizedInput.ScrollPhase = didEmitMomentumBegan ? .momentumChanged : .momentumBegan
        didEmitMomentumBegan = true
        delegate?.gestureTranslator(self, didProduce: .scroll(dx: dx, dy: dy, phase: phase))
    }

    @objc private func tickMomentum(_ link: CADisplayLink) {
        processScrollMomentumTick(now: CACurrentMediaTime())
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

    @objc private func handleDragGesture(_ gesture: UILongPressGestureRecognizer) {
        guard let view = gesture.view else { return }
        processDrag(
            state: gesture.state,
            point: gesture.location(in: view),
            in: view.bounds,
            timestamp: CACurrentMediaTime()
        )
    }

    @objc private func handleMissionControlSwipe(_ gesture: UISwipeGestureRecognizer) {
        processMissionControlSwipe(state: gesture.state)
    }

    // Pure function so tests can drive the state machine without a live
    // UIWindow. .began emits dragStart and arms isDragging so concurrent
    // pan events are suppressed for the rest of the gesture. .changed
    // emits cursorMove deltas with no velocity-driven acceleration: drag
    // is typically used for precise text selection, where small finger
    // motions should map close to 1:1 to cursor motion so the selection
    // tracks the finger rather than overshooting. If the finger reaches the
    // edge of the view, edge-pan keeps the cursor moving in the last outward
    // direction so a small phone screen can still drive a long drag.
    func processDrag(
        state: UIGestureRecognizer.State,
        point: CGPoint,
        in bounds: CGRect = .zero,
        timestamp: CFTimeInterval = CACurrentMediaTime()
    ) {
        switch state {
        case .began:
            isDragging = true
            dragLastPoint = point
            dragLastTime = timestamp
            dragEdgeDirection = .zero
            dragEdgeSpeed = 0
            stopDragEdgePan()
            delegate?.gestureTranslator(self, didProduce: .dragStart)
        case .changed:
            guard isDragging else { return }
            let dx = point.x - dragLastPoint.x
            let dy = point.y - dragLastPoint.y
            let dt = max(timestamp - dragLastTime, 0.001)
            dragLastPoint = point
            dragLastTime = timestamp
            if dx == 0 && dy == 0 { return }
            let gain = tuning.cursorAcceleration * tuning.cursorSpeed
            let outDx = Float(dx * gain)
            let outDy = Float(dy * gain)
            delegate?.gestureTranslator(self, didProduce: .cursorMove(dx: outDx, dy: outDy))
            updateDragEdgePan(point: point, delta: CGPoint(x: dx, y: dy), dt: dt, bounds: bounds, timestamp: timestamp)
            return
        case .ended, .cancelled, .failed:
            if isDragging {
                isDragging = false
                stopDragEdgePan()
                delegate?.gestureTranslator(self, didProduce: .dragEnd)
            }
            dragLastPoint = .zero
            dragLastTime = 0
            dragEdgeDirection = .zero
            dragEdgeSpeed = 0
        default:
            break
        }
    }

    func processDragEdgePanTick(now: CFTimeInterval) {
        guard isDragging, dragEdgeActive, dragEdgeDirection != .zero else { return }
        let dt = max(now - dragEdgeLastTime, 0.001)
        dragEdgeLastTime = now
        let gain = tuning.cursorAcceleration * tuning.cursorSpeed
        let dx = Float(dragEdgeDirection.x * dragEdgeSpeed * dt * gain)
        let dy = Float(dragEdgeDirection.y * dragEdgeSpeed * dt * gain)
        delegate?.gestureTranslator(self, didProduce: .cursorMove(dx: dx, dy: dy))
    }

    private func updateDragEdgePan(
        point: CGPoint,
        delta: CGPoint,
        dt: CFTimeInterval,
        bounds: CGRect,
        timestamp: CFTimeInterval
    ) {
        guard isDragging, bounds.width > 0, bounds.height > 0 else {
            stopDragEdgePan()
            return
        }

        guard let edge = nearestDragEdge(for: point, in: bounds) else {
            stopDragEdgePan()
            return
        }

        if delta.x == 0 && delta.y == 0 {
            if dragEdgeActive { return }
            stopDragEdgePan()
            return
        }

        guard isMovingOutward(from: edge, delta: delta) else {
            if dragEdgeActive {
                stopDragEdgePan()
            }
            return
        }

        let magnitude = hypot(delta.x, delta.y)
        let speed = min(max(magnitude / CGFloat(dt), Self.dragEdgeMinimumSpeed), Self.dragEdgeMaximumSpeed)
        dragEdgeDirection = CGPoint(x: delta.x / magnitude, y: delta.y / magnitude)
        dragEdgeSpeed = speed
        startDragEdgePan(timestamp: timestamp)
    }

    private func nearestDragEdge(for point: CGPoint, in bounds: CGRect) -> DragEdge? {
        let left = point.x
        let right = bounds.maxX - point.x
        let top = point.y
        let bottom = bounds.maxY - point.y
        let nearest = min(left, right, top, bottom)
        guard nearest <= Self.dragEdgeThreshold else { return nil }
        switch nearest {
        case left: return .left
        case right: return .right
        case top: return .top
        default: return .bottom
        }
    }

    private func isMovingOutward(from edge: DragEdge, delta: CGPoint) -> Bool {
        switch edge {
        case .left: return delta.x < 0
        case .right: return delta.x > 0
        case .top: return delta.y < 0
        case .bottom: return delta.y > 0
        }
    }

    private func startDragEdgePan(timestamp: CFTimeInterval) {
        if !dragEdgeActive {
            dragEdgeActive = true
            dragEdgeLastTime = timestamp
            stopDragEdgeDisplayLink()
            let link = CADisplayLink(target: self, selector: #selector(tickDragEdgePan(_:)))
            link.add(to: .main, forMode: .common)
            dragEdgeDisplayLink = link
        }
    }

    private func stopDragEdgePan() {
        dragEdgeActive = false
        dragEdgeDirection = .zero
        dragEdgeSpeed = 0
        stopDragEdgeDisplayLink()
    }

    private func stopDragEdgeDisplayLink() {
        dragEdgeDisplayLink?.invalidate()
        dragEdgeDisplayLink = nil
    }

    @objc private func tickDragEdgePan(_ link: CADisplayLink) {
        processDragEdgePanTick(now: CACurrentMediaTime())
    }

    private enum DragEdge: CaseIterable {
        case left, right, top, bottom
    }

    private enum ScrollAxis {
        case undecided, horizontal, vertical, free
    }
}
