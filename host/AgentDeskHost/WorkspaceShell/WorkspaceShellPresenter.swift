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

    /// The donor sidebar workspace switcher (ported verbatim): one row per workspace with its
    /// desktop badge, hover assign-desktop, auto-assign toggle, hover close, and drag reorder.
    private let switcher = WorkspaceSwitcher()
    private let filePane = FilePane()
    private let viewer = FileViewer()
    private var session: WorkspaceShellSession?
    /// The embedded PTY Manager window (R56), created lazily on first open from the top-bar chip.
    private var ptyManagerWindow: PtyManagerWindowController?

    private let pinButton = NSButton(title: "Pin", target: nil, action: nil)

    /// Invoked when the top-bar Agents command is tapped. AppDelegate wires this to toggle the macOS
    /// Agents window, keeping the shell decoupled from the agent surface.
    var onAgentsCommand: (() -> Void)?

    /// Invoked when the top-bar "＋ Terminal" command is tapped (R54). AppDelegate/session wires this
    /// to spawn an in-app terminal on our pty socket (R55); the shell stays decoupled from the terminal.
    var onOpenTerminal: (() -> Void)?

    /// Invoked when the top-bar "PTY Manager" command is tapped (R54). AppDelegate wires this to the
    /// embedded PTY Manager window (R56).
    var onOpenPtyManager: (() -> Void)?

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
            // The top-bar "＋ Terminal" chip spawns a terminal for the active workspace (R55); the
            // "PTY Manager" chip opens the embedded session-list window (R56).
            self.onOpenTerminal = { [weak session] in session?.openTerminal() }
            self.onOpenPtyManager = { [weak self] in self?.showPtyManager() }
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
        ptyManagerWindow?.stop()
        ptyManagerWindow = nil
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
        // The donor switcher owns add / select / remove / assign-desktop / auto-assign / reorder,
        // per-row (its rows carry the desktop badge, hover assign ⌖, auto-assign A, hover close ×).
        switcher.onSelect = { [weak self] id in self?.session?.switchTo(id) }
        switcher.onAdd = { [weak self] in self?.addWorkspace() }
        switcher.onRemove = { [weak self] id in self?.session?.removeWorkspace(id) }
        switcher.onAssignDesktop = { [weak self] id in self?.session?.assignToCurrentDesktop(id) }
        switcher.onSetDesktopAutoAssign = { [weak self] id, enabled in self?.session?.setDesktopAutoAssign(id, enabled: enabled) }
        switcher.onReorder = { [weak self] ids in self?.session?.reorder(ids) }
        switcher.view.translatesAutoresizingMaskIntoConstraints = false

        filePane.view.setAccessibilityIdentifier("workspace-shell-file-tree")
        filePane.view.translatesAutoresizingMaskIntoConstraints = false
        // The file tree takes the space the switcher (intrinsic height) leaves.
        switcher.view.setContentHuggingPriority(.required, for: .vertical)
        filePane.view.setContentHuggingPriority(.defaultLow, for: .vertical)

        let sidebarStack = NSStackView(views: [switcher.view, filePane.view])
        sidebarStack.orientation = .vertical
        sidebarStack.alignment = .leading
        sidebarStack.spacing = 6
        // No horizontal inset: the switcher rows bleed the full sidebar width like the donor's
        // (their own cell pads the label), so the active-row highlight fills edge to edge.
        sidebarStack.edgeInsets = NSEdgeInsets(top: 6, left: 0, bottom: 6, right: 0)
        sidebarStack.translatesAutoresizingMaskIntoConstraints = false
        overlay.sidebarContentView.addSubview(sidebarStack)
        NSLayoutConstraint.activate([
            sidebarStack.leadingAnchor.constraint(equalTo: overlay.sidebarContentView.leadingAnchor),
            sidebarStack.trailingAnchor.constraint(equalTo: overlay.sidebarContentView.trailingAnchor),
            sidebarStack.topAnchor.constraint(equalTo: overlay.sidebarContentView.topAnchor),
            sidebarStack.bottomAnchor.constraint(equalTo: overlay.sidebarContentView.bottomAnchor),
            switcher.view.widthAnchor.constraint(equalTo: sidebarStack.widthAnchor),
            filePane.view.widthAnchor.constraint(equalTo: sidebarStack.widthAnchor),
        ])

        // Top bar: Agents on the left; the terminal chips + pin ride the right edge, matching the
        // donor's trailing cluster [PTY Manager] [＋ Terminal] [pin]. A low-hugging spacer between
        // pushes the chips to the right so they sit rightmost, next to the pin.
        let agentsButton = NSButton(title: "Agents", target: self, action: #selector(agentsTapped))
        agentsButton.setAccessibilityIdentifier("workspace-shell-agents")
        let ptyManagerButton = NSButton(title: "PTY Manager", target: self, action: #selector(openPtyManagerTapped))
        ptyManagerButton.setAccessibilityIdentifier("open-pty-manager")
        let terminalButton = NSButton(title: "＋ Terminal", target: self, action: #selector(openTerminalTapped))
        terminalButton.setAccessibilityIdentifier("open-terminal")
        pinButton.target = self
        pinButton.action = #selector(pinTapped)
        pinButton.setButtonType(.pushOnPushOff)
        pinButton.setAccessibilityIdentifier("toggle-sidebar-pin")

        let spacer = NSView()
        spacer.translatesAutoresizingMaskIntoConstraints = false
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        spacer.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let topBarStack = NSStackView(views: [agentsButton, spacer, ptyManagerButton, terminalButton, pinButton])
        topBarStack.orientation = .horizontal
        topBarStack.alignment = .centerY
        topBarStack.spacing = 8
        topBarStack.edgeInsets = NSEdgeInsets(top: 4, left: 12, bottom: 4, right: 12)
        topBarStack.translatesAutoresizingMaskIntoConstraints = false
        overlay.topBarContentView.addSubview(topBarStack)
        NSLayoutConstraint.activate([
            topBarStack.leadingAnchor.constraint(equalTo: overlay.topBarContentView.leadingAnchor),
            topBarStack.trailingAnchor.constraint(equalTo: overlay.topBarContentView.trailingAnchor),
            topBarStack.centerYAnchor.constraint(equalTo: overlay.topBarContentView.centerYAnchor),
        ])
    }

    // MARK: - Actions

    @objc private func agentsTapped() { onAgentsCommand?() }

    @objc private func openTerminalTapped() { onOpenTerminal?() }

    @objc private func openPtyManagerTapped() { onOpenPtyManager?() }

    private func showPtyManager() {
        let controller = ptyManagerWindow ?? PtyManagerWindowController()
        ptyManagerWindow = controller
        controller.show()
    }

    @objc private func pinTapped() {
        userPinned = (pinButton.state == .on)
        updateConfiguration()
    }

    private func addWorkspace() {
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
        switcher.render(workspaces: session?.store.workspaces ?? [], activeID: session?.store.activeID)
    }

    // MARK: - AX self-report

    private func logAXSelfReport() {
        let ids = axIdentifiers(in: overlay.sidebarContentView).union(axIdentifiers(in: overlay.topBarContentView))
        let expected = [
            "workspace-shell-agents", "open-terminal", "open-pty-manager",
            "workspace-switcher", "add-workspace",
            "workspace-shell-file-tree", "toggle-sidebar-pin",
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
