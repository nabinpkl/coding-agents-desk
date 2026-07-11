import AppKit

/// The persistent workspace list at the top of the sidebar (Slack-rail / activity-bar
/// style): one row per workspace, active highlighted, `+` to add. Clicks emit `onSelect`;
/// the wiring routes them to `WorkspaceShellSession.switchTo`. Ported verbatim from the
/// agent-workspace-ide donor so the sidebar keeps the same UI/UX: each row carries its
/// desktop badge, a hover assign-desktop `⌖`, an auto-assign `A` toggle, a hover close `×`,
/// and drag-to-reorder. `@MainActor` for the host's strict-concurrency target (the donor
/// built in Swift-5 language mode); the behavior is unchanged.
@MainActor
public final class WorkspaceSwitcher: NSObject {
    /// A vertical stack; install it into the sidebar's switcher area.
    public let view: NSView

    public var onSelect: ((UUID) -> Void)?
    public var onAdd: (() -> Void)?
    public var onRemove: ((UUID) -> Void)?
    public var onAssignDesktop: ((UUID) -> Void)?
    public var onSetDesktopAutoAssign: ((UUID, Bool) -> Void)?
    /// Fired after a drag-reorder settles, with the new top-to-bottom workspace order.
    public var onReorder: (([UUID]) -> Void)?

    private let stack = NSStackView()
    private var textZoom = WorkspaceTextZoom()

    public override init() {
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 3
        stack.edgeInsets = NSEdgeInsets(top: 6, left: 0, bottom: 6, right: 0)
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.setAccessibilityLabel("Workspaces")
        stack.setAccessibilityIdentifier("workspace-switcher")
        view = stack
        super.init()
    }

    /// Rebuild the list. Cheap — v0 caps the live set at ~3 workspaces.
    public func render(workspaces: [Workspace], activeID: UUID?) {
        stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        add(makeHeader())
        if workspaces.isEmpty {
            add(makeEmptyState())
        } else {
            for workspace in workspaces {
                addRow(makeRow(workspace, isActive: workspace.id == activeID))
            }
        }
    }

    public func setActiveWorkspace(_ activeID: UUID?) {
        for row in stack.arrangedSubviews.compactMap({ $0 as? WorkspaceRowButton }) {
            row.applyActive(row.workspaceID == activeID, textZoom: textZoom)
        }
    }

    public func renderedWorkspaceIDs() -> [UUID] {
        stack.arrangedSubviews.compactMap { ($0 as? WorkspaceRowButton)?.workspaceID }
    }

    public func setTextZoom(_ zoom: WorkspaceTextZoom) {
        textZoom = zoom
    }

