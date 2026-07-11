import AppKit

/// The viewer's horizontal tab strip. Keeps one `TabRow` per open file and reconciles them against
/// the desired order in place — updating each row's title, dirty dot, and active highlight without
/// tearing the strip down on every keystroke. Activate/close clicks route back through the callbacks.
final class TabStripView: NSView {
    var onActivate: ((FileTabIdentity) -> Void)?
    var onClose: ((FileTabIdentity) -> Void)?

    private let stack = NSStackView()
    private var rows: [FileTabIdentity: TabRow] = [:]

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        stack.orientation = .horizontal
        stack.alignment = .centerY
        stack.distribution = .fill
        stack.spacing = 0
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("TabStripView is code-only") }

    func render(order: [FileTabIdentity], active: FileTabIdentity?, isDirty: (FileTabIdentity) -> Bool) {
        let wanted = Set(order)
        for (identity, row) in rows where !wanted.contains(identity) {
            stack.removeArrangedSubview(row)
            row.removeFromSuperview()
            rows[identity] = nil
        }
        for (index, identity) in order.enumerated() {
            let row = rows[identity] ?? makeRow(for: identity)
            if let currentIndex = stack.arrangedSubviews.firstIndex(of: row), currentIndex != index {
                stack.removeArrangedSubview(row)
                stack.insertArrangedSubview(row, at: min(index, stack.arrangedSubviews.count))
            } else if !stack.arrangedSubviews.contains(row) {
                stack.insertArrangedSubview(row, at: min(index, stack.arrangedSubviews.count))
            }
            row.showsLeadingDivider = index == 0
            row.update(identity: identity, dirty: isDirty(identity), active: identity == active)
        }
    }

    private func makeRow(for identity: FileTabIdentity) -> TabRow {
        let row = TabRow(identity: identity)
        row.onActivate = { [weak self] in self?.onActivate?(identity) }
        row.onClose = { [weak self] in self?.onClose?(identity) }
        rows[identity] = row
        return row
    }
}

/// One tab: a left-aligned title button and a trailing close button. The row is its own
/// target-action sink (no per-render closure churn), so the strip can reconcile rows in place.
private final class TabRow: NSView {
    let identity: FileTabIdentity
    var onActivate: (() -> Void)?
    var onClose: (() -> Void)?

    private let titleButton = NSButton(title: "", target: nil, action: nil)
    private let closeButton = NSButton(title: "", target: nil, action: nil)
    private let activeRule = CALayer()
    private let leadingDivider = CALayer()
    private let trailingDivider = CALayer()
    private let bottomMask = CALayer()
    private var isActive = false
    fileprivate var showsLeadingDivider = false { didSet { applyLayerStyle() } }
    private var hovering = false

    private static let width: CGFloat = 210
    private static let height: CGFloat = 34
    private static let closeWidth: CGFloat = 24

    init(identity: FileTabIdentity) {
        self.identity = identity
        super.init(frame: .zero)
        wantsLayer = true
        translatesAutoresizingMaskIntoConstraints = false
        layer?.cornerRadius = 0
        layer?.masksToBounds = false
        setupLayers()

        titleButton.isBordered = false
        titleButton.alignment = .left
        titleButton.font = .systemFont(ofSize: 13, weight: .medium)
        titleButton.image = Self.image(for: identity)
        titleButton.imagePosition = .imageLeft
        titleButton.imageHugsTitle = true
        titleButton.lineBreakMode = .byTruncatingTail
        titleButton.setContentHuggingPriority(.defaultLow, for: .horizontal)
        titleButton.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        titleButton.target = self
        titleButton.action = #selector(activate)
        titleButton.translatesAutoresizingMaskIntoConstraints = false

        closeButton.isBordered = false
        closeButton.alignment = .center
        closeButton.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: "Close")?
            .withSymbolConfiguration(.init(pointSize: 10, weight: .medium))
        closeButton.imagePosition = .imageOnly
        closeButton.setContentHuggingPriority(.required, for: .horizontal)
        closeButton.setContentCompressionResistancePriority(.required, for: .horizontal)
        closeButton.target = self
        closeButton.action = #selector(closeTab)
        closeButton.translatesAutoresizingMaskIntoConstraints = false

