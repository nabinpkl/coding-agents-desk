import AppKit
import CoreGraphics
import os

/// Presents the macOS workspace shell as the agent-workspace-ide reveal-on-hover chrome (ADR-0054): a
/// left-edge sidebar (workspace switcher + the donor FilePane file tree) and a top bar (Agents +
/// assign-desktop + pin), both floating all-Spaces overlays that auto-hide like the Dock and slide in
/// on an edge hover. A file opens into the donor FileViewer window centered in the slot (not inline),
/// and switching the workspace switches the macOS Desktop — both driven by WorkspaceShellSession.
///
/// The pure `WorkspaceShellEdgeRevealController` is driven from a `WorkspaceShellPointerTap` (a
/// CGEvent session tap; NSEvent monitors miss non-owning Spaces). Without Input Monitoring the tap
/// can't run, so the bars degrade to pinned-visible rather than an unreachable shell.
@MainActor
final class WorkspaceShellPresenter: NSObject {
    private let repository: WorkspaceRepository
    private let spacesProvider: SpacesProvider
    private let logger = Logger(subsystem: Config.logSubsystem, category: "workspace-shell")

    private let overlay = WorkspaceShellOverlay()
    private var edgeReveal: WorkspaceShellEdgeRevealController!
    private var pointerTap: WorkspaceShellPointerTap?
    private var inputMonitoringGranted = false
    private var userPinned = false
    private var screenObserver: NSObjectProtocol?
    private var spaceObserver: NSObjectProtocol?
    private var loadTask: Task<Void, Never>?

    private let workspaceSwitcher = NSPopUpButton(frame: .zero, pullsDown: false)
    private let filePane = FilePane()
    private let viewer = FileViewer()
    private var session: WorkspaceShellSession?
    private var switcherWorkspaceIDs: [UUID] = []

    private let pinButton = NSButton(title: "Pin", target: nil, action: nil)

    /// Invoked when the top-bar Agents command is tapped. AppDelegate wires this to toggle the macOS
    /// Agents window, keeping the shell decoupled from the agent surface.
    var onAgentsCommand: (() -> Void)?

    init(repository: WorkspaceRepository, spacesProvider: SpacesProvider) {
        self.repository = repository
        self.spacesProvider = spacesProvider
        super.init()
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
        observeSpaceChanges()

        loadTask = Task { [weak self] in
            guard let self else { return }
            let store = await self.loadInitialStore()
            let desktopSwitcher = WorkspaceDesktopSwitcher(spaces: self.spacesProvider)
            let session = WorkspaceShellSession(
                store: store,
                filePane: self.filePane,
                viewer: self.viewer,
                desktopSwitcher: desktopSwitcher,
                persist: { [repository = self.repository, logger = self.logger] next in
                    Task {
                        do { try await repository.save(next) }
                        catch {
                            logger.error("workspace-shell store persist failed: \(String(describing: error), privacy: .public)")
                        }
                    }
                },
                slotFrame: { computeSlotLayout(screen: NSScreen.main?.visibleFrame ?? .zero).slot }
            )
            session.onActiveChanged = { [weak self] in self?.refreshSwitcher() }
            self.session = session
            session.start()
            self.refreshSwitcher()
            self.logAXSelfReport()
        }
    }

    /// Loads the authoritative store (importing the donor once on first run) and auto-selects the
    /// first workspace when none is active, so the shell renders a tree instead of an empty pane.
    private func loadInitialStore() async -> WorkspaceStore {
        do {
            let loaded = try await repository.load()
            guard loaded.active == nil, let first = loaded.workspaces.first else { return loaded }
            return try await repository.select(first.id)
        } catch {
            logger.error("workspace-shell store load failed: \(String(describing: error), privacy: .public)")
            return WorkspaceStore()
        }
    }

    func stop() {
        loadTask?.cancel()
        loadTask = nil
        pointerTap?.stop()
        pointerTap = nil
        if let screenObserver { NotificationCenter.default.removeObserver(screenObserver); self.screenObserver = nil }
        if let spaceObserver { NSWorkspace.shared.notificationCenter.removeObserver(spaceObserver); self.spaceObserver = nil }
        overlay.stop()
    }

