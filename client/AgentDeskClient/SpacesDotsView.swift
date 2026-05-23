import UIKit

// R11 Spaces switch surface. Mounted between the screen-share video
// sink and the trackpad cluster. Renders one dot per user Space on
// the host's active display (the active Space's dot is filled, the
// rest are open). Single-finger horizontal swipe on the band emits
// NormalizedInput.switchSpace(direction:).
//
// State is purely host-pushed: DesktopState arrives over the input
// WSS (host -> client direction added in R11) and PairingViewController
// forwards it via apply(state:). Without a state the band hides itself
// so a single-Space user never sees an empty carousel.
//
// Multi-touch (three-finger swipe) is the canonical macOS gesture for
// Spaces; the v0 target is one-handed, so the dots band substitutes
// the same wire shape on a single-finger surface that sits within
// thumb reach of the screen viewer.

@MainActor
protocol SpacesDotsViewDelegate: AnyObject {
    func spacesDots(_ view: SpacesDotsView, didProduce input: NormalizedInput)
}

@MainActor
final class SpacesDotsView: UIView {
    weak var delegate: SpacesDotsViewDelegate?

    // Same thresholds as the prior SpacesStripView so the gesture
    // feel is identical to what the iPhone-side users sampled during
    // the strip iteration; 60pt + 2:1 dominance + single-fire latch.
    static let horizontalThreshold: CGFloat = 60
    static let dominanceRatio: CGFloat = 2

    private let stack = UIStackView()
    private let feedback = UISelectionFeedbackGenerator()
    private var dotViews: [UIView] = []
    private var totalDots: Int = 0
    private var activeIndex: Int = 0
    private var hasFiredThisGesture = false

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

        let pan = InstantPanGestureRecognizer(target: self, action: #selector(handleSwipe(_:)))
        pan.minimumNumberOfTouches = 1
        pan.maximumNumberOfTouches = 1
        addGestureRecognizer(pan)

        // Hidden until the first DesktopState push arrives. Avoids
        // showing an empty band on cold-start before the host has
        // had a chance to enumerate Spaces.
        isHidden = true
    }

    // Drives the dot rendering. Called by PairingViewController whenever
    // a new DesktopState arrives over the input channel. Single-display
    // active-only render: the band counts user Spaces (type=0) on the
    // active display only; multi-display carousel is a v1 problem.
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
        // Rebuild dots when the count changes; otherwise just re-tint.
        if dotViews.count != count {
            for v in dotViews { v.removeFromSuperview() }
            dotViews = (0..<count).map { _ in makeDot() }
            for v in dotViews { stack.addArrangedSubview(v) }
        }
        for (i, dot) in dotViews.enumerated() {
            applyDotState(dot, isActive: i == activeIndex)
        }
        // Hide the band when there is nothing useful to render. A
        // single Space has no carousel to drive; macOS itself disables
        // its Spaces shortcuts in that case (see Mission Control
        // settings), so the iPhone surface follows the same logic.
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
        // CALayer.borderColor is a CGColor and does not auto-resolve
        // dynamic UIColors on appearance changes; re-resolve so dots
        // switch palette instantly with light/dark toggles.
        for (i, dot) in dotViews.enumerated() {
            applyDotState(dot, isActive: i == activeIndex)
        }
    }

    @objc private func handleSwipe(_ gesture: UIPanGestureRecognizer) {
        processSwipe(state: gesture.state, translation: gesture.translation(in: self))
    }

    // Pure function so tests can drive the state machine without a live
    // UIWindow attaching synthetic touches. Mirrors the prior
    // SpacesStripView impl so the gesture contract for users is stable.
    func processSwipe(state: UIGestureRecognizer.State, translation: CGPoint) {
        switch state {
        case .began:
            hasFiredThisGesture = false
        case .changed:
            guard !hasFiredThisGesture else { return }
            let dx = translation.x
            let dy = translation.y
            let absDx = abs(dx)
            let absDy = abs(dy)
            guard absDx >= Self.horizontalThreshold else { return }
            guard absDx >= Self.dominanceRatio * absDy else { return }
            hasFiredThisGesture = true
            emit(dx > 0 ? .right : .left)
        case .ended, .cancelled, .failed:
            hasFiredThisGesture = false
        default:
            break
        }
    }

    private func emit(_ direction: NormalizedInput.SpaceDirection) {
        feedback.selectionChanged()
        delegate?.spacesDots(self, didProduce: .switchSpace(direction: direction))
    }

    // Test helpers. Reading totalDots / activeIndex straight off the
    // view lets render() be the unit under test without poking the
    // private UIStackView.
    var renderedDotCount: Int { totalDots }
    var renderedActiveIndex: Int { activeIndex }
}
