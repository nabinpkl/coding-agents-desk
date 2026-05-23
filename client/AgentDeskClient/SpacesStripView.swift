import UIKit

// R11.2 One-handed Spaces switch surface. A horizontal strip mounted
// between the trackpad and the bottom button row. Two affordances on the
// same wire shape (NormalizedInput.switchSpace):
//   - tap a chevron at either end
//   - swipe horizontally across the strip
//
// Multi-touch (three-finger swipe) is the canonical macOS gesture for
// switching Spaces but is unreachable one-handed on the v0 target. See the
// affordances MARK block in PairingViewController + GestureTranslator for
// the full mapping back to wire shapes.

@MainActor
protocol SpacesStripViewDelegate: AnyObject {
    func spacesStrip(_ view: SpacesStripView, didProduce input: NormalizedInput)
}

@MainActor
final class SpacesStripView: UIView {
    weak var delegate: SpacesStripViewDelegate?

    // Tunables. 60pt mirrors the scroll-strip momentum-flick threshold; a
    // gesture below that should not switch Spaces (cheap accidental drags
    // happen often). 2:1 horizontal dominance keeps a steep diagonal scroll
    // from being interpreted as a sideways flick.
    static let horizontalThreshold: CGFloat = 60
    static let dominanceRatio: CGFloat = 2

    private let leftChevron = UIButton(type: .system)
    private let rightChevron = UIButton(type: .system)
    private let feedback = UISelectionFeedbackGenerator()

    // Per-gesture latch: a single finger drag must emit at most one
    // .switchSpace, even if the user keeps dragging past the threshold.
    // Cleared at .began and again at .ended/.cancelled/.failed so the
    // next gesture is fresh.
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
        // Match the surrounding card treatment so the strip reads as part
        // of the trackpad / button-row family rather than a foreign band.
        backgroundColor = .secondarySystemBackground
        layer.cornerRadius = 16
        layer.borderColor = UIColor.separator.cgColor
        layer.borderWidth = 0.5
        isUserInteractionEnabled = true
        accessibilityIdentifier = "spaces-strip"

        leftChevron.setImage(UIImage(systemName: "chevron.left"), for: .normal)
        leftChevron.tintColor = .secondaryLabel
        leftChevron.accessibilityLabel = "Previous Space"
        leftChevron.accessibilityIdentifier = "spaces-strip-left"
        leftChevron.addTarget(self, action: #selector(leftChevronTapped), for: .touchUpInside)
        leftChevron.translatesAutoresizingMaskIntoConstraints = false

        rightChevron.setImage(UIImage(systemName: "chevron.right"), for: .normal)
        rightChevron.tintColor = .secondaryLabel
        rightChevron.accessibilityLabel = "Next Space"
        rightChevron.accessibilityIdentifier = "spaces-strip-right"
        rightChevron.addTarget(self, action: #selector(rightChevronTapped), for: .touchUpInside)
        rightChevron.translatesAutoresizingMaskIntoConstraints = false

        addSubview(leftChevron)
        addSubview(rightChevron)

        NSLayoutConstraint.activate([
            leftChevron.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            leftChevron.centerYAnchor.constraint(equalTo: centerYAnchor),
            leftChevron.widthAnchor.constraint(equalToConstant: 44),
            leftChevron.heightAnchor.constraint(equalToConstant: 44),
            rightChevron.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            rightChevron.centerYAnchor.constraint(equalTo: centerYAnchor),
            rightChevron.widthAnchor.constraint(equalToConstant: 44),
            rightChevron.heightAnchor.constraint(equalToConstant: 44)
        ])

        // Reuse the existing instant-pan subclass so the strip mirrors the
        // scroll strip's "first finger move is honored" feel; default
        // UIPan slop would otherwise swallow the first 10pt of travel.
        let pan = InstantPanGestureRecognizer(target: self, action: #selector(handleSwipe(_:)))
        pan.minimumNumberOfTouches = 1
        pan.maximumNumberOfTouches = 1
        addGestureRecognizer(pan)
    }

    @objc private func leftChevronTapped() {
        emit(.left)
    }

    @objc private func rightChevronTapped() {
        emit(.right)
    }

    @objc private func handleSwipe(_ gesture: UIPanGestureRecognizer) {
        processSwipe(state: gesture.state, translation: gesture.translation(in: self))
    }

    // Pure function so tests can drive the state machine without a live
    // UIWindow attaching synthetic touches. Fires on .changed (not .ended)
    // so the user gets the Space switch the moment they cross the
    // threshold, not on finger lift.
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
        delegate?.spacesStrip(self, didProduce: .switchSpace(direction: direction))
    }
}
