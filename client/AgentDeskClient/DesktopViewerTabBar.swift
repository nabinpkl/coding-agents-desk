import UIKit

/// The native shell's complete desktop navigation: two tabs and no viewer behavior.
///
/// It sits at the very top of the Desktop surface, which is also where the Mac keeps its own
/// menu bar, so an always-open 44pt band is a band of the Mac nobody can see or reach. It
/// collapses for the same reason the media readout and the two bottom strips do, and by the
/// same rules: a tap is a preference, so the choice outlives the session in `SettingsStore`.
///
/// Collapsed it has **no height at all**, rather than shrinking to a slim bar. Everything the
/// layout owner chains under `bottomAnchor` -- the WebView surface, the landscape trackpad --
/// then gets the whole strip back with no constraint swapping and no transparent gap above a
/// surface. What remains is the pull tab: a chevron hanging below the bar's own bounds, drawn
/// and hit-tested outside them the way `HitOutsetView` reaches outside its.
///
/// The tab is centred rather than cornered because the two top corners are already spoken
/// for -- the media pill has the leading one, and the Mac's own status extras live in the
/// trailing one -- and because a tab you pull down belongs where a tab you pull down belongs.
@MainActor
final class DesktopViewerTabBar: UIView {
    var onSelection: ((DesktopViewerMode) -> Void)?
    // The disclosure changed by tap. The layout owner has to hear about this one, unlike the
    // media pill's: the bar's height IS a constraint other views are chained to.
    var onDisclosureChange: ((Bool) -> Void)?

    static let expandedHeight: CGFloat = 44
    /// The pull tab's drawn size. Small on purpose: collapsed, it is the only thing this
    /// control still puts on the Mac's pixels.
    static let disclosureSide: CGFloat = 28
    /// What a finger needs. Made up outside the drawn tab, where it costs no pixels, exactly
    /// as `MediaDiagnosticsPill` makes up its glyph's shortfall.
    static let minimumTouchSide: CGFloat = 44
    /// Resting transparency while collapsed, matching the puck: low enough to read the Mac
    /// through, high enough to find again.
    static let collapsedDisclosureAlpha: CGFloat = 0.4
    /// How far past the drawn tab a touch still counts, on every side.
    static let disclosureHitOutset: CGFloat = max(
        0, (DesktopViewerTabBar.minimumTouchSide - DesktopViewerTabBar.disclosureSide) / 2
    )

    private let modeControl = UISegmentedControl(items: ["Native", "WebView"])
    private let separator = UIView()
    private let disclosure = HitOutsetView()
    private let disclosureGlyph = UIImageView()

    private(set) var isExpanded: Bool

    /// Zero when closed, so a closed bar reserves nothing. The layout owner drives its height
    /// constraint from this, the same way it drives the two bottom strips from theirs.
    var preferredHeight: CGFloat { isExpanded ? Self.expandedHeight : 0 }

