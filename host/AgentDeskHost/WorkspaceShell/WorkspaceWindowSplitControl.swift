import AppKit

/// A top-bar "＋" chip and its window chooser as one split control: a single bezel the same height and
/// family as the plain chips beside it, divided by the system's own hairline, with the wide half
/// opening a new window and the chevron half listing the ones already open.
///
/// Two separate controls read as two chips that happened to land next to each other, and a bare
/// chevron does not read as clickable at all.
///
/// The chooser deliberately does NOT ride on AppKit's attached segment menu: that opens on a
/// press-and-hold, and reaching a list of windows should cost the same single click as everything else
/// in this bar. The control owns the click and pops the menu itself, so the chevron half behaves like
/// the button it looks like.
@MainActor
final class WorkspaceWindowSplitControl: NSSegmentedControl {
    /// The chevron half's width, fixed because the menu is popped up under it by hand and there is no
    /// public way to ask a segmented control where one of its segments ended up.
    static let chooserSegmentWidth: CGFloat = 24
    private static let openSegment = 0
    private static let chooserSegment = 1

    private let open: () -> Void
    private let chooser: () -> NSMenu

    init(
        kind: WorkspaceWindowKind,
        open: @escaping () -> Void,
        chooser: @escaping () -> NSMenu
    ) {
        self.open = open
        self.chooser = chooser
        super.init(frame: .zero)

        segmentCount = 2
        // Momentary, because neither half is a mode: both do something and leave nothing selected.
        trackingMode = .momentary
        segmentStyle = .automatic
        target = self
        action = #selector(segmentTapped)

        setLabel("＋ \(kind.label)", forSegment: Self.openSegment)
        // Zero means "fit the label", not "collapse".
        setWidth(0, forSegment: Self.openSegment)
        setToolTip("Open a new \(kind.label) window", forSegment: Self.openSegment)

        let chooserLabel = "List open \(kind.label) windows"
        setImage(
            NSImage(systemSymbolName: "chevron.down", accessibilityDescription: chooserLabel)?
                .withSymbolConfiguration(.init(pointSize: 10, weight: .semibold)),
            forSegment: Self.chooserSegment
        )
        setWidth(Self.chooserSegmentWidth, forSegment: Self.chooserSegment)
        setToolTip(chooserLabel, forSegment: Self.chooserSegment)

        setAccessibilityIdentifier("open-\(kind.identifierPrefix)")
        setAccessibilityLabel("\(kind.label) windows")
        translatesAutoresizingMaskIntoConstraints = false
        setContentHuggingPriority(.required, for: .horizontal)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("WorkspaceWindowSplitControl is code-only") }

    /// The top bar lives in a non-activating panel, so a control that did not take the first mouse
    /// would swallow the click that arrives while the panel is not key and cost the user a second one.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    /// Test seam: what a click on one half does, taking the segment index directly. A momentary
    /// control refuses a programmatic `selectedSegment`, so a test cannot stage the click and let the
    /// action read it back. Pass 0 only: activating the chevron half here would open a real menu and
    /// hand the test process to AppKit's tracking loop. Its own seam is `chooserMenuForTesting`.
    func activateSegmentForTesting(_ segment: Int) {
        activate(segment: segment)
    }

    /// Test seam: the menu the chevron half would show right now.
    func chooserMenuForTesting() -> NSMenu { chooser() }

    /// `selectedSegment` is what a momentary control reports for the duration of its action, and is
    /// the only thing that says which half was hit.
    @objc private func segmentTapped() {
        activate(segment: selectedSegment)
    }

    private func activate(segment: Int) {
        switch segment {
        case Self.openSegment:
            open()
        case Self.chooserSegment:
            popUpChooser()
        default:
            break
        }
    }

    private func popUpChooser() {
        // Popped up under the chevron half rather than at the mouse, so the list stays anchored to
        // the half it belongs to however the control was reached.
        chooser().popUp(
            positioning: nil,
            at: NSPoint(x: bounds.maxX - Self.chooserSegmentWidth, y: bounds.maxY + 4),
            in: self
        )
    }
}