        addSubview(titleButton)
        addSubview(closeButton)
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: Self.width),
            heightAnchor.constraint(equalToConstant: Self.height),
            titleButton.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            titleButton.centerYAnchor.constraint(equalTo: centerYAnchor),
            closeButton.leadingAnchor.constraint(equalTo: titleButton.trailingAnchor, constant: 4),
            closeButton.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            closeButton.centerYAnchor.constraint(equalTo: centerYAnchor),
            closeButton.widthAnchor.constraint(equalToConstant: Self.closeWidth),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("TabRow is code-only") }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(
            rect: .zero,
            options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
            owner: self
        ))
    }

    override func layout() {
        super.layout()
        let pixel = SectionTabStyle.pixel(for: self)
        activeRule.frame = NSRect(x: 0, y: bounds.height - pixel, width: bounds.width, height: pixel)
        bottomMask.frame = NSRect(x: 0, y: -pixel, width: bounds.width, height: pixel)
        leadingDivider.frame = NSRect(x: 0, y: 0, width: pixel, height: bounds.height)
        trailingDivider.frame = NSRect(x: bounds.width - pixel, y: 0, width: pixel, height: bounds.height)
    }

    override func mouseEntered(with event: NSEvent) {
        hovering = true
        applyLayerStyle()
    }

    override func mouseExited(with event: NSEvent) {
        hovering = false
        applyLayerStyle()
    }

    func update(identity: FileTabIdentity, dirty: Bool, active: Bool) {
        isActive = active
        let name = identity.displayName
        titleButton.title = (dirty ? "● " : "") + name
        titleButton.image = Self.image(for: identity)
        titleButton.identifier = NSUserInterfaceItemIdentifier("tab-\(identity.accessibilityKey)")
        titleButton.setAccessibilityIdentifier("tab-\(identity.accessibilityKey)")
        titleButton.setAccessibilityTitle(active ? "Active tab \(name)" : "Tab \(name)")
        titleButton.setAccessibilityHelp(active ? "Active editor tab" : "Activate editor tab")
        titleButton.setAccessibilitySelected(active)
        titleButton.setAccessibilityValue(active ? "active" : "inactive")
        titleButton.contentTintColor = active ? .labelColor : .secondaryLabelColor
        closeButton.identifier = NSUserInterfaceItemIdentifier("close-tab-\(identity.accessibilityKey)")
        closeButton.setAccessibilityIdentifier("close-tab-\(identity.accessibilityKey)")
        closeButton.setAccessibilityTitle("Close tab \(name)")
        closeButton.setAccessibilityHelp("Close editor tab")
        closeButton.contentTintColor = active ? .labelColor : .secondaryLabelColor
        applyLayerStyle()
        titleButton.setAccessibilityLabel(active ? "Active tab \(name)" : "Tab \(name)")
        closeButton.setAccessibilityLabel("Close tab \(name)")
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyLayerStyle()
    }

    private func setupLayers() {
        guard let layer else { return }
        layer.addSublayer(activeRule)
        layer.addSublayer(leadingDivider)
        layer.addSublayer(trailingDivider)
        layer.addSublayer(bottomMask)
    }

    private static func image(for identity: FileTabIdentity) -> NSImage? {
        if identity.isHTMLPreview {
            return NSImage(systemSymbolName: "globe", accessibilityDescription: "Preview")?
                .withSymbolConfiguration(.init(pointSize: 12, weight: .medium))
        }
        return FileIcon.image(for: identity.url, isDirectory: false)
    }

    private func applyLayerStyle() {
        let activeBackground = SectionTabStyle.activeBackground
        let background: NSColor
        if isActive {
            background = activeBackground
        } else if hovering {
            background = HoverButton.subtleFill
        } else {
            background = .clear
        }
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.backgroundColor = background.cgColor
            activeRule.backgroundColor = isActive ? AppTheme.accent.cgColor : NSColor.clear.cgColor
            bottomMask.backgroundColor = isActive ? activeBackground.cgColor : NSColor.clear.cgColor
            leadingDivider.backgroundColor = showsLeadingDivider ? SectionTabStyle.divider.cgColor : NSColor.clear.cgColor
            trailingDivider.backgroundColor = SectionTabStyle.divider.cgColor
        }
        needsLayout = true
    }

    @objc private func activate() { onActivate?() }
    @objc private func closeTab() { onClose?() }
}