    init(isExpanded: Bool) {
        self.isExpanded = isExpanded
        super.init(frame: .zero)
        configure()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func select(_ mode: DesktopViewerMode) {
        modeControl.selectedSegmentIndex = mode.rawValue
    }

    /// Also how the layout owner restores the remembered state, which is why it is not folded
    /// into the tap handler: only a deliberate tap is written back to settings.
    func setExpanded(_ expanded: Bool) {
        guard expanded != isExpanded else { return }
        isExpanded = expanded
        applyDisclosure()
    }

    private func configure() {
        // The background belongs to `applyDisclosure`, which runs at the end of this method:
        // opaque open, clear closed. Seeding it here too would be a second answer to the same
        // question, and the wrong one for a bar built closed.
        accessibilityIdentifier = "desktop-viewer-tab-bar"
        // The pull tab lives outside these bounds; a bar that clipped would collapse to
        // nothing visible and leave no way back.
        clipsToBounds = false

        modeControl.selectedSegmentIndex = DesktopViewerMode.native.rawValue
        modeControl.accessibilityIdentifier = "desktop-viewer-tabs"
        modeControl.addTarget(self, action: #selector(selectionChanged), for: .valueChanged)
        modeControl.translatesAutoresizingMaskIntoConstraints = false
        addSubview(modeControl)

        separator.backgroundColor = .separator
        separator.translatesAutoresizingMaskIntoConstraints = false
        addSubview(separator)

        disclosure.accessibilityIdentifier = "desktop-viewer-tabs-disclosure"
        disclosure.isAccessibilityElement = true
        disclosure.accessibilityTraits = [.button]
        disclosure.backgroundColor = UIColor.black.withAlphaComponent(0.45)
        disclosure.layer.cornerRadius = Self.disclosureSide / 2
        disclosure.layer.borderWidth = 1
        disclosure.layer.borderColor = UIColor.white.withAlphaComponent(0.35).cgColor
        // The tab and this bar have to agree on the outset, or the ring around the tab becomes
        // dead space: the bar would report the touch as its own, hit-testing would stop there
        // because the tab says the point is outside it, and the tap would reach nothing.
        disclosure.hitOutsets = UIEdgeInsets(
            top: Self.disclosureHitOutset, left: Self.disclosureHitOutset,
            bottom: Self.disclosureHitOutset, right: Self.disclosureHitOutset
        )
        disclosure.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(toggle)))
        disclosure.translatesAutoresizingMaskIntoConstraints = false
        addSubview(disclosure)

        disclosureGlyph.contentMode = .center
        disclosureGlyph.tintColor = .white
        disclosureGlyph.preferredSymbolConfiguration = UIImage.SymbolConfiguration(
            pointSize: 13, weight: .semibold
        )
        disclosureGlyph.translatesAutoresizingMaskIntoConstraints = false
        disclosure.addSubview(disclosureGlyph)

        NSLayoutConstraint.activate([
            modeControl.centerXAnchor.constraint(equalTo: centerXAnchor),
            modeControl.centerYAnchor.constraint(equalTo: centerYAnchor),
            modeControl.widthAnchor.constraint(greaterThanOrEqualToConstant: 220),
            modeControl.heightAnchor.constraint(equalToConstant: 32),
            separator.leadingAnchor.constraint(equalTo: leadingAnchor),
            separator.trailingAnchor.constraint(equalTo: trailingAnchor),
            separator.bottomAnchor.constraint(equalTo: bottomAnchor),
            separator.heightAnchor.constraint(equalToConstant: 1 / UIScreen.main.scale),

            // Hangs off the bottom edge, so it rides down with the bar it opens and reads as
            // the tab you pulled rather than a button parked on top of the result.
            disclosure.topAnchor.constraint(equalTo: bottomAnchor),
            disclosure.centerXAnchor.constraint(equalTo: centerXAnchor),
            disclosure.widthAnchor.constraint(equalToConstant: Self.disclosureSide),
            disclosure.heightAnchor.constraint(equalToConstant: Self.disclosureSide),
            disclosureGlyph.centerXAnchor.constraint(equalTo: disclosure.centerXAnchor),
            disclosureGlyph.centerYAnchor.constraint(equalTo: disclosure.centerYAnchor)
        ])

        applyDisclosure()
    }

    /// The pull tab's box in this view's coordinates. Derived from the constants rather than
    /// read back off the laid-out control, so it is the same answer before the first layout
    /// pass and after one.
    var disclosureRect: CGRect {
        CGRect(
            x: (bounds.width - Self.disclosureSide) / 2,
            y: bounds.height,
            width: Self.disclosureSide,
            height: Self.disclosureSide
        )
    }

    /// The bar proper takes touches only while it is open -- closed it has no height, so this
    /// reduces to the tab alone and the whole strip goes back to the Mac.
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        if super.point(inside: point, with: event) { return true }
        // Zero HEIGHT is the closed shape and must still take the tab's touches; zero WIDTH
        // means no layout pass has run yet, and a target derived from that would be a 44pt
        // box floating at the screen's corner for one runloop turn.
        guard bounds.width > 0 else { return false }
        return disclosureRect
            .insetBy(dx: -Self.disclosureHitOutset, dy: -Self.disclosureHitOutset)
            .contains(point)
    }

    @objc private func selectionChanged() {
        guard let mode = DesktopViewerMode(rawValue: modeControl.selectedSegmentIndex) else {
            preconditionFailure("Desktop viewer tab index is outside DesktopViewerMode")
        }
        onSelection?(mode)
    }

    @objc private func toggle() {
        setExpanded(!isExpanded)
        onDisclosureChange?(isExpanded)
    }

    private func applyDisclosure() {
        // Hidden rather than merely clipped: a closed bar is zero-height, and a segmented
        // control still laid out inside it would keep taking taps meant for the Mac.
        modeControl.isHidden = !isExpanded
        separator.isHidden = !isExpanded
        backgroundColor = isExpanded
            ? .systemBackground.withAlphaComponent(0.94)
            : .clear
        disclosure.alpha = isExpanded ? 1.0 : Self.collapsedDisclosureAlpha
        disclosureGlyph.image = UIImage(systemName: isExpanded ? "chevron.up" : "chevron.down")
        disclosure.accessibilityLabel = "Desktop viewer tabs"
        disclosure.accessibilityHint = isExpanded
            ? "Hides the Native and WebView tabs."
            : "Shows the Native and WebView tabs."
    }
}
