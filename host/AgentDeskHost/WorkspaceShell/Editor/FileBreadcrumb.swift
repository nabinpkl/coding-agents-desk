import AppKit

/// Native file-location breadcrumb for the Swift-owned viewer chrome. Directory segments open
/// menus; the final file segment is a location label, not a parent-directory action.
final class FileBreadcrumb: NSView {
    var onOpenFile: ((URL) -> Void)?
    var onListDirectory: ((URL) -> [DirectoryListingEntry])?

    private static let menuGap: CGFloat = 8

    private let stack = NSStackView()
    private var menuDelegates: [DirectoryMenuDelegate] = []

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        stack.orientation = .horizontal
        stack.alignment = .centerY
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
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func render(workspaceRoot workspace: Workspace) {
        let segments = FileBreadcrumbSegment.segments(forRootOf: workspace)
        render(segments: segments, currentFile: nil)
        toolTip = workspace.root.path
    }

    func render(file: URL, workspace: Workspace?) {
        let segments = FileBreadcrumbSegment.segments(for: file, in: workspace)
        render(segments: segments, currentFile: file)
        toolTip = workspace.map { "\($0.name)/\(FileBreadcrumbSegment.displayPath(for: file, in: $0))" }
            ?? file.path
    }

    private func render(segments: [FileBreadcrumbSegment], currentFile: URL?) {
        stack.arrangedSubviews.forEach { view in stack.removeArrangedSubview(view); view.removeFromSuperview() }
        for (index, segment) in segments.enumerated() {
            if index > 0 { stack.addArrangedSubview(separator()) }
            if let currentFile, index == segments.count - 1 {
                stack.addArrangedSubview(fileLabel(for: segment, file: currentFile))
            } else {
                stack.addArrangedSubview(button(for: segment, isRoot: index == 0))
            }
        }
        invalidateIntrinsicContentSize()
    }

    func clear() {
        stack.arrangedSubviews.forEach { view in stack.removeArrangedSubview(view); view.removeFromSuperview() }
        invalidateIntrinsicContentSize()
        toolTip = nil
    }

    override var intrinsicContentSize: NSSize {
        let size = stack.fittingSize
        return NSSize(width: size.width, height: max(28, size.height))
    }

    private func button(for segment: FileBreadcrumbSegment, isRoot: Bool) -> NSButton {
        let button = FileBreadcrumbButton(segment: segment)
        button.onPress = { [weak self, weak button] in
            guard let self, let button else { return }
            self.showMenu(for: segment, from: button)
        }
        button.image = FileIcon.image(for: segment.directory, isDirectory: true)
        button.imagePosition = .imageLeft
        button.imageHugsTitle = true
        button.toolTip = segment.directory.path
        button.identifier = NSUserInterfaceItemIdentifier("breadcrumb-\(segment.directory.path)-\(segment.title)")
        button.setAccessibilityIdentifier("breadcrumb-\(segment.directory.path)-\(segment.title)")
        button.setAccessibilityTitle(segment.title)
        button.setAccessibilityHelp(isRoot ? "Show workspace root contents" : "Show files in \(segment.directory.path)")
        button.translatesAutoresizingMaskIntoConstraints = false
        button.setContentHuggingPriority(.defaultHigh, for: .horizontal)
        button.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)
        button.heightAnchor.constraint(equalToConstant: 28).isActive = true
        return button
    }

    private func separator() -> NSTextField {
        let label = NSTextField(labelWithString: "›")
        label.textColor = .tertiaryLabelColor
        label.font = .systemFont(ofSize: 13, weight: .medium)
        label.translatesAutoresizingMaskIntoConstraints = false
        label.setContentHuggingPriority(.required, for: .horizontal)
        label.setContentCompressionResistancePriority(.required, for: .horizontal)
        label.widthAnchor.constraint(equalToConstant: 18).isActive = true
        label.alignment = .center
        label.setAccessibilityElement(false)
        return label
    }

    private func fileLabel(for segment: FileBreadcrumbSegment, file: URL) -> NSView {
        let label = FileBreadcrumbCurrentFileView(title: segment.title, file: file)
        label.translatesAutoresizingMaskIntoConstraints = false
        label.setContentHuggingPriority(.defaultLow, for: .horizontal)
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return label
    }

    private func showMenu(for segment: FileBreadcrumbSegment, from sender: NSButton) {
        sender.window?.makeKeyAndOrderFront(nil)
        menuDelegates = []
        let menu = NSMenu(title: segment.title)
        populate(menu, directory: segment.directory)
        let point = NSPoint(x: 0, y: sender.bounds.maxY + Self.menuGap)
        menu.popUp(positioning: nil as NSMenuItem?, at: point, in: sender)
    }

    fileprivate func populate(_ menu: NSMenu, directory: URL) {
        menu.removeAllItems()
        let entries = onListDirectory?(directory) ?? []
        if entries.isEmpty {
            menu.addItem(disabledItem("empty"))
            return
        }
        for entry in entries {
            menu.addItem(item(for: entry))
        }
    }

    private func item(for entry: DirectoryListingEntry) -> NSMenuItem {
        let item = NSMenuItem(
            title: entry.url.lastPathComponent,
            action: entry.isDirectory ? nil : #selector(openFile(_:)),
            keyEquivalent: ""
        )
        item.attributedTitle = menuTitle(for: entry)
        item.representedObject = entry.url
        item.image = FileIcon.image(for: entry.url, isDirectory: entry.isDirectory)
        item.target = self

        if entry.isDirectory {
            let submenu = NSMenu(title: entry.url.lastPathComponent)
            let delegate = DirectoryMenuDelegate(owner: self, directory: entry.url)
            menuDelegates.append(delegate)
            submenu.delegate = delegate
            item.submenu = submenu
        }
        return item
    }

    private func menuTitle(for entry: DirectoryListingEntry) -> NSAttributedString {
        let name = entry.url.lastPathComponent
        let status = entry.git
        let title = NSMutableAttributedString(
            string: name,
            attributes: menuTitleAttributes(for: status)
        )
        if let status, !entry.isDirectory, status != .ignored {
            title.append(NSAttributedString(
                string: "  \(status.badgeLetter)",
                attributes: menuBadgeAttributes(for: status)
            ))
        }
        return title
    }

    private func menuTitleAttributes(for status: GitFileStatus?) -> [NSAttributedString.Key: Any] {
        [
            .font: NSFont.systemFont(ofSize: 13, weight: .medium),
            .foregroundColor: status?.tint ?? NSColor.labelColor,
        ]
    }

    private func menuBadgeAttributes(for status: GitFileStatus) -> [NSAttributedString.Key: Any] {
        [
            .font: NSFont.monospacedSystemFont(ofSize: 11, weight: .semibold),
            .foregroundColor: status.tint,
            .backgroundColor: SectionTabStyle.activeBackground,
        ]
    }

    private func disabledItem(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    @objc private func openFile(_ sender: NSMenuItem) {
        guard let url = sender.representedObject as? URL else { return }
        onOpenFile?(url)
    }
}

