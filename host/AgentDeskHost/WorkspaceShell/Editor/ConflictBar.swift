import AppKit

/// The amber "changed/deleted on disk" banner above the editor surface. Owns its own collapse
/// height (the host only pins its edges) and shows the buttons that match the conflict `State`.
/// Buttons are created once and toggled, so it never rebuilds its subviews per render.
final class ConflictBar: NSView {
    enum State: Equatable {
        case hidden
        case changedOnDisk(fileName: String)
        case deletedOnDisk(fileName: String, canRecreate: Bool)
    }

    var onKeepMine: (() -> Void)?
    var onUseDisk: (() -> Void)?
    var onSaveToRecreate: (() -> Void)?
    var onCloseTab: (() -> Void)?

    private let label = NSTextField(labelWithString: "")
    private let actions = NSStackView()
    private let keepMineButton = NSButton(title: "Keep mine", target: nil, action: nil)
    private let useDiskButton = NSButton(title: "Use disk", target: nil, action: nil)
    private let saveToRecreateButton = NSButton(title: "Save to recreate", target: nil, action: nil)
    private let closeTabButton = NSButton(title: "Close tab", target: nil, action: nil)
    private var heightConstraint: NSLayoutConstraint!

    private static let expandedHeight: CGFloat = 38
    private static let background = NSColor(calibratedRed: 0.24, green: 0.18, blue: 0.07, alpha: 1)
    private static let foreground = NSColor(calibratedRed: 0.94, green: 0.85, blue: 0.66, alpha: 1)

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.backgroundColor = Self.background.cgColor
        layer?.masksToBounds = true
        translatesAutoresizingMaskIntoConstraints = false

        label.textColor = Self.foreground
        label.font = .systemFont(ofSize: 12)
        label.lineBreakMode = .byTruncatingTail
        label.translatesAutoresizingMaskIntoConstraints = false

        actions.orientation = .horizontal
        actions.spacing = 8
        actions.translatesAutoresizingMaskIntoConstraints = false

        let buttons: [(NSButton, Selector)] = [
            (keepMineButton, #selector(keepMine)),
            (useDiskButton, #selector(useDisk)),
            (saveToRecreateButton, #selector(saveToRecreate)),
            (closeTabButton, #selector(closeTab)),
        ]
        for (button, selector) in buttons {
            button.bezelStyle = .rounded
            button.target = self
            button.action = selector
            actions.addArrangedSubview(button)
        }

        addSubview(label)
        addSubview(actions)
        heightConstraint = heightAnchor.constraint(equalToConstant: 0)
        NSLayoutConstraint.activate([
            heightConstraint,
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
            actions.leadingAnchor.constraint(greaterThanOrEqualTo: label.trailingAnchor, constant: 12),
            actions.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            actions.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("ConflictBar is code-only") }

    func render(_ state: State) {
        switch state {
        case .hidden:
            isHidden = true
            heightConstraint.constant = 0
            label.isHidden = true
            actions.isHidden = true
        case .changedOnDisk(let fileName):
            isHidden = false
            heightConstraint.constant = Self.expandedHeight
            label.isHidden = false
            actions.isHidden = false
            label.stringValue = "\(fileName) changed on disk while you were editing."
            keepMineButton.isHidden = false
            useDiskButton.isHidden = false
            saveToRecreateButton.isHidden = true
            closeTabButton.isHidden = true
        case .deletedOnDisk(let fileName, let canRecreate):
            isHidden = false
            heightConstraint.constant = Self.expandedHeight
            label.isHidden = false
            actions.isHidden = false
            label.stringValue = "\(fileName) was deleted on disk."
            keepMineButton.isHidden = true
            useDiskButton.isHidden = true
            saveToRecreateButton.isHidden = !canRecreate
            closeTabButton.isHidden = false
        }
    }

    @objc private func keepMine() { onKeepMine?() }
    @objc private func useDisk() { onUseDisk?() }
    @objc private func saveToRecreate() { onSaveToRecreate?() }
    @objc private func closeTab() { onCloseTab?() }
}
