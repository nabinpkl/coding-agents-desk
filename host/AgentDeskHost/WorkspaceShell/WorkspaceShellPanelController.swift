import AppKit

/// A key-able panel that can host text editing without the app leaving `LSUIElement`: the app is
/// never activated (nonactivating), so the menu bar stays with the frontmost app, but the panel can
/// still become key so the file tree and (later) the editor receive input.
private final class WorkspaceShellPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

/// The macOS workspace shell (R20/R23): a sidebar panel showing the active workspace and its
/// root-scoped file tree, with an Add-Workspace control that registers a new root through the
/// `WorkspaceShellController`. It renders from the controller and never owns store state itself.
@MainActor
final class WorkspaceShellPanelController: NSObject {
    private let controller: WorkspaceShellController
    private var panel: NSPanel?
    private let workspaceLabel = NSTextField(labelWithString: "No workspace")
    private let outlineView = NSOutlineView()
    private var rootNode: WorkspaceShellFileNode?
    /// The active workspace the outline view was last built for, so a store change that doesn't
    /// change the active workspace doesn't collapse the tree's expansion state.
    private var renderedWorkspaceID: UUID?
    private var loadTask: Task<Void, Never>?

    init(controller: WorkspaceShellController) {
        self.controller = controller
        super.init()
        controller.onChange = { [weak self] in self?.refresh() }
    }

    func show() {
        if panel == nil { buildPanel() }
        panel?.orderFrontRegardless()
        loadTask = Task { [weak self] in
            try? await self?.controller.load()
            self?.refresh()
        }
    }

    func stop() {
        loadTask?.cancel()
        loadTask = nil
        controller.onChange = nil
        panel?.orderOut(nil)
        panel = nil
    }

    private func buildPanel() {
        let panel = WorkspaceShellPanel(
            contentRect: NSRect(x: 0, y: 0, width: 320, height: 480),
            styleMask: [.titled, .closable, .resizable, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        // A normal utility window, not an always-on-top HUD: the user focuses it to work in the
        // workspace, and it may be covered when another app is frontmost. `.nonactivatingPanel` +
        // canBecomeKey keep it key-able for editing without the LSUIElement app ever activating.
        panel.title = "Workspace"
        panel.level = .normal
        panel.hidesOnDeactivate = false

        let addButton = NSButton(title: "Add Workspace…", target: self, action: #selector(addWorkspaceTapped))
        addButton.setAccessibilityIdentifier("workspace-shell-add")

        workspaceLabel.font = .boldSystemFont(ofSize: 13)
        workspaceLabel.setAccessibilityIdentifier("workspace-shell-title")

        outlineView.setAccessibilityIdentifier("workspace-shell-file-tree")
        outlineView.headerView = nil
        outlineView.rowSizeStyle = .default
        outlineView.dataSource = self
        outlineView.delegate = self
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("name"))
        column.title = "Name"
        outlineView.addTableColumn(column)
        outlineView.outlineTableColumn = column
        let scroll = NSScrollView()
        scroll.documentView = outlineView
        scroll.hasVerticalScroller = true

        let stack = NSStackView(views: [workspaceLabel, addButton, scroll])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.edgeInsets = NSEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
        stack.translatesAutoresizingMaskIntoConstraints = false
        scroll.translatesAutoresizingMaskIntoConstraints = false

        let content = NSView()
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            stack.topAnchor.constraint(equalTo: content.topAnchor),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 320),
        ])
        panel.contentView = content
        self.panel = panel
    }

    private func refresh() {
        workspaceLabel.stringValue = controller.store.active?.name ?? "No workspace"
        // Rebuild the tree (discarding expansion state) only when the active workspace actually
        // changes; other store changes just refresh the label.
        let activeID = controller.store.active?.id
        guard activeID != renderedWorkspaceID else { return }
        renderedWorkspaceID = activeID
        rootNode = controller.activeFileTree()?.rootNode
        outlineView.reloadData()
    }

    @objc private func addWorkspaceTapped() {
        let open = NSOpenPanel()
        open.canChooseDirectories = true
        open.canChooseFiles = false
        open.allowsMultipleSelection = false
        open.prompt = "Add"
        guard open.runModal() == .OK, let url = open.url else { return }
        Task { [weak self] in
            do {
                try await self?.controller.addWorkspace(root: url)
            } catch {
                self?.presentAddFailure(error)
            }
        }
    }

    /// Surfaces a registration failure (e.g. the chosen path is a symlink or not a directory) rather
    /// than silently dropping it.
    private func presentAddFailure(_ error: Error) {
        let alert = NSAlert()
        alert.messageText = "Could not add workspace"
        alert.informativeText = String(describing: error)
        alert.alertStyle = .warning
        if let window = panel {
            alert.beginSheetModal(for: window, completionHandler: nil)
        } else {
            alert.runModal()
        }
    }
}

extension WorkspaceShellPanelController: NSOutlineViewDataSource, NSOutlineViewDelegate {
    private func node(for item: Any?) -> WorkspaceShellFileNode? {
        item as? WorkspaceShellFileNode ?? rootNode
    }

    func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int {
        node(for: item)?.children().count ?? 0
    }

    func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any {
        node(for: item)?.children()[index] as Any
    }

    func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool {
        (item as? WorkspaceShellFileNode)?.isDirectory ?? false
    }

    func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
        guard let node = item as? WorkspaceShellFileNode else { return nil }
        let identifier = NSUserInterfaceItemIdentifier("cell")
        let cell = (outlineView.makeView(withIdentifier: identifier, owner: self) as? NSTableCellView) ?? {
            let cell = NSTableCellView()
            let text = NSTextField(labelWithString: "")
            text.translatesAutoresizingMaskIntoConstraints = false
            cell.addSubview(text)
            cell.textField = text
            NSLayoutConstraint.activate([
                text.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 2),
                text.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
            ])
            cell.identifier = identifier
            return cell
        }()
        cell.textField?.stringValue = node.name
        cell.setAccessibilityIdentifier("workspace-shell-entry-\(node.name)")
        return cell
    }
}
