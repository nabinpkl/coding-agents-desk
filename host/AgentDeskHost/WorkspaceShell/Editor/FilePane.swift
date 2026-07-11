import AppKit

/// The sidebar file tree: a lazy `NSOutlineView` over a `FileNode` root. Mirrors VS
/// Code's explorer — children load only on expand, each row shows the file's icon and
/// name. Single-click selects; double-click (or Enter) calls `onActivate`, which the
/// wiring layer routes through `Dispatch` (slice 3) and later the active tenant drive.
///
/// Git status decoration lands in slice 2; this slice renders the bare tree.
@MainActor
public final class FilePane: NSObject {
    /// Drop this into the sidebar content area.
    public let view: NSView

    /// Fired on double-click / Enter for the activated node. Selection alone does not
    /// fire it (selection vs activation split).
    public var onActivate: ((FileNode) -> Void)?

    private let outline = FirstClickOutlineView()
    private let scroll = NSScrollView()
    private var root: FileNode?
    private var gitStatus = GitStatus.empty
    private var textZoom = WorkspaceTextZoom()

    private static let cellIdentifier = NSUserInterfaceItemIdentifier("FilePaneCell")
    private static let columnIdentifier = NSUserInterfaceItemIdentifier("FilePaneColumn")
    private static let rowIdentifier = NSUserInterfaceItemIdentifier("FilePaneRow")

    public override init() {
        view = scroll
        super.init()

        let column = NSTableColumn(identifier: Self.columnIdentifier)
        column.resizingMask = .autoresizingMask
        outline.addTableColumn(column)
        outline.outlineTableColumn = column
        outline.headerView = nil
        outline.rowSizeStyle = .custom
        outline.rowHeight = textZoom.sidebarRowHeight
        outline.backgroundColor = .clear
        outline.style = .fullWidth  // edge-to-edge selection, not the inset rounded pill
        outline.indentationPerLevel = 14
        outline.autoresizesOutlineColumn = true
        outline.dataSource = self
        outline.delegate = self
        outline.target = self
        outline.action = #selector(activateClickedRow)  // single-click opens (VS Code style)
        outline.onKeyboardActivate = { [weak self] item in
            guard let node = item as? FileNode else { return }
            self?.activateFromAccessibility(node)
        }
        outline.setAccessibilityLabel("Files")
        outline.setAccessibilityIdentifier("file-tree")

        scroll.documentView = outline
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true

        outline.rowHover = RowHoverTracker(table: outline)
    }

    /// Root the tree at `root` and render its contents as the top-level rows (the folder
    /// name itself lives in the sidebar header, not as a row).
    public func show(root: FileNode) {
        self.root = root
        outline.reloadData()
    }

    /// Overlay git decorations on the current tree (file colour + badge, folder colour
    /// propagated from descendants). A separate layer from the tree contents, applied
    /// independently as status reads complete.
    public func applyGitStatus(_ status: GitStatus) {
        gitStatus = status
        outline.reloadData()
    }

    public func setTextZoom(_ zoom: WorkspaceTextZoom) {
        textZoom = zoom
        outline.rowHeight = zoom.sidebarRowHeight
        reloadPreservingState()
        outline.noteHeightOfRows(withIndexesChanged: IndexSet(integersIn: 0..<outline.numberOfRows))
        outline.layoutSubtreeIfNeeded()
        outline.needsDisplay = true
        scroll.needsDisplay = true
        view.needsDisplay = true
    }

    @discardableResult
    public func focus() -> Bool {
        guard let window = outline.window else { return false }
        window.orderFrontRegardless()
        window.makeKey()
        return window.makeFirstResponder(outline)
    }

    /// Reconcile the tree against disk and redraw, preserving which folders are expanded
    /// and the selected row across the reload (the reconcile keeps node identity, so the
    /// outline re-expands the same items). Used by the live watcher on a filesystem change.
    public func refreshPreservingState() {
        guard let root else { return }
        root.reconcile()
        reloadPreservingState()
    }

    private func reloadPreservingState() {
        guard root != nil else {
            outline.reloadData()
            return
        }
        let expanded = (0..<outline.numberOfRows)
            .compactMap { outline.item(atRow: $0) as? FileNode }
            .filter { outline.isItemExpanded($0) }
        let selected = outline.item(atRow: outline.selectedRow) as? FileNode

        outline.reloadData()

        for node in expanded { outline.expandItem(node) }
        if let selected {
            let row = outline.row(forItem: selected)
            if row >= 0 { outline.selectRowIndexes([row], byExtendingSelection: false) }
        }
    }

