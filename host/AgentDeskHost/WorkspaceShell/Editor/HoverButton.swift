import AppKit

/// An `NSButton` with a rounded hover background — the shared hover affordance for the
/// sidebar's flat controls (activity-bar tabs, workspace rows, the add/terminal chips).
/// `restingColor` shows when idle (clear, or an active-row highlight); `hoverColor` shows
/// on mouse-over. Accepts the first mouse so a click lands inside the non-activating panel
/// without a focusing pre-click.
public class HoverButton: NSButton {
    public var cornerRadius: CGFloat = 5 { didSet { layer?.cornerRadius = cornerRadius } }
    public var horizontalPadding: CGFloat = 0 { didSet { invalidateIntrinsicContentSize() } }
    public var restingColor: NSColor = .clear { didSet { applyBackground() } }
    public var hoverColor: NSColor = HoverButton.subtleFill { didSet { applyBackground() } }

    /// Called when the pointer enters (`true`) / leaves (`false`), for callers that also
    /// want to react beyond the background (e.g. brightening an icon).
    public var onHoverChange: ((Bool) -> Void)?

    private var hovering = false

    public override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.cornerRadius = cornerRadius
        focusRingType = .default
        refusesFirstResponder = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("HoverButton is code-only") }

    public override var intrinsicContentSize: NSSize {
        var size = super.intrinsicContentSize
        size.width += horizontalPadding * 2
        return size
    }

    public override var acceptsFirstResponder: Bool { true }

    public override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    public override func keyDown(with event: NSEvent) {
        if KeyboardActivation.matches(event) {
            performClick(nil)
            return
        }
        super.keyDown(with: event)
    }

    public override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(
            rect: .zero,
            options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
            owner: self
        ))
    }

    public override func mouseEntered(with event: NSEvent) { hovering = true; applyBackground(); onHoverChange?(true) }
    public override func mouseExited(with event: NSEvent) { hovering = false; applyBackground(); onHoverChange?(false) }

    public override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyBackground()
    }

    private func applyBackground() {
        let color = hovering ? hoverColor : restingColor
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.backgroundColor = color.cgColor
        }
    }

    /// A flat "chip" button: borderless, padded, faint resting fill that strengthens on
    /// hover. For standalone actions (＋ Terminal, ＋ Add Workspace).
    public static func chip(title: String, target: AnyObject?, action: Selector?) -> HoverButton {
        let button = HoverButton(frame: .zero)
        button.title = title
        button.isBordered = false
        button.bezelStyle = .regularSquare
        button.font = .systemFont(ofSize: 11, weight: .medium)
        button.contentTintColor = .labelColor
        button.cornerRadius = 6
        button.horizontalPadding = 9
        button.restingColor = chipResting
        button.hoverColor = chipHover
        button.target = target
        button.action = action
        button.translatesAutoresizingMaskIntoConstraints = false
        return button
    }

    /// A near-invisible idle wash that reads as a hover highlight without competing with
    /// content. White over dark, black over light; appearance-resolved.
    public static let subtleFill = NSColor(name: nil) { appearance in
        let dark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        return NSColor(white: dark ? 1 : 0, alpha: dark ? 0.10 : 0.06)
    }

    static let chipResting = NSColor(name: nil) { appearance in
        let dark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        return NSColor(white: dark ? 1 : 0, alpha: dark ? 0.07 : 0.05)
    }

    static let chipHover = NSColor(name: nil) { appearance in
        let dark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        return NSColor(white: dark ? 1 : 0, alpha: dark ? 0.15 : 0.11)
    }
}
