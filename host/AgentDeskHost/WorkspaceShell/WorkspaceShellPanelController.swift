import AppKit
import os
import AgentDeskWire

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
    private let logger = Logger(subsystem: Config.logSubsystem, category: "workspace-shell")
    private var panel: NSPanel?
    private let workspaceSwitcher = NSPopUpButton(frame: .zero, pullsDown: false)
    private let outlineView = NSOutlineView()
    /// The active workspace's file tree. Held strongly because `WorkspaceShellFileNode` keeps only a
    /// weak back-reference to its owning tree (to avoid a tree<->node retain cycle); storing just the
    /// rootNode would let the tree deallocate and every `children()` call would silently return empty.
    private var fileTree: WorkspaceShellFileTree?
    private var rootNode: WorkspaceShellFileNode?
    /// The workspace ids in switcher-menu order, so a selection maps back to a workspace.
    private var switcherWorkspaceIDs: [UUID] = []
    /// The active workspace the outline view was last built for, so a store change that doesn't
    /// change the active workspace doesn't collapse the tree's expansion state.
    private var renderedWorkspaceID: UUID?
    private var loadTask: Task<Void, Never>?

    // R22 editor: double-clicking a file opens it here for revision-checked editing.
    private let editorContainer = NSView()
    private let editorTitleLabel = NSTextField(labelWithString: "")
    private let editorSaveButton = NSButton(title: "Save", target: nil, action: nil)
    private let editorStatusLabel = NSTextField(labelWithString: "")
    private let editorTextView = NSTextView()
    private var openFilePath: String?
    private var openFileWorkspaceID: String?
    private var openFileRevision: WorkspaceFileRevision?
    private var isSaving = false

    /// Invoked when the top-bar "Agents" command is tapped. AppDelegate wires this to toggle the
    /// macOS Agents window (R24), keeping the shell panel decoupled from the agent surface.
    var onAgentsCommand: (() -> Void)?

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
            self?.logAXSelfReport()
        }
    }

    /// Logs the shell panel's accessibility-tree state after load, so the macOS shell render is
    /// observable from the host's own os_log (category workspace-shell) without an out-of-process AX
    /// client or screen capture. Reports which of the panel's identified controls are AX-reachable
    /// and the active workspace's file-tree row count.
    private func logAXSelfReport() {
        guard let panel else {
            logger.notice("workspace-shell AX: no panel")
            return
        }
        let ids = axIdentifiers(in: panel.contentView)
        let expected = [
            "workspace-shell-agents",
            "workspace-shell-switcher",
            "workspace-shell-add",
            "workspace-shell-file-tree",
        ]
        let present = expected.filter { ids.contains($0) }
        // Report the authoritative model count from the retained tree (the active workspace's
        // top-level entries), not outlineView.numberOfRows, which reads displayed rows before layout.
        let treeEntries = fileTree?.rootNode.children().count ?? 0
        logger.notice(
            "workspace-shell AX: visible=\(panel.isVisible, privacy: .public) controls=[\(present.joined(separator: ","), privacy: .public)] treeEntries=\(treeEntries, privacy: .public) activeWorkspace=\(self.controller.store.active?.name ?? "none", privacy: .public)"
        )
    }

    private func axIdentifiers(in view: NSView?) -> Set<String> {
        guard let view else { return [] }
        var result: Set<String> = []
        let identifier = view.accessibilityIdentifier()
        if !identifier.isEmpty { result.insert(identifier) }
        for subview in view.subviews {
            result.formUnion(axIdentifiers(in: subview))
        }
        return result
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

        let agentsButton = NSButton(title: "Agents", target: self, action: #selector(agentsTapped))
        agentsButton.setAccessibilityIdentifier("workspace-shell-agents")

        workspaceSwitcher.target = self
        workspaceSwitcher.action = #selector(workspaceSwitched)
        workspaceSwitcher.setAccessibilityIdentifier("workspace-shell-switcher")

        outlineView.setAccessibilityIdentifier("workspace-shell-file-tree")
        outlineView.headerView = nil
        outlineView.rowSizeStyle = .default
        outlineView.dataSource = self
        outlineView.delegate = self
        outlineView.target = self
        outlineView.doubleAction = #selector(openSelectedFile)
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("name"))
        column.title = "Name"
        outlineView.addTableColumn(column)
        outlineView.outlineTableColumn = column
        let scroll = NSScrollView()
        scroll.documentView = outlineView
        scroll.hasVerticalScroller = true

        let stack = NSStackView(views: [agentsButton, workspaceSwitcher, addButton, scroll, buildEditor()])
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

    private func buildEditor() -> NSView {
        editorContainer.isHidden = true
        editorTitleLabel.font = .boldSystemFont(ofSize: 12)
        editorTitleLabel.lineBreakMode = .byTruncatingHead
        editorTitleLabel.setAccessibilityIdentifier("workspace-shell-editor-title")

        editorSaveButton.target = self
        editorSaveButton.action = #selector(saveTapped)
        editorSaveButton.setAccessibilityIdentifier("workspace-shell-editor-save")

        editorStatusLabel.font = .systemFont(ofSize: 10)
        editorStatusLabel.textColor = .secondaryLabelColor

        editorTextView.isEditable = true
        editorTextView.isRichText = false
        editorTextView.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        editorTextView.setAccessibilityIdentifier("workspace-shell-editor-text")
        let editorScroll = NSScrollView()
        editorScroll.documentView = editorTextView
        editorScroll.hasVerticalScroller = true
        editorScroll.translatesAutoresizingMaskIntoConstraints = false

        let header = NSStackView(views: [editorTitleLabel, editorSaveButton])
        header.orientation = .horizontal
        let stack = NSStackView(views: [header, editorStatusLabel, editorScroll])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 4
        stack.translatesAutoresizingMaskIntoConstraints = false
        editorContainer.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: editorContainer.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: editorContainer.trailingAnchor),
            stack.topAnchor.constraint(equalTo: editorContainer.topAnchor),
            stack.bottomAnchor.constraint(equalTo: editorContainer.bottomAnchor),
            editorScroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            editorScroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 160),
        ])
        return editorContainer
    }

    private func closeEditor() {
        openFilePath = nil
        openFileWorkspaceID = nil
        openFileRevision = nil
        editorContainer.isHidden = true
        editorTextView.string = ""
    }

    @objc private func openSelectedFile() {
        let row = outlineView.clickedRow
        guard row >= 0,
              let node = outlineView.item(atRow: row) as? WorkspaceShellFileNode,
              !node.isDirectory,
              let workspaceID = controller.store.active?.id.uuidString
        else { return }
        let path = node.relativePath.value
        openFilePath = path
        openFileWorkspaceID = workspaceID
        openFileRevision = nil
        editorTitleLabel.stringValue = node.name
        editorStatusLabel.stringValue = "Loading…"
        editorTextView.string = ""
        editorContainer.isHidden = false
        Task { [weak self] in
            guard let self else { return }
            let response = await self.controller.readFile(workspaceID: workspaceID, path: path)
            guard self.openFilePath == path else { return } // a newer open superseded this read
            switch response {
            case .read(_, let result):
                self.editorTextView.string = result.text
                self.openFileRevision = result.revision
                self.editorStatusLabel.stringValue = ""
            case .error(_, let error):
                self.editorStatusLabel.stringValue = error.message ?? "Could not open the file."
            case .workspaces, .directory, .write, .conflict:
                self.editorStatusLabel.stringValue = "Unexpected response opening the file."
            }
        }
    }

    @objc private func saveTapped() {
        guard !isSaving,
              let path = openFilePath,
              let workspaceID = openFileWorkspaceID,
              let revision = openFileRevision
        else { return }
        isSaving = true
        editorSaveButton.isEnabled = false
        editorStatusLabel.stringValue = "Saving…"
        let text = editorTextView.string
        Task { [weak self] in
            guard let self else { return }
            let response = await self.controller.writeFile(
                workspaceID: workspaceID, path: path, expectedRevision: revision, text: text
            )
            self.isSaving = false
            self.editorSaveButton.isEnabled = true
            guard self.openFilePath == path else { return } // the user moved on to another file
            switch response {
            case .write(_, let result):
                self.openFileRevision = result.revision
                self.editorStatusLabel.stringValue = "Saved."
            case .conflict:
                self.editorStatusLabel.stringValue = "This file changed on disk. Your edits were not saved."
            case .error(_, let error):
                self.editorStatusLabel.stringValue = error.message ?? "Save failed."
            case .workspaces, .directory, .read:
                self.editorStatusLabel.stringValue = "Unexpected response saving the file."
            }
        }
    }

    private func refresh() {
        let workspaces = controller.store.workspaces
        switcherWorkspaceIDs = workspaces.map(\.id)
        workspaceSwitcher.removeAllItems()
        if workspaces.isEmpty {
            workspaceSwitcher.addItem(withTitle: "No workspace")
            workspaceSwitcher.isEnabled = false
        } else {
            workspaceSwitcher.isEnabled = true
            for workspace in workspaces {
                workspaceSwitcher.addItem(withTitle: workspace.name)
            }
            if let activeID = controller.store.active?.id,
               let index = switcherWorkspaceIDs.firstIndex(of: activeID) {
                workspaceSwitcher.selectItem(at: index)
            }
        }

        // Rebuild the tree (discarding expansion state) only when the active workspace actually
        // changes; adding a sibling or re-selecting the same one leaves it intact.
        let activeID = controller.store.active?.id
        guard activeID != renderedWorkspaceID else { return }
        renderedWorkspaceID = activeID
        closeEditor() // the open file belongs to the previous workspace
        fileTree = controller.activeFileTree()
        rootNode = fileTree?.rootNode
        outlineView.reloadData()
    }

    @objc private func workspaceSwitched() {
        let index = workspaceSwitcher.indexOfSelectedItem
        guard index >= 0, index < switcherWorkspaceIDs.count else { return }
        let id = switcherWorkspaceIDs[index]
        guard id != controller.store.active?.id else { return }
        Task { [weak self] in
            do {
                try await self?.controller.selectWorkspace(id)
            } catch {
                self?.presentFailure("Could not switch workspace", error)
            }
        }
    }

    @objc private func agentsTapped() {
        onAgentsCommand?()
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
                self?.presentFailure("Could not add workspace", error)
            }
        }
    }

    /// Surfaces a store error (e.g. the chosen path is a symlink or not a directory) rather than
    /// silently dropping it.
    private func presentFailure(_ title: String, _ error: Error) {
        let alert = NSAlert()
        alert.messageText = title
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