    /// Drop the workspace root and its decorations, leaving an empty tree (used when the
    /// folder is closed).
    public func clear() {
        root = nil
        gitStatus = .empty
        outline.reloadData()
    }

    func accessibilityRows() -> [ShellAccessibilityFileRow] {
        (0..<outline.numberOfRows).compactMap { row in
            guard let node = outline.item(atRow: row) as? FileNode else { return nil }
            return ShellAccessibilityFileRow(
                url: node.url,
                name: node.name,
                isDirectory: node.isDirectory,
                level: outline.level(forRow: row)
            )
        }
    }

    func performAccessibilityAction(for url: URL) {
        for row in 0..<outline.numberOfRows {
            guard let node = outline.item(atRow: row) as? FileNode, node.url == url else { continue }
            activateFromAccessibility(node)
            return
        }
    }

    @objc private func activateClickedRow() {
        // Single-click action fires for any row, including folders (whose whole-row toggle
        // is handled in mouseDown and swallowed). Only files reach here meaningfully; the
        // wiring guards out directories.
        let row = outline.clickedRow
        guard row >= 0, let node = outline.item(atRow: row) as? FileNode else { return }
        onActivate?(node)
    }
}

// MARK: - Data source (lazy: children read only when a row is expanded)

extension FilePane: NSOutlineViewDataSource {
    public func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int {
        node(for: item)?.children().count ?? 0
    }

    public func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any {
        node(for: item)!.children()[index]
    }

    public func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool {
        (item as? FileNode)?.isDirectory ?? false
    }

    /// The node whose children we list: the root for the top level (`nil` item), else the
    /// node itself.
    private func node(for item: Any?) -> FileNode? {
        item == nil ? root : (item as? FileNode)
    }
}

// MARK: - Delegate (view-based cells: icon + name)

extension FilePane: NSOutlineViewDelegate {
    public func outlineView(_ outlineView: NSOutlineView, rowViewForItem item: Any) -> NSTableRowView? {
        let view = (outlineView.makeView(withIdentifier: Self.rowIdentifier, owner: self) as? HoverRowView) ?? HoverRowView()
        view.identifier = Self.rowIdentifier
        return view
    }

    public func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
        guard let node = item as? FileNode else { return nil }

        let cell = (outlineView.makeView(withIdentifier: Self.cellIdentifier, owner: self) as? FileCell)
            ?? FileCell(identifier: Self.cellIdentifier)

        let decoration = gitStatus.decoration(for: node.url, isDirectory: node.isDirectory)
        cell.configure(node: node, decoration: decoration, textZoom: textZoom) { [weak self] node in
            self?.activateFromAccessibility(node)
        }
        return cell
    }

    private func activateFromAccessibility(_ node: FileNode) {
        _ = focus()
        let row = outline.row(forItem: node)
        if row >= 0 { outline.selectRowIndexes([row], byExtendingSelection: false) }
        if node.isDirectory {
            outline.isItemExpanded(node) ? outline.collapseItem(node) : outline.expandItem(node)
        } else {
            onActivate?(node)
        }
    }
}

/// One sidebar row: file icon, a name tinted by git status, and a trailing one-letter
/// status badge. Folder rows take the propagated colour (their subtree's strongest
/// status) but no letter — the letter would be misleading on a mixed folder.
private final class FileCell: NSTableCellView, RowSelectionTinting {
    private let badge = NSTextField(labelWithString: "")
    private var iconWidthConstraint: NSLayoutConstraint?
    private var iconHeightConstraint: NSLayoutConstraint?
    private var node: FileNode?
    private var decoration: GitFileStatus?
    private var onAccessibilityPress: ((FileNode) -> Void)?

