import AppKit
import CoreGraphics
import os
import AgentDeskWire

/// Presents the macOS workspace shell as the donor's reveal-on-hover chrome (ADR-0054): a left-edge
/// sidebar (workspace switcher + file tree + editor) and a minimal top bar (Agents + pin), both
/// floating all-Spaces overlays that auto-hide like the Dock and slide in on an edge hover. Replaces
/// the earlier Space-pinned titled panel.
///
/// It renders from `WorkspaceShellController` (store + file tree + read/write) and drives the pure
/// `WorkspaceShellEdgeRevealController` from a `WorkspaceShellPointerTap`. When Input Monitoring is
/// unavailable the tap cannot run, so it degrades to pinning both bars visible rather than leaving a
/// dead, unreachable shell.
@MainActor
final class WorkspaceShellPresenter: NSObject {
    private let controller: WorkspaceShellController
    private let logger = Logger(subsystem: Config.logSubsystem, category: "workspace-shell")

    private let overlay = WorkspaceShellOverlay()
    private var edgeReveal: WorkspaceShellEdgeRevealController!
    private var pointerTap: WorkspaceShellPointerTap?
    private var inputMonitoringGranted = false
    private var userPinned = false
    private var screenObserver: NSObjectProtocol?

    private let workspaceSwitcher = NSPopUpButton(frame: .zero, pullsDown: false)
    private let outlineView = NSOutlineView()
    /// The active workspace's file tree. Held strongly because `WorkspaceShellFileNode` keeps only a
    /// weak back-reference to its owning tree; storing just the rootNode would let the tree deallocate
    /// and every `children()` call would silently return empty.
    private var fileTree: WorkspaceShellFileTree?
    private var rootNode: WorkspaceShellFileNode?
    private var switcherWorkspaceIDs: [UUID] = []
    private var renderedWorkspaceID: UUID?
    private var loadTask: Task<Void, Never>?

    // Editor: double-clicking a file opens it for revision-checked editing.
    private let editorContainer = NSView()
    private let editorTitleLabel = NSTextField(labelWithString: "")
    private let editorSaveButton = NSButton(title: "Save", target: nil, action: nil)
    private let editorStatusLabel = NSTextField(labelWithString: "")
    private let editorTextView = NSTextView()
    private var openFilePath: String?
    private var openFileWorkspaceID: String?
    private var openFileRevision: WorkspaceFileRevision?
    private var isSaving = false

    private let pinButton = NSButton(title: "Pin", target: nil, action: nil)

    /// Invoked when the top-bar Agents command is tapped. AppDelegate wires this to toggle the macOS
    /// Agents window, keeping the shell decoupled from the agent surface.
    var onAgentsCommand: (() -> Void)?

    init(controller: WorkspaceShellController) {
        self.controller = controller
        super.init()
        controller.onChange = { [weak self] in self?.refresh() }
    }

    func show() {
        buildContent()
        edgeReveal = WorkspaceShellEdgeRevealController(apply: { [weak self] state in
            self?.overlay.setReveal(state.revealed)
        })
        overlay.show()
        relayout()
        startPointerTapOrDegrade()
        observeScreenChanges()

        loadTask = Task { [weak self] in
            try? await self?.controller.load()
            self?.refresh()
            self?.logAXSelfReport()
        }
    }

    func stop() {
        loadTask?.cancel()
        loadTask = nil
        controller.onChange = nil
        pointerTap?.stop()
        pointerTap = nil
        if let screenObserver {
            NotificationCenter.default.removeObserver(screenObserver)
            self.screenObserver = nil
        }
        overlay.stop()
    }

    // MARK: - Reveal wiring

    /// Starts the pointer tap when Input Monitoring is granted and the tap can be created; otherwise
    /// degrades to pinned bars and prompts for the grant so a later launch gets the hover reveal.
    private func startPointerTapOrDegrade() {
        if CGPreflightListenEventAccess() {
            let tap = WorkspaceShellPointerTap(onPointer: { [weak self] quartz in self?.enqueuePointer(quartz) })
            if tap.start() {
                pointerTap = tap
                inputMonitoringGranted = true
                logger.notice("workspace-shell reveal: pointer tap started (Input Monitoring granted)")
                updateConfiguration()
                return
            }
        }
        inputMonitoringGranted = false
        logger.notice("workspace-shell reveal: Input Monitoring absent; degrading to pinned bars")
        _ = CGRequestListenEventAccess() // prompt so a later launch gets hover reveal
        updateConfiguration()
    }

