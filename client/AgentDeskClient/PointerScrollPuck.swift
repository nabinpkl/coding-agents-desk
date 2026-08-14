import UIKit

// Pointer mode's scroll clutch: a floating puck that swaps what one finger on the video means.
//
// Pointer mode gives one finger to the pointer and two to scrolling. Two fingers is the wrong
// gesture to need often -- it is the one you cannot do one-handed, and scrolling is what you
// spend most of a session doing. Engaged, the puck hands one-finger drags to the scroll wheel
// and leaves the pointer exactly where it was parked, which is the whole point: the Mac scrolls
// whatever is under the pointer, so the pointer must not follow the finger that is scrolling.
//
// It floats because there is no correct place for it. Whatever corner it defaults to is over
// something someone wants to see, so it is draggable and the user decides. Tap toggles, drag
// moves; a pan needs real travel before it recognises, so the two do not compete for a tap.
//
// Transparent by default for the same reason the collapsed switchers are: it lies on the Mac's
// own pixels, and a solid control there reads as part of the Mac rather than part of the phone.
@MainActor
final class PointerScrollPuck: UIView {
    // The clutch changed. The layout owner rebinds the video's one-finger gesture; the puck
    // does not reach for it directly, because which recognizer owns that gesture is a fact
    // about the mode, not about this control.
    var onToggle: ((Bool) -> Void)?
    // Incremental travel from a drag of the puck itself, in the parent's coordinates.
    var onDragged: ((CGPoint) -> Void)?

    static let side: CGFloat = 56
    // Resting transparency. Low enough to read the Mac through it, high enough to find.
    static let idleAlpha: CGFloat = 0.35
    static let engagedAlpha: CGFloat = 0.9

    private let glyphView = UIImageView()
    private var panRecognizer: UIPanGestureRecognizer?

    private(set) var isEngaged = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        configure()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func configure() {
        accessibilityIdentifier = "pointer-scroll-puck"
        translatesAutoresizingMaskIntoConstraints = false
        backgroundColor = UIColor.black.withAlphaComponent(0.45)
        layer.cornerRadius = Self.side / 2
        layer.borderWidth = 1
        layer.borderColor = UIColor.white.withAlphaComponent(0.35).cgColor
        alpha = Self.idleAlpha

        glyphView.contentMode = .center
        glyphView.tintColor = .white
        glyphView.preferredSymbolConfiguration = UIImage.SymbolConfiguration(
            pointSize: 20, weight: .regular
        )
        glyphView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(glyphView)

        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: Self.side),
            heightAnchor.constraint(equalToConstant: Self.side),
            glyphView.centerXAnchor.constraint(equalTo: centerXAnchor),
            glyphView.centerYAnchor.constraint(equalTo: centerYAnchor)
        ])

        let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap))
        tap.numberOfTapsRequired = 1
        addGestureRecognizer(tap)

        // Standard pan, not an instant one: it waits for real travel before recognising, which
        // is exactly what keeps a tap from being read as a one-pixel drag.
        let pan = UIPanGestureRecognizer(target: self, action: #selector(handlePan(_:)))
        pan.minimumNumberOfTouches = 1
        pan.maximumNumberOfTouches = 1
        addGestureRecognizer(pan)
        panRecognizer = pan

        isAccessibilityElement = true
        accessibilityTraits = [.button]
        applyEngagement()
    }

    @objc private func handleTap() {
        setEngaged(!isEngaged)
        onToggle?(isEngaged)
    }

    @objc private func handlePan(_ gesture: UIPanGestureRecognizer) {
        guard let parent = superview else { return }
        switch gesture.state {
        case .changed:
            let delta = gesture.translation(in: parent)
            gesture.setTranslation(.zero, in: parent)
            guard delta != .zero else { return }
            onDragged?(delta)
        default:
            break
        }
    }

    // Separate from the tap so the layout owner can put the puck back to disengaged when the
    // mode changes underneath it, without that reading as a user choice.
    func setEngaged(_ engaged: Bool) {
        guard engaged != isEngaged else { return }
        isEngaged = engaged
        applyEngagement()
    }

    private func applyEngagement() {
        // Two channels, because one is not enough on a surface whose background is arbitrary
        // Mac pixels: the glyph says which mode, the opacity says it again louder.
        glyphView.image = UIImage(
            systemName: isEngaged
                ? "arrow.up.and.down.and.arrow.left.and.right"
                : "hand.point.up.left"
        )
        alpha = isEngaged ? Self.engagedAlpha : Self.idleAlpha
        layer.borderColor = (isEngaged ? UIColor.systemBlue : UIColor.white)
            .withAlphaComponent(isEngaged ? 0.9 : 0.35).cgColor
        accessibilityLabel = "Scroll clutch"
        accessibilityValue = isEngaged ? "Scrolling" : "Pointer"
        accessibilityHint = isEngaged
            ? "One finger moves the pointer again."
            : "One finger scrolls without moving the pointer."
    }
}
