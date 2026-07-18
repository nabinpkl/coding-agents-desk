import AppKit

/// A live, read-only list of the active workspace's changed files. The panel consumes the exact
/// `GitStatus` snapshot used by Explorer instead of reading Git independently.
@MainActor
public final class SourceControlPanel: NSObject {
    public let view = NSView()
    public var onActivate: ((URL) -> Void)?

    private struct ChangedFile {
        let url: URL
        let relativePath: String
        let status: GitFileStatus
    }

    private let header = NSStackView()
    private let countLabel = NSTextField(labelWithString: "")
    private let table = SourceControlTableView()
    private let scroll = NSScrollView()
    private let emptyLabel = NSTextField(labelWithString: "No changes")
    private var rows: [ChangedFile] = []
    private var textZoom = WorkspaceTextZoom()

    private static let cellIdentifier = NSUserInterfaceItemIdentifier("SourceControlCell")
    private static let columnIdentifier = NSUserInterfaceItemIdentifier("SourceControlColumn")
    private static let rowIdentifier = NSUserInterfaceItemIdentifier("SourceControlRow")

    public override init() {
        super.init()
        buildHeader()
        buildTable()
        buildEmptyLabel()
        layout()
        showEmpty(true)
    }

    @discardableResult
    public func apply(_ status: GitStatus, root: URL) -> Int {
        let base = root.resolvingSymlinksInPath()
        rows = status.changes
            .compactMap {
                guard let relativePath = Self.relativePath($0.key, to: base) else { return nil }
                return ChangedFile(
                    url: $0.key,
                    relativePath: relativePath,
                    status: $0.value
                )
            }
            .sorted { $0.relativePath.localizedCaseInsensitiveCompare($1.relativePath) == .orderedAscending }
        countLabel.stringValue = "\(rows.count)"
        countLabel.setAccessibilityValue(rows.count)
        showEmpty(rows.isEmpty)
        table.reloadData()
        return rows.count
    }

    public func clear() {
        rows = []
        countLabel.stringValue = "0"
        countLabel.setAccessibilityValue(0)
        showEmpty(true)
        table.reloadData()
    }

    public func setTextZoom(_ zoom: WorkspaceTextZoom) {
        textZoom = zoom
        countLabel.font = .systemFont(ofSize: zoom.sidebarBadgePointSize, weight: .semibold)
        table.rowHeight = zoom.sidebarRowHeight
        emptyLabel.font = .systemFont(ofSize: zoom.sidebarLabelPointSize)
        table.reloadData()
        table.noteHeightOfRows(withIndexesChanged: IndexSet(integersIn: 0..<table.numberOfRows))
        table.needsDisplay = true
        view.needsDisplay = true
    }

    @discardableResult
    public func focus() -> Bool {
        guard let window = table.window else { return false }
        window.orderFrontRegardless()
        window.makeKey()
        return window.makeFirstResponder(table)
    }

    private func showEmpty(_ empty: Bool) {
        emptyLabel.isHidden = !empty
        header.isHidden = empty
        scroll.isHidden = empty
    }

    private func buildHeader() {
        let title = NSTextField(labelWithString: "Changes")
        title.font = .systemFont(ofSize: 11, weight: .semibold)
        title.textColor = .secondaryLabelColor

        countLabel.font = .systemFont(ofSize: 11, weight: .semibold)
        countLabel.textColor = .secondaryLabelColor
        countLabel.setAccessibilityIdentifier("source-control-visible-count")

        header.orientation = .horizontal
        header.spacing = 6
        header.addArrangedSubview(title)
        header.addArrangedSubview(countLabel)
        header.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(header)
    }

    private func buildTable() {
        let column = NSTableColumn(identifier: Self.columnIdentifier)
        column.resizingMask = .autoresizingMask
        table.addTableColumn(column)
        table.headerView = nil
        table.rowSizeStyle = .custom
        table.rowHeight = textZoom.sidebarRowHeight
        table.backgroundColor = .clear
        table.style = .fullWidth
        table.intercellSpacing = NSSize(width: 0, height: 2)
        table.dataSource = self
        table.delegate = self
        table.target = self
        table.action = #selector(activateClickedRow)
        table.onKeyboardActivate = { [weak self] row in self?.activate(row: row) }
        table.setAccessibilityLabel("Source Control Changes")
        table.setAccessibilityIdentifier("source-control-changes")

        scroll.documentView = table
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scroll)

        table.rowHover = RowHoverTracker(table: table)
    }

    private func buildEmptyLabel() {
        emptyLabel.font = .systemFont(ofSize: 12)
        emptyLabel.textColor = .tertiaryLabelColor
        emptyLabel.setAccessibilityIdentifier("source-control-empty")
        emptyLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(emptyLabel)
    }

    private func layout() {
        NSLayoutConstraint.activate([
            header.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 14),
            header.topAnchor.constraint(equalTo: view.topAnchor, constant: 2),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 6),
            scroll.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            emptyLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 14),
            emptyLabel.topAnchor.constraint(equalTo: view.topAnchor, constant: 4),
        ])
    }

    private static func relativePath(_ url: URL, to root: URL) -> String? {
        let resolved = url.resolvingSymlinksInPath()
        let prefix = root.path.hasSuffix("/") ? root.path : root.path + "/"
        guard resolved.path.hasPrefix(prefix) else { return nil }
        return String(resolved.path.dropFirst(prefix.count))
    }

    @objc private func activateClickedRow() {
        activate(row: table.clickedRow)
    }

    private func activate(row: Int) {
        guard rows.indices.contains(row) else { return }
        _ = focus()
        table.selectRowIndexes([row], byExtendingSelection: false)
        onActivate?(rows[row].url)
    }
}