private final class FileBreadcrumbButton: HoverButton {
    let segment: FileBreadcrumbSegment
    var onPress: (() -> Void)?

    init(segment: FileBreadcrumbSegment) {
        self.segment = segment
        super.init(frame: .zero)
        title = segment.title
        isBordered = false
        alignment = .left
        bezelStyle = .regularSquare
        font = .systemFont(ofSize: 13, weight: .medium)
        contentTintColor = .labelColor
        lineBreakMode = .byTruncatingTail
        cornerRadius = 0
        horizontalPadding = 8
        restingColor = .clear
        hoverColor = HoverButton.subtleFill
        setAccessibilityLabel(segment.title)
        setAccessibilityRole(.button)
        target = self
        action = #selector(press)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func accessibilityPerformPress() -> Bool {
        onPress?()
        return true
    }

    @objc private func press() {
        onPress?()
    }
}

private final class FileBreadcrumbCurrentFileView: NSView {
    private let icon = NSImageView()
    private let label: NSTextField

    init(title: String, file: URL) {
        label = NSTextField(labelWithString: title)
        super.init(frame: .zero)

        icon.image = FileIcon.image(for: file, isDirectory: false)
        icon.imageScaling = .scaleProportionallyDown
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.setAccessibilityElement(false)

        label.textColor = .labelColor
        label.font = .systemFont(ofSize: 13, weight: .semibold)
        label.lineBreakMode = .byTruncatingTail
        label.translatesAutoresizingMaskIntoConstraints = false
        label.setAccessibilityElement(false)

        toolTip = file.standardizedFileURL.path
        setAccessibilityIdentifier("breadcrumb-current-file")
        setAccessibilityLabel(title)
        setAccessibilityRole(.staticText)

        addSubview(icon)
        addSubview(label)
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 28),
            icon.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 4),
            icon.centerYAnchor.constraint(equalTo: centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 16),
            icon.heightAnchor.constraint(equalToConstant: 16),
            label.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 6),
            label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -4),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var intrinsicContentSize: NSSize {
        let text = label.intrinsicContentSize
        return NSSize(width: 30 + text.width, height: 28)
    }
}

private final class DirectoryMenuDelegate: NSObject, NSMenuDelegate {
    private weak var owner: FileBreadcrumb?
    private let directory: URL

    init(owner: FileBreadcrumb, directory: URL) {
        self.owner = owner
        self.directory = directory
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        owner?.populate(menu, directory: directory)
    }
}
