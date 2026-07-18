import AppKit

/// A fixed-size Dock action tile whose visual content is independent of `NSButtonCell` metrics.
/// The button remains the single hit target and accessibility element while the icon and label
/// are laid out explicitly with balanced vertical padding.
final class DockActionButton: HoverButton {
    static let tileSize = NSSize(width: 72, height: 64)

    var foregroundColor: NSColor = .controlAccentColor {
        didSet { applyForegroundColor() }
    }

    private let contentStack = DockActionContentStack()
    private let iconView = DockActionImageView()
    private let titleLabel: DockActionLabel

    init(title: String, systemSymbolName: String, accessibilityLabel: String) {
        titleLabel = DockActionLabel(title: title)
        super.init(frame: .zero)
        configure(
            buttonTitle: title,
            systemSymbolName: systemSymbolName,
            accessibilityLabel: accessibilityLabel
        )
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    /// `NSButtonCell` adds vertical alignment insets even for a borderless button. Those insets
    /// made a 64-point Auto Layout target render as a 70.5-point frame.
    override var alignmentRectInsets: NSEdgeInsets {
        NSEdgeInsets(top: 0, left: 0, bottom: 0, right: 0)
    }

    override var intrinsicContentSize: NSSize {
        Self.tileSize
    }

    override var isEnabled: Bool {
        didSet { contentStack.alphaValue = isEnabled ? 1 : 0.45 }
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyForegroundColor()
    }

    private func configure(
        buttonTitle: String,
        systemSymbolName: String,
        accessibilityLabel: String
    ) {
        translatesAutoresizingMaskIntoConstraints = false
        title = ""
        image = nil
        isBordered = false
        bezelStyle = .regularSquare
        imagePosition = .noImage
        alignment = .center
        focusRingType = .exterior
        setAccessibilityTitle(buttonTitle)
        setAccessibilityLabel(accessibilityLabel)

        iconView.image = NSImage(
            systemSymbolName: systemSymbolName,
            accessibilityDescription: accessibilityLabel
        )?.withSymbolConfiguration(.init(pointSize: 18, weight: .semibold))
        iconView.imageScaling = .scaleProportionallyDown
        iconView.translatesAutoresizingMaskIntoConstraints = false
        iconView.setAccessibilityElement(false)
        iconView.setAccessibilityIdentifier("dock-desktop-swap-icon")

        titleLabel.font = .systemFont(ofSize: 11, weight: .semibold)
        titleLabel.alignment = .center
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        titleLabel.setAccessibilityElement(false)
        titleLabel.setAccessibilityIdentifier("dock-desktop-swap-label")

        contentStack.orientation = .vertical
        contentStack.alignment = .centerX
        contentStack.spacing = 4
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        contentStack.setAccessibilityElement(false)
        contentStack.addArrangedSubview(iconView)
        contentStack.addArrangedSubview(titleLabel)
        addSubview(contentStack)

        NSLayoutConstraint.activate([
            iconView.widthAnchor.constraint(equalToConstant: 22),
            iconView.heightAnchor.constraint(equalToConstant: 22),
            contentStack.centerXAnchor.constraint(equalTo: centerXAnchor),
            contentStack.centerYAnchor.constraint(equalTo: centerYAnchor),
            contentStack.topAnchor.constraint(greaterThanOrEqualTo: topAnchor, constant: 10),
            contentStack.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor, constant: -10),
        ])

        applyForegroundColor()
    }

    private func applyForegroundColor() {
        iconView.contentTintColor = foregroundColor
        titleLabel.textColor = foregroundColor
    }
}

private final class DockActionContentStack: NSStackView {
    /// Keep the entire tile, including its visual descendants, as one button hit target.
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

private final class DockActionImageView: NSImageView {
    override var alignmentRectInsets: NSEdgeInsets {
        NSEdgeInsets(top: 0, left: 0, bottom: 0, right: 0)
    }
}

private final class DockActionLabel: NSTextField {
    init(title: String) {
        super.init(frame: .zero)
        stringValue = title
        isEditable = false
        isSelectable = false
        isBezeled = false
        drawsBackground = false
        lineBreakMode = .byClipping
        maximumNumberOfLines = 1
        cell?.usesSingleLineMode = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override var alignmentRectInsets: NSEdgeInsets {
        NSEdgeInsets(top: 0, left: 0, bottom: 0, right: 0)
    }
}