    /// The tap fires pointer movement at high frequency on its own thread. Coalesce it: keep only the
    /// latest point and schedule at most one main-actor drain per burst, so a stream of motion is one
    /// hop rather than one Task per event. `pointerLock` guards the two fields against the tap thread.
    private let pointerLock = NSLock()
    nonisolated(unsafe) private var pendingPointerQuartz: CGPoint?
    nonisolated(unsafe) private var pointerDrainScheduled = false

    nonisolated private func enqueuePointer(_ quartz: CGPoint) {
        pointerLock.lock()
        pendingPointerQuartz = quartz
        let schedule = !pointerDrainScheduled
        pointerDrainScheduled = true
        pointerLock.unlock()
        guard schedule else { return }
        Task { @MainActor [weak self] in self?.drainPointer() }
    }

    private func drainPointer() {
        pointerLock.lock()
        let quartz = pendingPointerQuartz
        pendingPointerQuartz = nil
        pointerDrainScheduled = false
        pointerLock.unlock()
        guard let quartz else { return }
        let point = WorkspaceShellPointerTap.appKitPoint(quartz: quartz)
        let inside = Set(WorkspaceShellSurface.allCases.filter { overlay.containsSurface($0, point: point) })
        edgeReveal.pointerMoved(to: point, insideSurfaces: inside)
    }

    /// Pins both bars when the user pinned them or when Input Monitoring is unavailable (the degrade
    /// path). Otherwise no surface is pinned and reveal is purely pointer-driven.
    private func updateConfiguration() {
        let pinned: Set<WorkspaceShellSurface> =
            (userPinned || !inputMonitoringGranted) ? [.sidebar, .topBar] : []
        edgeReveal.setConfiguration(WorkspaceShellRevealConfiguration(pinned: pinned, held: []))
    }

    private func relayout() {
        let screen = NSScreen.main?.visibleFrame ?? NSScreen.screens.first?.visibleFrame ?? .zero
        let layout = WorkspaceShellLayoutCalculator.layout(in: screen)
        overlay.apply(layout: layout)
        edgeReveal.update(
            screen: screen,
            descriptors: [
                WorkspaceShellRevealDescriptor(surface: .sidebar, edge: .left, frame: layout.sidebar),
                WorkspaceShellRevealDescriptor(surface: .topBar, edge: .top, frame: layout.topBar),
            ],
            configuration: WorkspaceShellRevealConfiguration(
                pinned: (userPinned || !inputMonitoringGranted) ? [.sidebar, .topBar] : [],
                held: []
            )
        )
    }

