import UIKit

// R11 Spaces switch surface. Mounted between the screen-share video
// sink and the trackpad cluster. Renders one dot per user Space on
// the host's active display (the active Space's dot is filled, the
// rest are open).
//
// Gesture model: continuous. The single-finger horizontal pan streams
// SwipePhase + normalised progress + velocity over the wire frame-by-
// frame as the user drags; the host posts one dock-swipe CGEvent per
// frame and the Mac's Dock animates the Spaces transition driven by
// that stream. On finger-lift, Ended carries the final progress +
// velocity and Dock either commits the switch or snaps back, exactly
// the same way a trackpad-native 3-finger swipe behaves.
//
// State is host-pushed: DesktopState arrives over the input WSS
// (NSWorkspace.activeSpaceDidChangeNotification on the host fires on
// every commit, regardless of trigger). The band hides itself when
// the host reports a single user Space or no active display.

@MainActor
protocol SpacesDotsViewDelegate: AnyObject {
    func spacesDots(_ view: SpacesDotsView, didProduce input: NormalizedInput)
}

@MainActor
final class SpacesDotsView: UIView {
    weak var delegate: SpacesDotsViewDelegate?

    private let stack = UIStackView()
    private let feedback = UISelectionFeedbackGenerator()
    private var dotViews: [UIView] = []
    private var totalDots: Int = 0
    private var activeIndex: Int = 0
    // Width captured at gesture .began so progress normalisation uses
    // a stable denominator even if the view re-layouts mid-swipe.
    // 1.0 is the natural "swipe-spans-the-band" travel; the user can
    // drag further and the progress saturates at ±1.
    private var gestureBandWidth: CGFloat = 1.0

    override init(frame: CGRect) {
        super.init(frame: frame)
        configure()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        configure()
    }

    private func configure() {
        backgroundColor = .clear
        isUserInteractionEnabled = true
        accessibilityIdentifier = "spaces-dots"

        stack.axis = .horizontal
        stack.spacing = 14
        stack.alignment = .center
        stack.distribution = .equalSpacing
        stack.isUserInteractionEnabled = false
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor)
        ])

        // Standard pan with the small UIKit slop so a thumb resting on
        // the band does not register as a swipe. Continuous emission
        // means we want every .changed callback iOS delivers (~60Hz on
        // most devices, ~120Hz on ProMotion); InstantPan's promote-on-
        // touchDown is not needed here because the user has visible
        // dots to aim at.
        let pan = UIPanGestureRecognizer(target: self, action: #selector(handleSwipe(_:)))
        pan.minimumNumberOfTouches = 1
        pan.maximumNumberOfTouches = 1
        addGestureRecognizer(pan)

        isHidden = true
    }

    func apply(state: DesktopState) {
        guard let activeDisplayId = state.activeDisplayId else {
            renderEmpty()
            return
        }
        let userSpaces = state.spaces
            .filter { $0.displayId == activeDisplayId && $0.type == 0 }
            .sorted { ($0.index ?? Int.max) < ($1.index ?? Int.max) }
        let activeIdx = userSpaces.firstIndex(where: { $0.id == state.activeSpaceId }) ?? 0
        render(count: userSpaces.count, activeIndex: activeIdx)
    }

    func renderEmpty() {
        render(count: 0, activeIndex: 0)
    }

    private func render(count: Int, activeIndex: Int) {
        totalDots = count
        self.activeIndex = activeIndex
        if dotViews.count != count {
            for v in dotViews { v.removeFromSuperview() }
            dotViews = (0..<count).map { _ in makeDot() }
            for v in dotViews { stack.addArrangedSubview(v) }
        }
        for (i, dot) in dotViews.enumerated() {
            applyDotState(dot, isActive: i == activeIndex)
        }
        isHidden = count <= 1
    }

    private func makeDot() -> UIView {
        let v = UIView()
        v.translatesAutoresizingMaskIntoConstraints = false
        v.layer.cornerRadius = 4
        v.layer.borderColor = UIColor.tertiaryLabel.cgColor
        v.layer.borderWidth = 1
        NSLayoutConstraint.activate([
            v.widthAnchor.constraint(equalToConstant: 8),
            v.heightAnchor.constraint(equalToConstant: 8)
        ])
        return v
    }

    private func applyDotState(_ dot: UIView, isActive: Bool) {
        dot.backgroundColor = isActive ? UIColor.label : .clear
        dot.layer.borderColor = (isActive ? UIColor.label : UIColor.tertiaryLabel).cgColor
    }

    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)
        for (i, dot) in dotViews.enumerated() {
            applyDotState(dot, isActive: i == activeIndex)
        }
    }

    @objc private func handleSwipe(_ gesture: UIPanGestureRecognizer) {
        processGesture(
            state: gesture.state,
            translation: gesture.translation(in: self),
            velocity: gesture.velocity(in: self),
            bandWidth: bounds.width
        )
    }

    // Pure function so tests can drive the state machine without a live
    // UIWindow. Emits one wire frame per UIKit pan callback:
    //
    //   .began    -> .switchSpaceGesture(.began, 0, 0)
    //   .changed  -> .switchSpaceGesture(.changed, dx/W clamped, vx)
    //   .ended    -> .switchSpaceGesture(.ended, dx/W clamped, vx)
    //   .cancelled / .failed -> .switchSpaceGesture(.cancelled, ...)
    //
    // The Dock decides commit-vs-snap-back at Ended from progress and
    // velocity; we do not impose a threshold here. The 1pt nudge floor
    // on Changed prevents Dock from dropping the event for zero-progress
    // frames (rare on a typical drag but possible if iOS coalesces
    // identical positions).
    func processGesture(
        state: UIGestureRecognizer.State,
        translation: CGPoint,
        velocity: CGPoint,
        bandWidth: CGFloat
    ) {
        switch state {
        case .began:
            gestureBandWidth = max(bandWidth, 1.0)
            feedback.selectionChanged()
            emit(phase: .began, progress: 0, velocityX: 0)
        case .changed:
            let raw = Float(translation.x / gestureBandWidth)
            let progress = min(max(raw, -1.0), 1.0)
            let nudged = nudgeAwayFromZero(progress)
            emit(phase: .changed, progress: nudged, velocityX: Float(velocity.x))
        case .ended:
            let raw = Float(translation.x / gestureBandWidth)
            let progress = min(max(raw, -1.0), 1.0)
            emit(phase: .ended, progress: progress, velocityX: Float(velocity.x))
        case .cancelled, .failed:
            emit(phase: .cancelled, progress: 0, velocityX: 0)
        default:
            break
        }
    }

    // The Dock reads progress=0 on a .changed frame as "no gesture in
    // progress" and drops it. Nudge to FLT_TRUE_MIN-sized away from
    // zero in whichever sign the velocity suggests; if velocity is
    // also zero, treat as a right nudge so we at least pass the
    // direction-required guard.
    private func nudgeAwayFromZero(_ progress: Float) -> Float {
        if progress != 0 { return progress }
        return .leastNonzeroMagnitude
    }

    private func emit(phase: NormalizedInput.SwipePhase, progress: Float, velocityX: Float) {
        delegate?.spacesDots(self, didProduce: .switchSpaceGesture(
            phase: phase, progress: progress, velocityX: velocityX
        ))
    }

    var renderedDotCount: Int { totalDots }
    var renderedActiveIndex: Int { activeIndex }
}
