import AppKit

/// The dropdown beside "＋ Agents": every open Agents window, each with a close button.
///
/// Built fresh each time it is opened, from a list asked for at that moment. A menu that cached its
/// rows would offer to close a window that had since closed itself, and would omit one opened since.
///
/// Rows are labels rather than commands. The list exists to CLOSE windows, and a row that also did
/// something when clicked would put an unlabelled action a few pixels from the close button.
@MainActor
enum AgentWindowChooserMenu {
    static let accessibilityIdentifier = "agents-window-chooser"
    static let emptyItemIdentifier = "agents-window-chooser-empty"

    static func make(
        windows: [AgentWindowSummary],
        close: @escaping (UUID) -> Void
    ) -> NSMenu {
        let menu = NSMenu()
        menu.setAccessibilityIdentifier(accessibilityIdentifier)
        // Rows are custom views, and AppKit would otherwise reserve the leading gutter every view
        // has to indent past for a state column none of them use.
        menu.autoenablesItems = false

        guard !windows.isEmpty else {
            let empty = NSMenuItem(title: "No Agents windows open", action: nil, keyEquivalent: "")
            empty.isEnabled = false
            empty.setAccessibilityIdentifier(emptyItemIdentifier)
            menu.addItem(empty)
            return menu
        }

        for window in windows {
            let item = NSMenuItem(title: window.title, action: nil, keyEquivalent: "")
            item.isEnabled = false
            item.representedObject = window.id
            item.setAccessibilityIdentifier("agents-window-chooser-row-\(window.id.uuidString)")
            item.view = AgentWindowChooserRow(window: window, close: close)
            menu.addItem(item)
        }
        return menu
    }
}

/// One row: the window's name, and the button that closes it.
@MainActor
final class AgentWindowChooserRow: NSView {
    private let windowID: UUID
    private let close: (UUID) -> Void

    init(window: AgentWindowSummary, close: @escaping (UUID) -> Void) {
        self.windowID = window.id
        self.close = close
        super.init(frame: NSRect(x: 0, y: 0, width: 240, height: 24))

        let label = NSTextField(labelWithString: window.title)
        label.font = .menuFont(ofSize: 13)
        label.lineBreakMode = .byTruncatingTail
        label.translatesAutoresizingMaskIntoConstraints = false

        let closeButton = NSButton(frame: .zero)
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
        closeButton.setAccessibilityIdentifier("agents-window-chooser-close-\(window.id.uuidString)")
        closeButton.setAccessibilityLabel("Close \(window.title)")
        closeButton.translatesAutoresizingMaskIntoConstraints = false

        addSubview(label)
        addSubview(closeButton)
        NSLayoutConstraint.activate([
            // The leading inset matches a standard menu item's text, so the chooser's rows line up
            // with the "No Agents windows open" item and with the menus around it.
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

    /// Test seam: invoking the button's action directly is what a test can do without a live menu
    /// tracking session.
    func performCloseForTesting() { closeTapped() }

    @objc private func closeTapped() {
        // Dismissed first: the row is about to describe a window that no longer exists, and a menu
        // left open would keep offering to close it a second time.
        enclosingMenuItem?.menu?.cancelTracking()
        close(windowID)
    }
}
