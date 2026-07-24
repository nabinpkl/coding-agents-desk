import AppKit

@MainActor
final class DockDesktopSwapStatusView: NSVisualEffectView {
    private let statusLabel = NSTextField(labelWithString: "")
    private let undoButton = NSButton(title: "Undo", target: nil, action: nil)

    var onUndo: (() -> Void)?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        configure()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func render(_ state: DockDesktopSwapState, windowFocusFailure: String? = nil) {
        let instruction = state.instruction ?? windowFocusFailure
        statusLabel.stringValue = instruction ?? ""
        statusLabel.setAccessibilityLabel(instruction ?? "")
        isHidden = instruction == nil
        if case .undoAvailable = state, windowFocusFailure == nil {
            undoButton.isHidden = false
        } else {
            undoButton.isHidden = true
        }
    }

    private func configure() {
        translatesAutoresizingMaskIntoConstraints = false
        material = .hudWindow
        blendingMode = .withinWindow
        state = .active
        wantsLayer = true
        layer?.cornerRadius = 10
        isHidden = true

        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        statusLabel.lineBreakMode = .byTruncatingTail
        statusLabel.setAccessibilityIdentifier("dock-desktop-swap-status")
        statusLabel.setAccessibilityRole(.staticText)
        addSubview(statusLabel)

        undoButton.translatesAutoresizingMaskIntoConstraints = false
        undoButton.bezelStyle = .rounded
        undoButton.target = self
        undoButton.action = #selector(undoSwap)
        undoButton.keyEquivalent = "z"
        undoButton.keyEquivalentModifierMask = [.command]
        undoButton.setAccessibilityIdentifier("dock-desktop-swap-undo")
        undoButton.setAccessibilityLabel("Undo desktop content swap")
        addSubview(undoButton)

        NSLayoutConstraint.activate([
            statusLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            statusLabel.centerYAnchor.constraint(equalTo: centerYAnchor),
            undoButton.leadingAnchor.constraint(equalTo: statusLabel.trailingAnchor, constant: 12),
            undoButton.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            undoButton.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    @objc private func undoSwap() {
        onUndo?()
    }
}

@MainActor
final class DockDesktopSelectionButton: NSButton {
    private let selection: DockDesktopSwapSelection
    private let onSelect: (DockDesktopSwapSelection) -> Void

    init(
        marker: String,
        isChosen: Bool,
        selection: DockDesktopSwapSelection,
        onSelect: @escaping (DockDesktopSwapSelection) -> Void
    ) {
        self.selection = selection
        self.onSelect = onSelect
        super.init(frame: .zero)
        title = marker
        font = .systemFont(ofSize: 22, weight: .heavy)
        isBordered = false
        wantsLayer = true
        layer?.cornerRadius = 12
        layer?.borderWidth = isChosen ? 3 : 1
        let accent: NSColor = marker == "1" ? .systemOrange : .systemTeal
        layer?.backgroundColor = accent.withAlphaComponent(isChosen ? 0.34 : 0.13).cgColor
        layer?.borderColor = accent.withAlphaComponent(isChosen ? 0.95 : 0.55).cgColor
        contentTintColor = accent
        target = self
        action = #selector(activateSelection)
        setAccessibilityIdentifier("dock-desktop-select-\(selection.spaceID)")
        setAccessibilityLabel(
            isChosen
                ? "Desktop \(marker), \(selection.displayLabel), selected"
                : "Choose \(selection.displayLabel) as desktop \(marker)"
        )
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    @objc private func activateSelection() {
        onSelect(selection)
    }
}