extension SourceControlPanel: NSTableViewDataSource, NSTableViewDelegate {
    public func numberOfRows(in tableView: NSTableView) -> Int { rows.count }

    public func tableView(_ tableView: NSTableView, rowViewForRow row: Int) -> NSTableRowView? {
        let result = (tableView.makeView(withIdentifier: Self.rowIdentifier, owner: self) as? HoverRowView)
            ?? HoverRowView()
        result.identifier = Self.rowIdentifier
        return result
    }

    public func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let cell = (tableView.makeView(withIdentifier: Self.cellIdentifier, owner: self) as? SourceControlFileCell)
            ?? SourceControlFileCell(identifier: Self.cellIdentifier)
        let file = rows[row]
        cell.configure(
            url: file.url,
            relativePath: file.relativePath,
            status: file.status,
            textZoom: textZoom
        ) { [weak self] in
            self?.activate(row: row)
        }
        return cell
    }
}

@MainActor
private final class SourceControlFileCell: NSTableCellView {
    private let badge = NSTextField(labelWithString: "")
    private var iconWidthConstraint: NSLayoutConstraint?
    private var iconHeightConstraint: NSLayoutConstraint?
    private var onAccessibilityPress: (() -> Void)?

    init(identifier: NSUserInterfaceItemIdentifier) {
        super.init(frame: .zero)
        self.identifier = identifier

        let icon = NSImageView()
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.setAccessibilityElement(false)
        addSubview(icon)
        imageView = icon

        let label = NSTextField(labelWithString: "")
        label.lineBreakMode = .byTruncatingTail
        label.setAccessibilityElement(false)
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        textField = label

        badge.alignment = .center
        badge.setContentHuggingPriority(.required, for: .horizontal)
        badge.setContentCompressionResistancePriority(.required, for: .horizontal)
        badge.setAccessibilityElement(false)
        badge.translatesAutoresizingMaskIntoConstraints = false
        addSubview(badge)

        iconWidthConstraint = icon.widthAnchor.constraint(equalToConstant: 16)
        iconHeightConstraint = icon.heightAnchor.constraint(equalToConstant: 16)
        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            icon.centerYAnchor.constraint(equalTo: centerYAnchor),
            iconWidthConstraint!,
            iconHeightConstraint!,
            label.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 5),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
            badge.leadingAnchor.constraint(greaterThanOrEqualTo: label.trailingAnchor, constant: 4),
            badge.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8),
            badge.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("SourceControlFileCell is code-only") }

    func configure(
        url: URL,
        relativePath: String,
        status: GitFileStatus,
        textZoom: WorkspaceTextZoom,
        onAccessibilityPress: @escaping () -> Void
    ) {
        self.onAccessibilityPress = onAccessibilityPress
        let iconSize = textZoom.sidebarIconPointSize
        iconWidthConstraint?.constant = iconSize
        iconHeightConstraint?.constant = iconSize
        if let icon = FileIcon.image(for: url, isDirectory: false)?.copy() as? NSImage {
            icon.size = NSSize(width: iconSize, height: iconSize)
            imageView?.image = icon
        } else {
            imageView?.image = nil
        }
        textField?.stringValue = url.lastPathComponent
        textField?.font = .systemFont(
            ofSize: textZoom.sidebarLabelPointSize,
            weight: textZoom.step > 0 ? .medium : .regular
        )
        toolTip = relativePath
        badge.stringValue = status.badgeLetter
        badge.font = .monospacedSystemFont(ofSize: textZoom.sidebarBadgePointSize, weight: .semibold)
        badge.textColor = status.tint
        setAccessibilityIdentifier("source-control-\(url.path)")
        setAccessibilityLabel(url.lastPathComponent)
        setAccessibilityValue(status.accessibilityName)
        setAccessibilityRole(.button)
        setAccessibilityHelp("Open changed file \(relativePath)")
    }

    override func accessibilityPerformPress() -> Bool {
        onAccessibilityPress?()
        return true
    }
}

@MainActor
private final class SourceControlTableView: NSTableView, RowHovering {
    var rowHover: RowHoverTracker?
    var hoverArea: NSTrackingArea?
    var onKeyboardActivate: ((Int) -> Void)?

    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func keyDown(with event: NSEvent) {
        if KeyboardActivation.matches(event), selectedRow >= 0 {
            onKeyboardActivate?(selectedRow)
            return
        }
        super.keyDown(with: event)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        ensureHoverArea()
    }

    override func mouseEntered(with event: NSEvent) {
        super.mouseEntered(with: event)
        rowHover?.hover(atWindowPoint: event.locationInWindow)
    }

    override func mouseMoved(with event: NSEvent) {
        super.mouseMoved(with: event)
        rowHover?.hover(atWindowPoint: event.locationInWindow)
    }

    override func mouseExited(with event: NSEvent) {
        super.mouseExited(with: event)
        if event.trackingArea == hoverArea { rowHover?.clear() }
    }
}