    init(identifier: NSUserInterfaceItemIdentifier) {
        super.init(frame: .zero)
        self.identifier = identifier

        let icon = NSImageView()
        icon.translatesAutoresizingMaskIntoConstraints = false
        addSubview(icon)
        imageView = icon

        let label = NSTextField(labelWithString: "")
        label.font = .systemFont(ofSize: 12)
        label.lineBreakMode = .byTruncatingTail
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        textField = label

        badge.font = .monospacedSystemFont(ofSize: 11, weight: .semibold)
        badge.alignment = .center
        badge.setContentHuggingPriority(.required, for: .horizontal)
        badge.setContentCompressionResistancePriority(.required, for: .horizontal)
        badge.translatesAutoresizingMaskIntoConstraints = false
        addSubview(badge)

        iconWidthConstraint = icon.widthAnchor.constraint(equalToConstant: 16)
        iconHeightConstraint = icon.heightAnchor.constraint(equalToConstant: 16)

        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 2),
            icon.centerYAnchor.constraint(equalTo: centerYAnchor),
            iconWidthConstraint!,
            iconHeightConstraint!,
            label.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 5),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
            badge.leadingAnchor.constraint(greaterThanOrEqualTo: label.trailingAnchor, constant: 4),
            badge.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
            badge.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("FileCell is code-only") }

    func configure(
        node: FileNode,
        decoration: GitFileStatus?,
        textZoom: WorkspaceTextZoom,
        onAccessibilityPress: @escaping (FileNode) -> Void
    ) {
        self.node = node
        self.decoration = decoration
        self.onAccessibilityPress = onAccessibilityPress
        let iconSize = textZoom.sidebarIconPointSize
        iconWidthConstraint?.constant = iconSize
        iconHeightConstraint?.constant = iconSize
        if let icon = FileIcon.image(for: node.url, isDirectory: node.isDirectory)?.copy() as? NSImage {
            icon.size = NSSize(width: iconSize, height: iconSize)
            imageView?.image = icon
        } else {
            imageView?.image = nil
        }
        textField?.stringValue = node.name
        textField?.font = .systemFont(
            ofSize: textZoom.fileTreeLabelPointSize,
            weight: textZoom.step > 0 ? .semibold : .regular
        )
        badge.font = .monospacedSystemFont(ofSize: textZoom.sidebarBadgePointSize, weight: .semibold)
        setAccessibilityIdentifier("file-tree-\(node.url.path)")
        setAccessibilityLabel(node.name)
        setAccessibilityRole(.button)
        setAccessibilityHelp(node.isDirectory ? "Expand or collapse folder" : "Open file")

        // Ignored (incl. anything inside an ignored folder) greys the whole row — icon,
        // name, and no status badge — by dimming the cell, the way VS Code fades ignored
        // entries. Other statuses tint the name and badge it.
        applyStatusColors(isSelected: isRowSelected)
        if let decoration, !node.isDirectory, !ignored {
            badge.stringValue = decoration.badgeLetter  // letter only on files
        } else {
            badge.stringValue = ""
        }
    }

    func rowSelectionDidChange(isSelected: Bool) {
        applyStatusColors(isSelected: isSelected)
    }

    private var isRowSelected: Bool {
        (superview as? NSTableRowView)?.isSelected ?? false
    }

    private var ignored: Bool {
        decoration == .ignored
    }

    private func applyStatusColors(isSelected: Bool) {
        alphaValue = 1
        let tint = isSelected ? decoration?.selectedTint : decoration?.tint
        textField?.textColor = tint ?? .labelColor
        if !ignored {
            badge.textColor = tint
        }
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func accessibilityPerformPress() -> Bool {
        guard let node else { return false }
        onAccessibilityPress?(node)
        return true
    }
}

/// The sidebar lives in a non-activating panel, so the first click would otherwise only
/// focus the panel and be swallowed. Accepting first mouse makes that click select/expand
/// the row directly. Also carries the full-width row hover (`RowHovering`).
private final class FirstClickOutlineView: NSOutlineView, RowHovering {
    var rowHover: RowHoverTracker?
    var hoverArea: NSTrackingArea?
    var onKeyboardActivate: ((Any) -> Void)?

    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func keyDown(with event: NSEvent) {
        if KeyboardActivation.matches(event), selectedRow >= 0, let item = item(atRow: selectedRow) {
            onKeyboardActivate?(item)
            return
        }
        super.keyDown(with: event)
    }

    /// Toggle a folder when its row is clicked anywhere (not only the disclosure triangle),
    /// the way VS Code's explorer does. The chevron still toggles natively (we leave that to
    /// super); file rows fall through to normal selection/activation.
    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        let row = row(at: point)
        if row >= 0, let item = item(atRow: row), isExpandable(item),
           !frameOfOutlineCell(atRow: row).contains(point) {
            selectRowIndexes([row], byExtendingSelection: false)
            // Toggle on every click, not just clickCount == 1: a quick second click on the
            // same row is reported as a double-click and would otherwise be swallowed,
            // making repeated clicks feel dead. We swallow the event either way so AppKit's
            // own double-click-to-toggle can't fight ours.
            isItemExpanded(item) ? collapseItem(item) : expandItem(item)
            return
        }
        super.mouseDown(with: event)
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
        // Clear only when leaving OUR hover area. The table posts mouseExited for its own
        // internal tracking areas too; treating those as "left the list" caused the blink.
        if event.trackingArea == hoverArea { rowHover?.clear() }
    }
}
