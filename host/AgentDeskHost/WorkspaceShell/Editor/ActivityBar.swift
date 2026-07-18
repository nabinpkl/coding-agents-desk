import AppKit

/// The sidebar panel selected by the activity bar.
public enum SidebarTab: CaseIterable, Equatable {
    case explorer
    case sourceControl

    var symbolName: String {
        switch self {
        case .explorer: return "doc.on.doc"
        case .sourceControl: return "arrow.triangle.branch"
        }
    }

    var label: String {
        switch self {
        case .explorer: return "Explorer"
        case .sourceControl: return "Source Control"
        }
    }

    var accessibilityIdentifier: String {
        "activity-\(label.lowercased().replacingOccurrences(of: " ", with: "-"))"
    }
}

/// Horizontal Explorer and Source Control tabs. Selection changes only the visible sidebar panel;
/// both panels continue receiving the same live Git snapshot.
@MainActor
public final class ActivityBar: NSObject {
    public let view = NSView()
    public var onSelect: ((SidebarTab) -> Void)?
    public private(set) var selected: SidebarTab = .explorer

    private var buttons: [HoverButton] = []
    private var hovered: Set<Int> = []
    private let underline = NSBox()
    private var underlineConstraints: [NSLayoutConstraint] = []
    private let sourceControlBadge = SourceControlCountBadge()

    private static let iconSize: CGFloat = 16
    private static let buttonWidth: CGFloat = 34

    public override init() {
        super.init()
        build()
        highlight(.explorer)
    }

    /// Select without firing `onSelect`, for state restoration and AX-driven synchronization.
    public func select(_ tab: SidebarTab) {
        guard tab != selected else { return }
        highlight(tab)
    }

    public func setSourceControlCount(_ count: Int) {
        sourceControlBadge.count = count
    }

    private func build() {
        let stack = NSStackView()
        stack.orientation = .horizontal
        stack.spacing = 2
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.setAccessibilityRole(.tabGroup)
        view.setAccessibilityLabel("Sidebar panels")
        view.setAccessibilityIdentifier("activity-bar")
        view.addSubview(stack)

        for (index, tab) in SidebarTab.allCases.enumerated() {
            let button = HoverButton()
            button.cornerRadius = 5
            button.bezelStyle = .regularSquare
            button.isBordered = false
            button.imagePosition = .imageOnly
            button.image = NSImage(
                systemSymbolName: tab.symbolName,
                accessibilityDescription: tab.label
            )?.withSymbolConfiguration(.init(pointSize: Self.iconSize, weight: .regular))
            button.toolTip = tab.label
            button.setAccessibilityIdentifier(tab.accessibilityIdentifier)
            button.setAccessibilityLabel(tab.label)
            button.setAccessibilityHelp("Show \(tab.label)")
            button.tag = index
            button.target = self
            button.action = #selector(tabClicked(_:))
            button.onHoverChange = { [weak self] hovering in
                guard let self else { return }
                if hovering { self.hovered.insert(index) } else { self.hovered.remove(index) }
                self.applyTint(index)
            }
            button.translatesAutoresizingMaskIntoConstraints = false
            buttons.append(button)
            stack.addArrangedSubview(button)
            NSLayoutConstraint.activate([
                button.widthAnchor.constraint(equalToConstant: Self.buttonWidth),
                button.topAnchor.constraint(equalTo: stack.topAnchor, constant: 2),
                button.bottomAnchor.constraint(equalTo: stack.bottomAnchor),
            ])
        }

        underline.boxType = .custom
        underline.borderWidth = 0
        underline.fillColor = AppTheme.accent
        underline.translatesAutoresizingMaskIntoConstraints = false
        underline.setAccessibilityElement(false)
        view.addSubview(underline)

        sourceControlBadge.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(sourceControlBadge)

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 10),
            stack.topAnchor.constraint(equalTo: view.topAnchor),
            stack.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            underline.heightAnchor.constraint(equalToConstant: 2),
            underline.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])

        if let index = SidebarTab.allCases.firstIndex(of: .sourceControl) {
            let button = buttons[index]
            NSLayoutConstraint.activate([
                sourceControlBadge.trailingAnchor.constraint(equalTo: button.trailingAnchor, constant: 2),
                sourceControlBadge.topAnchor.constraint(equalTo: view.topAnchor, constant: 1),
            ])
        }
    }

    @objc private func tabClicked(_ sender: NSButton) {
        let tab = SidebarTab.allCases[sender.tag]
        guard tab != selected else { return }
        highlight(tab)
        onSelect?(tab)
    }

    private func highlight(_ tab: SidebarTab) {
        selected = tab
        for index in buttons.indices {
            applyTint(index)
            let isSelected = SidebarTab.allCases[index] == tab
            buttons[index].hoverColor = isSelected ? .clear : HoverButton.subtleFill
            buttons[index].setAccessibilitySelected(isSelected)
            buttons[index].setAccessibilityValue(isSelected ? "selected" : "not selected")
        }
        guard let activeIndex = SidebarTab.allCases.firstIndex(of: tab) else { return }
        let active = buttons[activeIndex]
        NSLayoutConstraint.deactivate(underlineConstraints)
        underlineConstraints = [
            underline.leadingAnchor.constraint(equalTo: active.leadingAnchor),
            underline.trailingAnchor.constraint(equalTo: active.trailingAnchor),
        ]
        NSLayoutConstraint.activate(underlineConstraints)
    }

    private func applyTint(_ index: Int) {
        let color: NSColor
        if SidebarTab.allCases[index] == selected {
            color = .labelColor
        } else if hovered.contains(index) {
            color = .secondaryLabelColor
        } else {
            color = .tertiaryLabelColor
        }
        buttons[index].contentTintColor = color
    }
}

@MainActor
private final class SourceControlCountBadge: NSView {
    private let label = NSTextField(labelWithString: "")

    var count = 0 { didSet { refresh() } }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.backgroundColor = AppTheme.accent.cgColor
        label.font = .systemFont(ofSize: 10, weight: .semibold)
        label.textColor = AppTheme.onAccent
        label.alignment = .center
        label.setAccessibilityElement(false)
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        setAccessibilityElement(true)
        setAccessibilityRole(.staticText)
        setAccessibilityIdentifier("source-control-count")
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: centerXAnchor),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
        refresh()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("SourceControlCountBadge is code-only") }

    private func refresh() {
        isHidden = count <= 0
        label.stringValue = count > 99 ? "99+" : "\(count)"
        setAccessibilityLabel(count == 1 ? "1 source control change" : "\(count) source control changes")
        setAccessibilityValue(count)
        invalidateIntrinsicContentSize()
    }

    override var intrinsicContentSize: NSSize {
        let height: CGFloat = 15
        return NSSize(width: max(height, label.intrinsicContentSize.width + 8), height: height)
    }

    override func layout() {
        super.layout()
        layer?.cornerRadius = bounds.height / 2
    }
}
