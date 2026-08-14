import UIKit

// The live media readout pinned to the top-left of the control surface: fps, kbps, arrival
// gap, decoder state. It is the surface this project reads first when motion looks wrong, so
// it stays available -- but it is also a black bar sitting on top of the Mac's own top-left
// corner, which is where menu bars, window title bars and app chrome live. Watching a window
// there means reading around it.
//
// So it hides. Tapping the glyph collapses the pill to that glyph alone; tapping again brings
// the text back. Collapsed is a state the user chose, so it outlives the session in
// `SettingsStore` the same way the two strips' disclosure does.
//
// It hides rather than closes: there is no way back from a control that removes itself, and
// the whole point is to reach the readout during a bad run without a rebuild.
//
// Two things this deliberately is NOT:
//
// - It is not tappable across its whole width. It replaced a `UILabel`, which had touch
//   handling off by default, so every tap in that corner reached the Mac. Making the whole
//   pill a button would silently take a 200pt strip of the video away from the trackpad. Only
//   the glyph is a target; see `point(inside:)`.
// - It does not stop being fed while it is hidden. A readout that resumes with a stale number
//   is worse than one that is not there.
@MainActor
final class MediaDiagnosticsPill: UIView {
    // The disclosure changed by tap. The layout owner does not need to hear about it -- the
    // pill is not in a constraint chain that anything else depends on -- but the choice is
    // remembered, so this is how it gets out.
    var onDisclosureChange: ((Bool) -> Void)?

    // Matches the strips: filled means open. Distinct from both of theirs, which are
    // rectangles, because this reports on the link rather than on what is being shown.
    private static let glyphExpanded = "waveform.circle.fill"
    private static let glyphCollapsed = "waveform.circle"

    static let glyphWidth: CGFloat = 20
    // Padding around the glyph while collapsed, and around the whole row while open. Chosen so
    // the collapsed pill is a square rather than a lozenge.
    static let inset: CGFloat = 5
    // The glyph draws at 20pt so it does not cover more of the Mac than it has to. That is
    // well under what a finger needs, and this control is looked for exactly when something is
    // already going wrong, so the shortfall is made up outside the glyph's box where it costs
    // no pixels.
    static let minimumTouchSide: CGFloat = 44
    // Gap between the glyph and the readout when open.
    static let glyphTextGap: CGFloat = 4

    private let glyphView = UIImageView()
    private let textLabel = UILabel()
    // Which of the two shapes the pill is in. Held as whole sets rather than toggled
    // individually, because the collapsed set drops the text's horizontal constraints
    // entirely: pinning the text to the trailing edge AND collapsing the glyph onto it are
    // not both satisfiable, and leaving both installed is how a view starts logging broken
    // constraints and picking one at random.
    private var expandedConstraints: [NSLayoutConstraint] = []
    private var collapsedConstraints: [NSLayoutConstraint] = []

    private(set) var isExpanded: Bool

    // The readout itself. Assignable while collapsed on purpose, per the note above.
    var text: String? {
        get { textLabel.text }
        set {
            textLabel.text = newValue
            if isExpanded { accessibilityValue = newValue }
        }
    }

    init(isExpanded: Bool) {
        self.isExpanded = isExpanded
        super.init(frame: .zero)
        configure()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func configure() {
        accessibilityIdentifier = "media-diagnostics-pill"
        backgroundColor = UIColor.black.withAlphaComponent(0.72)
        layer.cornerRadius = 6
        layer.masksToBounds = true
        translatesAutoresizingMaskIntoConstraints = false

        glyphView.contentMode = .center
        glyphView.tintColor = .white
        glyphView.preferredSymbolConfiguration = UIImage.SymbolConfiguration(
            pointSize: 13, weight: .regular
        )
        glyphView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(glyphView)

        textLabel.textColor = .white
        textLabel.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        textLabel.numberOfLines = 1
        textLabel.text = OwnedMediaStatus.connecting.labelText
        textLabel.translatesAutoresizingMaskIntoConstraints = false
        addSubview(textLabel)

        // Open, the text's trailing edge is what gives the pill its width. Closed, the glyph's
        // is. Exactly one of those is installed at a time.
        expandedConstraints = [
            textLabel.leadingAnchor.constraint(
                equalTo: glyphView.trailingAnchor, constant: Self.glyphTextGap
            ),
            textLabel.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -Self.inset)
        ]
        collapsedConstraints = [
            glyphView.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -Self.inset)
        ]

        NSLayoutConstraint.activate([
            glyphView.leadingAnchor.constraint(equalTo: leadingAnchor, constant: Self.inset),
            glyphView.widthAnchor.constraint(equalToConstant: Self.glyphWidth),
            glyphView.topAnchor.constraint(equalTo: topAnchor, constant: Self.inset),
            glyphView.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -Self.inset),

            textLabel.centerYAnchor.constraint(equalTo: centerYAnchor)
        ])

        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(toggle)))
        isAccessibilityElement = true
        accessibilityTraits = [.button]
        applyDisclosure()
    }

    // The box the glyph is drawn in, in this view's coordinates. Derived from the constants
    // rather than read back off the laid-out image view, so it is the same answer before the
    // first layout pass and after one.
    var glyphRect: CGRect {
        CGRect(x: Self.inset, y: Self.inset,
               width: Self.glyphWidth,
               height: max(0, bounds.height - Self.inset * 2))
    }

    // Only the glyph takes touches. Everything else in the pill -- which, open, is most of it
    // -- reports as outside, so a tap there falls through to the video the way it did when
    // this was a plain label.
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        let glyph = glyphRect
        guard !glyph.isEmpty else { return false }
        let dx = max(0, (Self.minimumTouchSide - glyph.width) / 2)
        let dy = max(0, (Self.minimumTouchSide - glyph.height) / 2)
        return glyph.insetBy(dx: -dx, dy: -dy).contains(point)
    }

    @objc private func toggle() {
        setExpanded(!isExpanded)
        onDisclosureChange?(isExpanded)
    }

    // Also the way the layout owner restores the remembered state, which is why it is not
    // folded into `toggle`: only a deliberate tap should be written back to settings.
    func setExpanded(_ expanded: Bool) {
        guard expanded != isExpanded else { return }
        isExpanded = expanded
        applyDisclosure()
    }

    private func applyDisclosure() {
        NSLayoutConstraint.deactivate(isExpanded ? collapsedConstraints : expandedConstraints)
        NSLayoutConstraint.activate(isExpanded ? expandedConstraints : collapsedConstraints)
        textLabel.isHidden = !isExpanded
        glyphView.image = UIImage(
            systemName: isExpanded ? Self.glyphExpanded : Self.glyphCollapsed
        )
        accessibilityLabel = "Media diagnostics"
        accessibilityValue = isExpanded ? text : nil
        accessibilityHint = isExpanded ? "Hides the readout." : "Shows the readout."
    }
}
