import AppKit

/// The dropdown beside a "＋" chip: every open window of that family, each of which can be gone to or
/// closed. One menu serves every family, because a list of windows is the same list whichever it is.
///
/// Built fresh each time it is opened, from a list asked for at that moment. A menu that cached its
/// rows would offer to close a window that had since closed itself, and would omit one opened since.
///
/// Rows are custom views rather than ordinary items, so they carry their own trailing close button.
/// That costs them AppKit's highlighting and its click-to-act, both of which the row does itself.
@MainActor
enum WorkspaceWindowChooserMenu {
    static func accessibilityIdentifier(for kind: WorkspaceWindowKind) -> String {
        "\(kind.identifierPrefix)-window-chooser"
    }

    static func emptyItemIdentifier(for kind: WorkspaceWindowKind) -> String {
        "\(accessibilityIdentifier(for: kind))-empty"
    }

    static func closeIdentifier(for kind: WorkspaceWindowKind, id: UUID) -> String {
        "\(accessibilityIdentifier(for: kind))-close-\(id.uuidString)"
    }

    static func make(
        kind: WorkspaceWindowKind,
        windows: [WorkspaceWindowSummary],
        focus: @escaping (UUID) -> Void,
        close: @escaping (UUID) -> Void
    ) -> NSMenu {
        let menu = NSMenu()
        menu.setAccessibilityIdentifier(accessibilityIdentifier(for: kind))
        // Rows are custom views, and AppKit would otherwise reserve the leading gutter every view
        // has to indent past for a state column none of them use.
        menu.autoenablesItems = false

        guard !windows.isEmpty else {
            let empty = NSMenuItem(title: "No \(kind.label) windows open", action: nil, keyEquivalent: "")
            empty.isEnabled = false
            empty.setAccessibilityIdentifier(emptyItemIdentifier(for: kind))
            menu.addItem(empty)
            return menu
        }

        for window in windows {
            let item = NSMenuItem(title: window.title, action: nil, keyEquivalent: "")
            item.representedObject = window.id
            item.setAccessibilityIdentifier("\(accessibilityIdentifier(for: kind))-row-\(window.id.uuidString)")
            item.view = WorkspaceWindowChooserRow(window: window, focus: focus, close: close)
            menu.addItem(item)
        }
        return menu
    }
}

/// One row: the window's name, which goes to it, and the button that closes it.
@MainActor
final class WorkspaceWindowChooserRow: NSView {
    private let windowID: UUID
    private let focus: (UUID) -> Void
    private let close: (UUID) -> Void
    private let label: NSTextField
    private let closeButton: NSButton
    private let highlight = NSVisualEffectView()
    private var trackingArea: NSTrackingArea?

    init(window: WorkspaceWindowSummary, focus: @escaping (UUID) -> Void, close: @escaping (UUID) -> Void) {
        self.windowID = window.id
        self.focus = focus
        self.close = close

        label = NSTextField(labelWithString: window.title)
        label.font = .menuFont(ofSize: 13)
        label.lineBreakMode = .byTruncatingTail
        label.translatesAutoresizingMaskIntoConstraints = false

        closeButton = NSButton(frame: .zero)
        super.init(frame: NSRect(x: 0, y: 0, width: 240, height: 24))

        // The system's own menu selection, rather than a filled rectangle in an approximated accent
        // color: it follows the user's accent, their appearance, and the reduce-transparency setting
        // without this row tracking any of them.
        highlight.material = .selection
        highlight.state = .active
        highlight.isEmphasized = true
        highlight.blendingMode = .behindWindow
        highlight.wantsLayer = true
        highlight.layer?.cornerRadius = 4
        highlight.isHidden = true
        highlight.translatesAutoresizingMaskIntoConstraints = false

        closeButton.isBordered = false
        closeButton.bezelStyle = .regularSquare
        closeButton.imagePosition = .imageOnly
        closeButton.image = NSImage(
            systemSymbolName: "xmark.circle.fill",
            accessibilityDescription: "Close \(window.title)"
        )?.withSymbolConfiguration(.init(pointSize: 12, weight: .regular))
        closeButton.contentTintColor = .secondaryLabelColor
        closeButton.target = self
        closeButton.action = #selector(closeTapped)
        closeButton.toolTip = "Close \(window.title)"
        closeButton.setAccessibilityIdentifier(
            WorkspaceWindowChooserMenu.closeIdentifier(for: window.kind, id: window.id)
        )
        closeButton.setAccessibilityLabel("Close \(window.title)")
        closeButton.translatesAutoresizingMaskIntoConstraints = false

        setAccessibilityRole(.button)
        setAccessibilityLabel("Go to \(window.title)")

        addSubview(highlight)
        addSubview(label)
        addSubview(closeButton)
        NSLayoutConstraint.activate([
            // Inset to match the system's own highlight, which stops short of the menu's edges.
            highlight.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 5),
            highlight.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -5),
            highlight.topAnchor.constraint(equalTo: topAnchor),
            highlight.bottomAnchor.constraint(equalTo: bottomAnchor),
            // The leading inset matches a standard menu item's text, so the chooser's rows line up
            // with the "No ... windows open" item and with the menus around it.
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
            closeButton.leadingAnchor.constraint(greaterThanOrEqualTo: label.trailingAnchor, constant: 12),
            closeButton.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            closeButton.centerYAnchor.constraint(equalTo: centerYAnchor),
            closeButton.widthAnchor.constraint(equalToConstant: 18),
            closeButton.heightAnchor.constraint(equalToConstant: 18),
            widthAnchor.constraint(greaterThanOrEqualToConstant: 240),
            heightAnchor.constraint(equalToConstant: 24),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    /// Whether this row is the one under the pointer.
    var isHighlighted: Bool { !highlight.isHidden }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingArea { removeTrackingArea(trackingArea) }
        // A menu runs its own event loop, and a view item inside it is only told about the pointer
        // through a tracking area it installs itself.
        let area = NSTrackingArea(
            rect: .zero,
            options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(area)
        trackingArea = area
    }

    override func mouseEntered(with event: NSEvent) {
        setHighlighted(true)
    }

    override func mouseExited(with event: NSEvent) {
        setHighlighted(false)
    }

    /// Clicking the row goes to its window. The close button is a subview and consumes its own
    /// clicks, so the two actions never overlap despite sharing the row.
    override func mouseUp(with event: NSEvent) {
        dismissMenu()
        focus(windowID)
    }

    private func setHighlighted(_ highlighted: Bool) {
        highlight.isHidden = !highlighted
        label.textColor = highlighted ? .selectedMenuItemTextColor : .labelColor
        closeButton.contentTintColor = highlighted ? .selectedMenuItemTextColor : .secondaryLabelColor
    }

    @objc private func closeTapped() {
        dismissMenu()
        close(windowID)
    }

    /// Dismissed before either action runs: the row is about to describe a window that has closed or
    /// moved to the front, and a menu left open would keep offering the state it was built from.
    private func dismissMenu() {
        enclosingMenuItem?.menu?.cancelTracking()
    }
}