    private func observeScreenChanges() {
        screenObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.relayout() }
        }
    }

    // MARK: - Content

    private func buildContent() {
        let addButton = NSButton(title: "Add Workspace…", target: self, action: #selector(addWorkspaceTapped))
        addButton.setAccessibilityIdentifier("workspace-shell-add")

        workspaceSwitcher.target = self
        workspaceSwitcher.action = #selector(workspaceSwitched)
        workspaceSwitcher.setAccessibilityIdentifier("workspace-shell-switcher")

        outlineView.setAccessibilityIdentifier("workspace-shell-file-tree")
        outlineView.headerView = nil
        outlineView.backgroundColor = .clear
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
        scroll.drawsBackground = false
        scroll.documentView = outlineView
        scroll.hasVerticalScroller = true
        scroll.translatesAutoresizingMaskIntoConstraints = false

        let sidebarStack = NSStackView(views: [workspaceSwitcher, addButton, scroll, buildEditor()])
        sidebarStack.orientation = .vertical
        sidebarStack.alignment = .leading
        sidebarStack.spacing = 8
        sidebarStack.edgeInsets = NSEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
        sidebarStack.translatesAutoresizingMaskIntoConstraints = false
        overlay.sidebarContentView.addSubview(sidebarStack)
        NSLayoutConstraint.activate([
            sidebarStack.leadingAnchor.constraint(equalTo: overlay.sidebarContentView.leadingAnchor),
            sidebarStack.trailingAnchor.constraint(equalTo: overlay.sidebarContentView.trailingAnchor),
            sidebarStack.topAnchor.constraint(equalTo: overlay.sidebarContentView.topAnchor),
            sidebarStack.bottomAnchor.constraint(equalTo: overlay.sidebarContentView.bottomAnchor),
            scroll.widthAnchor.constraint(equalTo: sidebarStack.widthAnchor, constant: -24),
        ])

        // Minimal top bar: Agents command + a pin toggle. The workspace controls live on the wide
        // left sidebar, so the top bar stays thin.
        let agentsButton = NSButton(title: "Agents", target: self, action: #selector(agentsTapped))
        agentsButton.setAccessibilityIdentifier("workspace-shell-agents")
        pinButton.target = self
        pinButton.action = #selector(pinTapped)
        pinButton.setButtonType(.pushOnPushOff)
        pinButton.setAccessibilityIdentifier("toggle-sidebar-pin")

        let topBarStack = NSStackView(views: [agentsButton, pinButton])
        topBarStack.orientation = .horizontal
        topBarStack.alignment = .centerY
        topBarStack.spacing = 8
        topBarStack.edgeInsets = NSEdgeInsets(top: 4, left: 12, bottom: 4, right: 12)
        topBarStack.translatesAutoresizingMaskIntoConstraints = false
        overlay.topBarContentView.addSubview(topBarStack)
        NSLayoutConstraint.activate([
            topBarStack.leadingAnchor.constraint(equalTo: overlay.topBarContentView.leadingAnchor),
            topBarStack.trailingAnchor.constraint(lessThanOrEqualTo: overlay.topBarContentView.trailingAnchor),
            topBarStack.centerYAnchor.constraint(equalTo: overlay.topBarContentView.centerYAnchor),
        ])
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

    // MARK: - Actions

    @objc private func openSelectedFile() {
        let row = outlineView.clickedRow
        guard row >= 0,
              let node = outlineView.item(atRow: row) as? WorkspaceShellFileNode,
              !node.isDirectory,
              let workspaceID = controller.store.active?.id.uuidString
        else { return }
        overlay.focusSidebar()
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

    @objc private func pinTapped() {
        userPinned = (pinButton.state == .on)
        updateConfiguration()
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

    private func presentFailure(_ title: String, _ error: Error) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = String(describing: error)
        alert.alertStyle = .warning
        alert.runModal()
    }

    // MARK: - Render

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
        closeEditor()
        fileTree = controller.activeFileTree()
        rootNode = fileTree?.rootNode
        outlineView.reloadData()
    }

    // MARK: - AX self-report

    /// Logs the shell's accessibility state after load, so the reveal chrome is observable from the
    /// host's own os_log without an out-of-process AX client. Reports which identified controls are
    /// reachable, the active workspace's tree entry count, and whether the bars are revealed (they are
    /// when Input Monitoring is absent and the shell is pinned).
    private func logAXSelfReport() {
        let ids = axIdentifiers(in: overlay.sidebarContentView)
            .union(axIdentifiers(in: overlay.topBarContentView))
        let expected = [
            "workspace-shell-agents",
            "workspace-shell-switcher",
            "workspace-shell-add",
            "workspace-shell-file-tree",
            "toggle-sidebar-pin",
        ]
        let present = expected.filter { ids.contains($0) }
        let treeEntries = fileTree?.rootNode.children().count ?? 0
        logger.notice(
            "workspace-shell AX: sidebarRevealed=\(self.overlay.isRevealed(.sidebar), privacy: .public) topBarRevealed=\(self.overlay.isRevealed(.topBar), privacy: .public) inputMonitoring=\(self.inputMonitoringGranted, privacy: .public) controls=[\(present.joined(separator: ","), privacy: .public)] treeEntries=\(treeEntries, privacy: .public) activeWorkspace=\(self.controller.store.active?.name ?? "none", privacy: .public)"
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
}

extension WorkspaceShellPresenter: NSOutlineViewDataSource, NSOutlineViewDelegate {
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