    /// Add an inset element (header, empty state) with a left/right margin. The width
    /// constraint is activated only after the view is in the hierarchy (a common ancestor
    /// exists).
    private func add(_ row: NSView) {
        stack.addArrangedSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: stack.leadingAnchor, constant: 10),
            row.trailingAnchor.constraint(equalTo: stack.trailingAnchor, constant: -10),
        ])
    }

    /// Add a workspace row pinned edge to edge, so its hover/active highlight bleeds the
    /// full sidebar width (the row's own cell pads the content). Matches the file tree's
    /// full-width row highlight.
    private func addRow(_ row: NSView) {
        stack.addArrangedSubview(row)
        pinRowFullWidth(row)
    }

    /// Pin a row to the stack's full width. Re-applied when a row is re-inserted mid-drag
    /// (leaving the superview drops its width constraints).
    private func pinRowFullWidth(_ row: NSView) {
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: stack.leadingAnchor),
            row.trailingAnchor.constraint(equalTo: stack.trailingAnchor),
        ])
    }

    // MARK: - Drag reorder

    /// Live-reorder during a drag: move the dragged row to the slot the pointer is over, so
    /// the rows shuffle under the cursor. Vertical stacks lay the first arranged subview at
    /// the top (highest y), so a higher pointer y means a lower index.
    fileprivate func dragMoved(_ button: WorkspaceRowButton, toWindowPoint windowPoint: NSPoint) {
        let rows = stack.arrangedSubviews.compactMap { $0 as? WorkspaceRowButton }
        guard let from = rows.firstIndex(of: button) else { return }
        let point = stack.convert(windowPoint, from: nil)
        var target = rows.count - 1
        for (index, row) in rows.enumerated() where point.y > row.frame.midY {
            target = index
            break
        }
        guard target != from else { return }
        let headerCount = stack.arrangedSubviews.count - rows.count  // header sits before the rows
        stack.removeArrangedSubview(button)
        button.removeFromSuperview()
        stack.insertArrangedSubview(button, at: headerCount + target)
        pinRowFullWidth(button)
        stack.layoutSubtreeIfNeeded()
    }

    /// A drag settled: emit the new top-to-bottom order.
    fileprivate func dragCommitted() {
        let ids = stack.arrangedSubviews.compactMap { ($0 as? WorkspaceRowButton)?.workspaceID }
        onReorder?(ids)
    }

    // MARK: - Rows

    private func makeHeader() -> NSView {
        let row = NSStackView()
        row.orientation = .horizontal
        row.translatesAutoresizingMaskIntoConstraints = false

        let label = NSTextField(labelWithString: "WORKSPACES")
        label.font = .systemFont(ofSize: max(10, 11 + CGFloat(textZoom.step)), weight: .semibold)
        label.textColor = .secondaryLabelColor
        label.lineBreakMode = .byTruncatingTail
        label.maximumNumberOfLines = 1
        label.setContentHuggingPriority(.defaultLow, for: .horizontal)
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        // Plain "+" glyph rather than an SF-symbol image button, which renders nearly
        // invisible as a borderless image-only control.
        let add = HoverButton(title: "＋", target: self, action: #selector(addClicked))
        add.isBordered = false
        add.cornerRadius = 4
        add.horizontalPadding = 5
        add.font = .systemFont(ofSize: max(12, 15 + CGFloat(textZoom.step)), weight: .medium)
        add.toolTip = "Add Workspace"
        add.setAccessibilityIdentifier("add-workspace")
        add.setAccessibilityLabel("Add Workspace")
        add.setAccessibilityHelp("Choose a folder to add as a workspace")
        add.setContentHuggingPriority(.required, for: .horizontal)
        add.setContentCompressionResistancePriority(.required, for: .horizontal)

        row.addArrangedSubview(label)
        row.addArrangedSubview(NSView())  // spacer
        row.addArrangedSubview(add)
        return row
    }

    /// Shown when no workspaces exist: an unmistakable button to add the first one.
    private func makeEmptyState() -> NSView {
        let button = HoverButton.chip(title: "＋ Add Workspace", target: self, action: #selector(addClicked))
        button.font = .systemFont(ofSize: textZoom.sidebarLabelPointSize, weight: .medium)
        button.setAccessibilityIdentifier("add-first-workspace")
        button.setAccessibilityLabel("Add Workspace")
        button.setAccessibilityHelp("Choose the first workspace folder")
        return button
    }

    private func makeRow(_ workspace: Workspace, isActive: Bool) -> NSView {
        let button = WorkspaceRowButton(
            workspaceID: workspace.id,
            desktopAssignment: workspace.desktopAssignment,
            desktopAutoAssignEnabled: workspace.desktopAutoAssignEnabled
        )
        button.title = workspace.name
        button.image = NSWorkspace.shared.icon(forFile: workspace.root.path)
        button.image?.size = NSSize(width: 16, height: 16)
        button.imagePosition = .imageLeft
        button.imageHugsTitle = true
        button.alignment = .left
        button.isBordered = false
        button.translatesAutoresizingMaskIntoConstraints = false
        button.reserveTrailingContentWidth(116)
        button.setAccessibilityIdentifier("workspace-\(workspace.id.uuidString)")
        button.setAccessibilityLabel(workspace.name)
        button.setAccessibilityHelp("Switch to workspace \(workspace.name)")
        // A row handles its own mouse: a plain click selects, a vertical drag reorders.
        button.onPick = { [weak self] id in self?.onSelect?(id) }
        button.onReorderDrag = { [weak self] dragged, point in self?.dragMoved(dragged, toWindowPoint: point) }
        button.onReorderCommit = { [weak self] in self?.dragCommitted() }
        button.applyActive(isActive, textZoom: textZoom)

        let desktopBadge = DesktopAssignmentBadge(assignment: workspace.desktopAssignment, active: isActive)
        let controls = NSStackView()
        controls.orientation = .horizontal
        controls.alignment = .centerY
        controls.spacing = 4
        controls.translatesAutoresizingMaskIntoConstraints = false
        button.addSubview(controls)

        // A remove "×" that appears on hover (VS Code style). It's a subview of the row, so
        // it intercepts its own clicks while the rest of the row still selects; on hover of
        // the row it reveals, and removeClicked reads the id off its parent row.
        let assign = HoverButton(title: "⌖", target: self, action: #selector(assignDesktopClicked(_:)))
        assign.isBordered = false
        assign.cornerRadius = 4
        assign.horizontalPadding = 3
        assign.font = .systemFont(ofSize: max(10, 13 + CGFloat(textZoom.step)), weight: .medium)
        assign.contentTintColor = isActive ? AppTheme.onAccent : .secondaryLabelColor
        assign.toolTip = workspace.desktopAssignment == nil ? "Assign to Current Desktop" : "Reassign to Current Desktop"
        assign.setAccessibilityIdentifier("assign-workspace-desktop-\(workspace.id.uuidString)")
        assign.setAccessibilityLabel("Assign workspace \(workspace.name) to current desktop")
        assign.setAccessibilityHelp("Bind this workspace to the active macOS desktop")
        assign.isHidden = workspace.desktopAutoAssignEnabled || workspace.desktopAssignment != nil
        assign.translatesAutoresizingMaskIntoConstraints = false

        let autoAssign = HoverButton(title: "A", target: self, action: #selector(autoAssignClicked(_:)))
        autoAssign.setButtonType(.pushOnPushOff)
        autoAssign.state = workspace.desktopAutoAssignEnabled ? .on : .off
        autoAssign.isBordered = false
        autoAssign.cornerRadius = 4
        autoAssign.horizontalPadding = 4
        autoAssign.font = .systemFont(ofSize: max(10, 12 + CGFloat(textZoom.step)), weight: .semibold)
        autoAssign.contentTintColor = workspace.desktopAutoAssignEnabled ? AppTheme.onAccent : (isActive ? AppTheme.onAccent : .secondaryLabelColor)
        autoAssign.restingColor = workspace.desktopAutoAssignEnabled ? AppTheme.activeFill : .clear
        autoAssign.hoverColor = workspace.desktopAutoAssignEnabled ? AppTheme.activeHoverFill : HoverButton.subtleFill
        autoAssign.toolTip = workspace.desktopAutoAssignEnabled ? "Auto Assign On" : "Auto Assign"
        autoAssign.setAccessibilityIdentifier("auto-assign-workspace-desktop-\(workspace.id.uuidString)")
        autoAssign.setAccessibilityLabel("Auto assign workspace \(workspace.name) desktop")
        autoAssign.setAccessibilityValue(workspace.desktopAutoAssignEnabled ? "selected" : "not selected")
        autoAssign.setAccessibilityHelp("Automatically repair this workspace's desktop assignment from window evidence")
        autoAssign.translatesAutoresizingMaskIntoConstraints = false

        let close = HoverButton(title: "×", target: self, action: #selector(removeClicked(_:)))
        close.isBordered = false
        close.cornerRadius = 4
        close.horizontalPadding = 3
        close.font = .systemFont(ofSize: max(11, 14 + CGFloat(textZoom.step)), weight: .medium)
        close.contentTintColor = isActive ? AppTheme.onAccent : .secondaryLabelColor
        close.toolTip = "Remove Workspace"
        close.setAccessibilityIdentifier("remove-workspace-\(workspace.id.uuidString)")
        close.setAccessibilityLabel("Remove workspace \(workspace.name)")
        close.setAccessibilityHelp("Close this workspace")
        close.isHidden = true
        close.translatesAutoresizingMaskIntoConstraints = false
        controls.addArrangedSubview(desktopBadge)
        controls.addArrangedSubview(assign)
        controls.addArrangedSubview(autoAssign)
        controls.addArrangedSubview(close)
        NSLayoutConstraint.activate([
            desktopBadge.widthAnchor.constraint(greaterThanOrEqualToConstant: 28),
            desktopBadge.heightAnchor.constraint(equalToConstant: 17),
            controls.trailingAnchor.constraint(equalTo: button.trailingAnchor, constant: -6),
            controls.centerYAnchor.constraint(equalTo: button.centerYAnchor),
        ])
        button.onHoverChange = { [weak close, weak assign] hovering in
            close?.isHidden = !hovering
            assign?.isHidden = workspace.desktopAutoAssignEnabled || (workspace.desktopAssignment != nil && !hovering)
        }
        return button
    }

    @objc private func addClicked() { onAdd?() }
    @objc private func assignDesktopClicked(_ sender: NSButton) {
        guard let id = workspaceRow(for: sender)?.workspaceID else { return }
        onAssignDesktop?(id)
    }
    @objc private func autoAssignClicked(_ sender: NSButton) {
        guard let id = workspaceRow(for: sender)?.workspaceID else { return }
        onSetDesktopAutoAssign?(id, sender.state == .on)
    }
    @objc private func removeClicked(_ sender: NSButton) {
        guard let id = workspaceRow(for: sender)?.workspaceID else { return }
        onRemove?(id)
    }

    private func workspaceRow(for view: NSView) -> WorkspaceRowButton? {
        var current: NSView? = view
        while let candidate = current {
            if let row = candidate as? WorkspaceRowButton { return row }
            current = candidate.superview
        }
        return nil
    }
}

/// A workspace row button carrying its workspace id. The active row keeps a standing
/// highlight; every row gets the shared hover wash on top (a hovered active row reads a
/// little stronger). Inherits `acceptsFirstMouse` from `HoverButton` so a click registers
/// inside the non-activating sidebar panel without a focusing pre-click.
private final class WorkspaceRowButton: HoverButton {
    let workspaceID: UUID
    let desktopAssignment: WorkspaceDesktopAssignment?
    let desktopAutoAssignEnabled: Bool

    /// A plain click (no drag) selects this workspace.
    var onPick: ((UUID) -> Void)?
    /// A vertical drag past threshold: called per move with the pointer in window coords.
    var onReorderDrag: ((WorkspaceRowButton, NSPoint) -> Void)?
    /// The drag released: commit the new order.
    var onReorderCommit: (() -> Void)?

    /// Points the pointer must move before a press becomes a drag rather than a click.
    private static let dragThreshold: CGFloat = 4

    init(
        workspaceID: UUID,
        desktopAssignment: WorkspaceDesktopAssignment?,
        desktopAutoAssignEnabled: Bool
    ) {
        self.workspaceID = workspaceID
        self.desktopAssignment = desktopAssignment
        self.desktopAutoAssignEnabled = desktopAutoAssignEnabled
        super.init(frame: .zero)
        cornerRadius = 0  // full-bleed row highlight, not a rounded pill
        cell = LeftPaddedButtonCell(leftPadding: 10)  // keep content padded though
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func setActiveHighlight(_ active: Bool) {
        restingColor = active ? AppTheme.activeFill : .clear
        hoverColor = active ? AppTheme.activeHoverFill : HoverButton.subtleFill
    }

    func applyActive(_ active: Bool, textZoom: WorkspaceTextZoom) {
        font = .systemFont(ofSize: textZoom.sidebarLabelPointSize, weight: active ? .semibold : .regular)
        contentTintColor = active ? AppTheme.onAccent : .labelColor
        setActiveHighlight(active)
        setAccessibilitySelected(active)
        setAccessibilityValue(rowAccessibilityValue(isActive: active))
        descendants(of: self, as: DesktopAssignmentBadge.self).forEach { $0.setActive(active) }
        for button in descendants(of: self, as: NSButton.self) where button !== self {
            let autoAssignSelected = button.accessibilityIdentifier().hasPrefix("auto-assign-workspace-desktop-") && desktopAutoAssignEnabled
            button.contentTintColor = autoAssignSelected || active ? AppTheme.onAccent : .secondaryLabelColor
        }
    }

    func reserveTrailingContentWidth(_ width: CGFloat) {
        (cell as? LeftPaddedButtonCell)?.rightPadding = width
    }

    /// Own the mouse instead of `NSButton`'s tracking loop so a press can become either a
    /// click (select) or a drag (reorder). We pull events ourselves: cross the threshold and
    /// it's a reorder drag (live-moving the row); release without crossing and it's a click.
    /// The trailing × is a subview, so clicks on it are hit-tested to it, not here.
    override func mouseDown(with event: NSEvent) {
        guard let window, onReorderDrag != nil else { super.mouseDown(with: event); return }
        let start = event.locationInWindow
        var dragging = false
        loop: while let next = window.nextEvent(
            matching: [.leftMouseDragged, .leftMouseUp],
            until: .distantFuture,
            inMode: .eventTracking,
            dequeue: true
        ) {
            switch next.type {
            case .leftMouseUp:
                break loop
            case .leftMouseDragged:
                if !dragging, abs(next.locationInWindow.y - start.y) > Self.dragThreshold {
                    dragging = true
                    alphaValue = 0.7  // lift the row while it's being dragged
                }
                if dragging { onReorderDrag?(self, next.locationInWindow) }
            default:
                break
            }
        }
        if dragging {
            alphaValue = 1
            onReorderCommit?()
        } else {
            onPick?(workspaceID)
        }
    }

    override func accessibilityPerformPress() -> Bool {
        onPick?(workspaceID)
        return true
    }

    private func rowAccessibilityValue(isActive: Bool) -> String {
        let active = isActive ? "active" : "inactive"
        let desktop = desktopAssignment.map { "desktop \($0.ordinal)" } ?? "unassigned desktop"
        return "\(active), \(desktop)"
    }

    private func descendants<T: NSView>(of root: NSView, as type: T.Type) -> [T] {
        var matches: [T] = []
        if let root = root as? T {
            matches.append(root)
        }
        for subview in root.subviews {
            matches.append(contentsOf: descendants(of: subview, as: type))
        }
        return matches
    }
}

private final class DesktopAssignmentBadge: NSTextField {
    private var active: Bool

    init(assignment: WorkspaceDesktopAssignment?, active: Bool) {
        self.active = active
        super.init(frame: .zero)
        stringValue = assignment.map { "D\($0.ordinal)" } ?? "D-"
        font = .systemFont(ofSize: 10, weight: .semibold)
        alignment = .center
        isEditable = false
        isSelectable = false
        isBordered = false
        drawsBackground = false
        wantsLayer = true
        layer?.cornerRadius = 4
        setAccessibilityIdentifier("workspace-desktop-status")
        setAccessibilityLabel("Workspace desktop assignment")
        setAccessibilityValue(assignment.map { "desktop \($0.ordinal)" } ?? "unassigned")
        setContentHuggingPriority(.required, for: .horizontal)
        setContentCompressionResistancePriority(.required, for: .horizontal)
        applyStyle()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyStyle()
    }

    func setActive(_ active: Bool) {
        guard self.active != active else { return }
        self.active = active
        applyStyle()
    }

    private func applyStyle() {
        textColor = active ? AppTheme.onAccent : .secondaryLabelColor
        effectiveAppearance.performAsCurrentDrawingAppearance {
            layer?.backgroundColor = DesktopAssignmentBadge.background(active: active).cgColor
        }
    }

    private static func background(active: Bool) -> NSColor {
        if active {
            return NSColor.white.withAlphaComponent(0.18)
        }
        return NSColor(name: nil) { appearance in
            let dark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            return NSColor(white: dark ? 1 : 0, alpha: dark ? 0.11 : 0.07)
        }
    }
}

/// A button cell that insets its content (icon + title) from the left while the button's
/// layer background still fills the full width — so a full-bleed row highlight keeps a
/// padded label.
private final class LeftPaddedButtonCell: NSButtonCell {
    private let leftPadding: CGFloat
    var rightPadding: CGFloat = 0

    init(leftPadding: CGFloat) {
        self.leftPadding = leftPadding
        super.init(textCell: "")
    }

    @available(*, unavailable)
    required init(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func drawingRect(forBounds rect: NSRect) -> NSRect {
        var inset = super.drawingRect(forBounds: rect)
        inset.origin.x += leftPadding
        inset.size.width -= leftPadding + rightPadding
        return inset
    }
}