    // MARK: - Reveal wiring

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
        _ = CGRequestListenEventAccess()
        updateConfiguration()
    }

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

    private func updateConfiguration() {
        let pinned: Set<WorkspaceShellSurface> = (userPinned || !inputMonitoringGranted) ? [.sidebar, .topBar] : []
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
                pinned: (userPinned || !inputMonitoringGranted) ? [.sidebar, .topBar] : [], held: []
            )
        )
    }

    private func observeScreenChanges() {
        screenObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in MainActor.assumeIsolated { self?.relayout() } }
    }

    private func observeSpaceChanges() {
        spaceObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main
        ) { [weak self] _ in MainActor.assumeIsolated { self?.session?.reconcileFromObservedDesktop() } }
    }

    // MARK: - Content

    private func buildContent() {
        let addButton = NSButton(title: "Add Workspace…", target: self, action: #selector(addWorkspaceTapped))
        addButton.setAccessibilityIdentifier("workspace-shell-add")

        workspaceSwitcher.target = self
        workspaceSwitcher.action = #selector(workspaceSwitched)
        workspaceSwitcher.setAccessibilityIdentifier("workspace-shell-switcher")

        filePane.view.setAccessibilityIdentifier("workspace-shell-file-tree")
        filePane.view.translatesAutoresizingMaskIntoConstraints = false

        let sidebarStack = NSStackView(views: [workspaceSwitcher, addButton, filePane.view])
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
            filePane.view.widthAnchor.constraint(equalTo: sidebarStack.widthAnchor, constant: -24),
        ])

        let agentsButton = NSButton(title: "Agents", target: self, action: #selector(agentsTapped))
        agentsButton.setAccessibilityIdentifier("workspace-shell-agents")
        let assignButton = NSButton(title: "Assign Desktop", target: self, action: #selector(assignDesktopTapped))
        assignButton.setAccessibilityIdentifier("workspace-shell-assign-desktop")
        pinButton.target = self
        pinButton.action = #selector(pinTapped)
        pinButton.setButtonType(.pushOnPushOff)
        pinButton.setAccessibilityIdentifier("toggle-sidebar-pin")

        let topBarStack = NSStackView(views: [agentsButton, assignButton, pinButton])
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

    // MARK: - Actions

    @objc private func workspaceSwitched() {
        let index = workspaceSwitcher.indexOfSelectedItem
        guard index >= 0, index < switcherWorkspaceIDs.count else { return }
        session?.switchTo(switcherWorkspaceIDs[index])
    }

    @objc private func agentsTapped() { onAgentsCommand?() }

    @objc private func assignDesktopTapped() { session?.assignActiveToCurrentDesktop() }

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
        do {
            let workspace = try Workspace.registering(root: url, name: url.lastPathComponent)
            try session?.addWorkspace(workspace)
        } catch {
            presentFailure("Could not add workspace", error)
        }
    }

    private func presentFailure(_ title: String, _ error: Error) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = String(describing: error)
        alert.alertStyle = .warning
        alert.runModal()
    }

    // MARK: - Switcher render

    private func refreshSwitcher() {
        let workspaces = session?.store.workspaces ?? []
        switcherWorkspaceIDs = workspaces.map(\.id)
        workspaceSwitcher.removeAllItems()
        if workspaces.isEmpty {
            workspaceSwitcher.addItem(withTitle: "No workspace")
            workspaceSwitcher.isEnabled = false
        } else {
            workspaceSwitcher.isEnabled = true
            for workspace in workspaces { workspaceSwitcher.addItem(withTitle: workspace.name) }
            if let activeID = session?.store.activeID, let index = switcherWorkspaceIDs.firstIndex(of: activeID) {
                workspaceSwitcher.selectItem(at: index)
            }
        }
    }

    // MARK: - AX self-report

    private func logAXSelfReport() {
        let ids = axIdentifiers(in: overlay.sidebarContentView).union(axIdentifiers(in: overlay.topBarContentView))
        let expected = [
            "workspace-shell-agents", "workspace-shell-switcher", "workspace-shell-add",
            "workspace-shell-file-tree", "workspace-shell-assign-desktop", "toggle-sidebar-pin",
        ]
        let present = expected.filter { ids.contains($0) }
        logger.notice(
            "workspace-shell AX: sidebarRevealed=\(self.overlay.isRevealed(.sidebar), privacy: .public) topBarRevealed=\(self.overlay.isRevealed(.topBar), privacy: .public) inputMonitoring=\(self.inputMonitoringGranted, privacy: .public) controls=[\(present.joined(separator: ","), privacy: .public)] workspaces=\(self.session?.store.workspaces.count ?? 0, privacy: .public) activeWorkspace=\(self.session?.store.active?.name ?? "none", privacy: .public)"
        )
    }

    private func axIdentifiers(in view: NSView?) -> Set<String> {
        guard let view else { return [] }
        var result: Set<String> = []
        let identifier = view.accessibilityIdentifier()
        if !identifier.isEmpty { result.insert(identifier) }
        for subview in view.subviews { result.formUnion(axIdentifiers(in: subview)) }
        return result
    }
}
