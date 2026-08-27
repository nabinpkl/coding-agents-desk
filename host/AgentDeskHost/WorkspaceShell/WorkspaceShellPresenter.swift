import AppKit
import CoreGraphics
import TerminalEmulator
import os

/// Presents the macOS workspace shell as the agent-workspace-ide reveal-on-hover chrome (ADR-0054): a
/// left-edge sidebar (the donor workspace switcher, a divider, the active-workspace title header with
/// text-zoom −/+ and a pin, the donor FilePane file tree, and a drag-resize handle) and a top bar
/// (browser tools on the left; PTY Manager, ＋ IDE, ＋ Agents, ＋ Terminal, and a pin on the right). Both are floating all-Spaces
/// overlays that auto-hide like the Dock and slide in on an edge hover. A file opens into the donor
/// FileViewer window centered in the slot (not inline), and switching the workspace switches the macOS
/// Desktop — both driven by WorkspaceShellSession.
///
/// The pure `WorkspaceShellEdgeRevealController` is driven from a `WorkspaceShellPointerTap` (a
/// CGEvent session tap; NSEvent monitors miss non-owning Spaces). Without Input Monitoring the tap
/// can't run, so the bars degrade to pinned-visible rather than an unreachable shell.
@MainActor
final class WorkspaceShellPresenter: NSObject {
    private let workspaceCoordinator: WorkspaceCoordinator
    private let observationCoordinator: WorkspaceObservationCoordinator
    private let spacesProvider: SpacesProvider
    private lazy var desktopSwitcher = WorkspaceDesktopSwitcher(spaces: spacesProvider)
    private let terminalWindowRegistry: TerminalWindowRegistry
    private let logger = Logger(subsystem: Config.logSubsystem, category: "workspace-shell")

    private let overlay = WorkspaceShellOverlay()
    private var edgeReveal: WorkspaceShellEdgeRevealController!
    private var pointerTap: WorkspaceShellPointerTap?
    private var inputMonitoringGranted = false
    /// Surfaces the user has pinned open (per-surface, like the donor's two pins). When Input
    /// Monitoring is absent both are treated pinned so the shell stays reachable (see effectivePinned).
    private var pinnedSurfaces: Set<WorkspaceShellSurface> = []
    /// Active desktop selection, execution, and Undo hold the Dock open independently of user pins.
    private var dockInteractionHeld = false
    /// The live sidebar width (seeded from the store, updated by the resize handle drag).
    private var sidebarWidth: CGFloat = SidebarWidth.defaultValue
    /// The display currently hosting the one authoritative interactive shell. Pointer movement moves
    /// it between displays; duplicating the stateful file tree and controls would create drift.
    private var activeScreenFrame: CGRect?
    private var screenObserver: NSObjectProtocol?
    private var spaceObserver: NSObjectProtocol?
    private var missionControlTopologyObserver: MissionControlTopologyObserver?
    private var loadTask: Task<Void, Never>?

    /// The donor sidebar workspace switcher (ported verbatim): one row per workspace with its
    /// desktop badge, hover assign-desktop, auto-assign toggle, hover close, and drag reorder.
    private let switcher = WorkspaceSwitcher()
    private let filePane = FilePane()
    private let viewer = FileViewer()
    private let activityBar = ActivityBar()
    private let sourceControl = SourceControlPanel()
    private let sidebarPanelArea = NSView()
    /// The bottom dock-enrichment strip (ADR-0054): a per-desktop overview of running apps, revealed on
    /// a bottom-edge hover. `dockPresenter` drives its off-main snapshot + coalesced render.
    private let dockPanel = DockEnrichmentPanel()
    private var dockPresenter: DockEnrichmentPresenter?
    /// Tracks the macOS Dock's auto-hide/orientation/thickness so the strip floats above it (and above
    /// a revealed auto-hidden Dock) instead of overlapping it.
    private let dockGeometry = DockGeometryMonitor()
    private var session: WorkspaceShellSession?
    /// The embedded PTY Manager window (R56), created lazily on first open from the top-bar chip.
    private var ptyManagerWindow: PtyManagerWindowController?

    // Donor sidebar chrome: the active-workspace name header, text-zoom −/+ buttons, the sidebar
    // pin, and the right-edge drag-resize handle. The top bar carries its own pin.
    private let sidebarTitleLabel = NSTextField(labelWithString: "WORKSPACE")
    private let zoomOutButton = HoverButton(frame: .zero)
    private let zoomInButton = HoverButton(frame: .zero)
    private let sidebarPinButton = HoverButton(frame: .zero)
    private let topBarPinButton = HoverButton(frame: .zero)
    /// The "＋" chips, each a split control whose wide half opens a window and whose chevron half
    /// lists the ones already open. Built on first use of the top bar, because a split control needs
    /// its kind to exist at all.
    private lazy var ideControl = makeWindowControl(kind: .ide)
    private lazy var agentsControl = makeWindowControl(kind: .agents)
    private lazy var terminalControl = makeWindowControl(kind: .terminal)
    private let resizeHandle = SidebarResizeHandle()
    private weak var voiceButton: NSButton?

    /// Invoked when a "＋" chip is tapped. The placement identifies the Desktop and current shell slot
    /// where AppDelegate should create an independent window of that kind.
    ///
    /// Never carries `.terminal`: a Terminal is rooted at the active workspace's folder and cascades
    /// within that workspace, so the session places it and `onOpenTerminal` is what its chip calls.
    var onOpenWindow: ((WorkspaceWindowKind, WorkspaceWindowPlacement) -> Void)?
    var onOpenCodexWindow: ((WorkspaceDesktopAssignment) -> Void)?

    /// Lists the windows of one kind open right now, for that kind's chooser. Asked at the moment the
    /// chooser opens rather than mirrored into the shell, so there is no second copy of the registry's
    /// list to drift from it.
    var onListWindows: ((WorkspaceWindowKind) -> [WorkspaceWindowSummary])?

    /// Goes to one listed window: its Desktop becomes the active one and the window comes forward
    /// there. The shell only names the window; the Desktop it lives on is the registry's to know.
    var onFocusWindow: ((WorkspaceWindowKind, UUID) -> Void)?

    /// Closes one listed window. The shell does not own these windows and never holds one; it passes
    /// back the id it was given.
    var onCloseWindow: ((WorkspaceWindowKind, UUID) -> Void)?

    /// Opens the host-local Chrome projection window used to develop the Browser surface.
    var onBrowserCommand: (() -> Void)?

    /// Toggles the macOS gesture window (InteractionPanel webview: camera + swipe
    /// tracker -> Space step). AppDelegate wires this, keeping the shell decoupled.
    var onGestureCommand: (() -> Void)?

    /// Opens the retained full InteractionPanel on Voice. Dictation owns this
    /// availability while it has the shared recorder in flight.
    var onVoiceCommand: (() -> Void)?

    var voiceCommandEnabled = true {
        didSet { voiceButton?.isEnabled = voiceCommandEnabled }
    }

    /// Invoked when the top-bar "＋ Terminal" command is tapped (R54). AppDelegate/session wires this
    /// to spawn an in-app terminal on our pty socket (R55); the shell stays decoupled from the terminal.
    var onOpenTerminal: (() -> Void)?

    /// Invoked when the top-bar "PTY Manager" command is tapped (R54). AppDelegate wires this to the
    /// embedded PTY Manager window (R56).
    var onOpenPtyManager: (() -> Void)?

    init(
        workspaceCoordinator: WorkspaceCoordinator,
        observationCoordinator: WorkspaceObservationCoordinator,
        spacesProvider: SpacesProvider,
        terminalWindowRegistry: TerminalWindowRegistry
    ) {
        self.workspaceCoordinator = workspaceCoordinator
        self.observationCoordinator = observationCoordinator
        self.spacesProvider = spacesProvider
        self.terminalWindowRegistry = terminalWindowRegistry
        super.init()
    }

    func show() {
        buildContent()
        buildDock()
        edgeReveal = WorkspaceShellEdgeRevealController(apply: { [weak self] presentation in
            guard let self else { return }
            if let screen = presentation.screen {
                self.activeScreenFrame = screen
                self.overlay.apply(layout: self.layout(for: screen, pinned: self.effectivePinned()))
            }
            self.overlay.setReveal(presentation.state.revealed)
            // Revealing the bottom strip triggers a fresh off-main snapshot; hiding it stops the work.
            self.dockPresenter?.setVisible(presentation.state.revealed.contains(.dockEnrichment))
        })
        overlay.show()
        relayout()
        startPointerTapOrDegrade()
        observeScreenChanges()
        observeSpaceChanges()

        loadTask = Task { [weak self] in
            guard let self else { return }
            let store = await self.loadInitialStore()
            guard !Task.isCancelled else { return }
            let session = WorkspaceShellSession(
                store: store,
                workspaceCoordinator: self.workspaceCoordinator,
                observationCoordinator: self.observationCoordinator,
                filePane: self.filePane,
                viewer: self.viewer,
                desktopSwitcher: self.desktopSwitcher,
                terminalWindowRegistry: self.terminalWindowRegistry,
                slotFrame: { [weak self] in
                    // Invoked on the main actor by the session; a pinned bar insets the slot by the
                    // live sidebar width so an editor/terminal window sits beside it, not under it.
                    MainActor.assumeIsolated {
                        self?.currentSlotFrame() ?? .zero
                    }
                }
            )
            session.onActiveChanged = { [weak self] in self?.refreshSwitcher() }
            session.onGitStatusChanged = { [weak self] status, root in
                self?.applyGitStatus(status, root: root)
            }
            self.session = session
            // Seed the sidebar chrome from the persisted store: width for the panel, text zoom for
            // the switcher/title, before the first render.
            self.sidebarWidth = session.sidebarWidth
            self.switcher.setTextZoom(session.textZoom)
            self.sourceControl.setTextZoom(session.textZoom)
            self.applyTitleFont(session.textZoom)
            // The top-bar "＋ Terminal" chip spawns a terminal for the active workspace (R55); the
            // "PTY Manager" chip opens the embedded session-list window (R56).
            self.onOpenTerminal = { [weak session] in session?.openTerminal() }
            self.onOpenPtyManager = { [weak self] in self?.showPtyManager() }
            session.start()
            self.observeMissionControlTopology()
            self.refreshSwitcher()
            self.relayout()
            self.logAXSelfReport()
        }
    }

    /// Loads the authoritative store (importing the donor once on first run) and auto-selects the
    /// first workspace when none is active, so the shell renders a tree instead of an empty pane.
    private func loadInitialStore() async -> WorkspaceStore {
        do {
            let loaded = try await workspaceCoordinator.snapshot()
            guard loaded.active == nil, let first = loaded.workspaces.first else { return loaded }
            return try await workspaceCoordinator.apply(.select(first.id))
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
        missionControlTopologyObserver?.stop()
        ptyManagerWindow?.stop()
        ptyManagerWindow = nil
        dockPresenter?.stop()
        dockPresenter = nil
        dockInteractionHeld = false
        overlay.stop()
    }

    // MARK: - Reveal wiring

    private func startPointerTapOrDegrade() {
        if CGPreflightListenEventAccess() {
            let tap = WorkspaceShellPointerTap(
                onPointer: { [weak self] quartz in self?.enqueuePointer(quartz) },
                onPrimaryClick: { [weak self] quartz in self?.enqueuePrimaryClick(quartz) }
            )
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

    nonisolated private func enqueuePrimaryClick(_ quartz: CGPoint) {
        Task { @MainActor [weak self] in self?.handlePrimaryClick(quartz) }
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

    private func handlePrimaryClick(_ quartz: CGPoint) {
        let point = WorkspaceShellPointerTap.appKitPoint(quartz: quartz)
        let insideDock = overlay.containsSurface(.dockEnrichment, point: point)
        guard dockPresenter?.swapState.shouldCancelForPrimaryClick(insideDock: insideDock) == true else { return }
        dockPresenter?.cancelInteraction()
    }

    /// The surfaces to hold revealed: the user's pins, or both when Input Monitoring is absent (the
    /// reveal tap can't run, so the bars stay pinned-visible rather than becoming unreachable).
    private func effectivePinned() -> Set<WorkspaceShellSurface> {
        inputMonitoringGranted ? pinnedSurfaces : [.sidebar, .topBar]
    }

    private func currentScreen() -> CGRect {
        let screens = NSScreen.screens.map(\.visibleFrame)
        if let activeScreenFrame, screens.contains(activeScreenFrame) {
            return activeScreenFrame
        }
        let pointer = NSEvent.mouseLocation
        return screens.first(where: { $0.contains(pointer) })
            ?? NSScreen.main?.visibleFrame
            ?? screens.first
            ?? .zero
    }

    private func currentSlotFrame() -> CGRect {
        layout(for: currentScreen(), pinned: effectivePinned()).slot
    }

    private func updateConfiguration() {
        edgeReveal.setConfiguration(revealConfiguration(pinned: effectivePinned()))
    }

    private func revealConfiguration(pinned: Set<WorkspaceShellSurface>) -> WorkspaceShellRevealConfiguration {
        WorkspaceShellRevealConfiguration(
            pinned: pinned,
            held: dockInteractionHeld ? [.dockEnrichment] : []
        )
    }

    private func relayout() {
        let pinned = effectivePinned()
        let dockScreen = NSScreen.main?.visibleFrame ?? NSScreen.screens.first?.visibleFrame
        let targets = NSScreen.screens.map { screen in
            let frame = screen.visibleFrame
            let descriptors = layout(for: frame, pinned: pinned).revealDescriptors.filter {
                $0.surface != .dockEnrichment || frame == dockScreen
            }
            return WorkspaceShellRevealTarget(
                screen: frame,
                descriptors: descriptors
            )
        }
        edgeReveal.update(
            targets: targets,
            preferredScreen: currentScreen(),
            configuration: revealConfiguration(pinned: pinned)
        )
    }

    /// One layout source per display: it positions the movable panels and defines that display's
    /// top/left edge triggers. Dock reveal remains on the main display because this arc does not
    /// change its single-display ownership or geometry.
    private func layout(for screen: CGRect, pinned: Set<WorkspaceShellSurface>) -> SlotLayout {
        computeSlotLayout(
            screen: screen,
            config: SlotLayoutConfig(
                sidebarWidth: sidebarWidth,
                dockEnrichmentBottomOffset: dockGeometry.current.bottomRevealInset + 16
            ),
            sidebarPinned: pinned.contains(.sidebar),
            topBarPinned: pinned.contains(.topBar)
        )
    }

    private func observeScreenChanges() {
        screenObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                DockDisplayMonitorCache.shared.refreshFromScreens()
                self?.dockGeometry.refresh()
                self?.refreshSwitcher()
                self?.relayout()
            }
        }
    }

    private func observeSpaceChanges() {
        spaceObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.session?.reconcileFromObservedDesktop()
                self?.refreshSwitcher()
                // The active Desktop changed; if the strip is showing, re-snapshot so the active-pill
                // highlight and per-desktop grouping follow.
                self?.dockPresenter?.refreshIfVisible()
            }
        }
    }

    private func observeMissionControlTopology() {
        let observer = MissionControlTopologyObserver(spacesProvider: spacesProvider)
        observer.onTopologyChanged = { [weak self] topology in
            guard let self else { return }
            self.session?.reconcileFromMissionControlTopology(topology) { [weak self] in
                self?.refreshSwitcher()
                self?.dockPresenter?.refreshIfVisible()
            }
        }
        missionControlTopologyObserver = observer
        observer.start()
    }

    // MARK: - Content

    private func buildContent() {
        buildSidebar()
        buildTopBar()
    }

    /// Fill the bottom dock-enrichment surface with the strip view and stand up its snapshot presenter.
    /// The label provider maps each desktop's Space id to its assigned workspace name (Q2), read on the
    /// main thread. The monitor cache is primed here (NSScreen is main-thread only) and on screen change.
    private func buildDock() {
        dockPanel.translatesAutoresizingMaskIntoConstraints = false
        let content = overlay.dockContentView
        content.addSubview(dockPanel)
        NSLayoutConstraint.activate([
            dockPanel.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            dockPanel.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            dockPanel.topAnchor.constraint(equalTo: content.topAnchor),
            dockPanel.bottomAnchor.constraint(equalTo: content.bottomAnchor),
        ])
        dockPanel.workspaceLabelProvider = { [weak self] spaceID in self?.workspaceName(forSpaceID: spaceID) }
        let focusExecutor = DockWindowFocusExecutor(
            desktopSwitcher: desktopSwitcher,
            axAccess: AXDockWindowAccess()
        )
        let presenter = DockEnrichmentPresenter(
            reader: DockAppSnapshotReader(),
            renderer: dockPanel,
            focusExecutor: focusExecutor
        )
        dockPanel.onSwapToggle = { [weak presenter] in presenter?.toggleSwap() }
        dockPanel.onDesktopSelection = { [weak presenter] selection in presenter?.selectDesktop(selection) }
        dockPanel.onDesktopActivation = { [weak presenter] request in presenter?.activateDesktop(request) }
        dockPanel.onWindowFocus = { [weak presenter] request in presenter?.focusWindow(request) }
        dockPanel.onUndo = { [weak presenter] in presenter?.undo() }
        dockPanel.onCancel = { [weak presenter] in presenter?.cancelInteraction() }
        presenter.onInteractionHeldChange = { [weak self] held in
            guard let self else { return }
            self.dockInteractionHeld = held
            self.updateConfiguration()
        }
        dockPresenter = presenter
        DockDisplayMonitorCache.shared.refreshFromScreens()
        // Re-lay out the strip whenever the Dock's geometry changes (auto-hide toggled, moved, resized)
        // so it keeps floating above the Dock.
        dockGeometry.onChange = { [weak self] in self?.relayout() }
        dockGeometry.refresh()
    }

    /// The workspace assigned to a Desktop's Space id, for the dock pill label. Nil when unassigned.
    private func workspaceName(forSpaceID spaceID: UInt64?) -> String? {
        guard let spaceID,
              let workspace = session?.store.workspaces.first(where: { $0.desktopAssignment?.spaceID == spaceID })
        else { return nil }
        return workspace.name
    }

    /// The donor sidebar: workspace switcher, Explorer/Source Control activity tabs, active-workspace
    /// title and zoom/pin controls, then one replaceable panel area filling the remaining height.
    private func buildSidebar() {
        let content = overlay.sidebarContentView

        // The donor switcher owns add / select / remove / assign-desktop / auto-assign / reorder,
        // per-row (its rows carry the desktop badge, hover assign ⌖, auto-assign A, hover close ×).
        switcher.onSelect = { [weak self] id in self?.session?.switchTo(id) }
        switcher.onAdd = { [weak self] in self?.addWorkspace() }
        switcher.onRemove = { [weak self] id in self?.session?.removeWorkspace(id) }
        switcher.onAssignDesktop = { [weak self] id in self?.session?.assignToCurrentDesktop(id) }
        switcher.onSetDesktopAutoAssign = { [weak self] id, enabled in self?.session?.setDesktopAutoAssign(id, enabled: enabled) }
        switcher.onReorder = { [weak self] ids in self?.session?.reorder(ids) }
        switcher.view.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(switcher.view)

        let divider = makeSeparator()
        content.addSubview(divider)

        activityBar.onSelect = { [weak self] tab in self?.showSidebarPanel(tab) }
        activityBar.view.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(activityBar.view)

        sidebarTitleLabel.font = .systemFont(ofSize: 11, weight: .semibold)
        sidebarTitleLabel.textColor = .secondaryLabelColor
        sidebarTitleLabel.lineBreakMode = .byTruncatingTail
        sidebarTitleLabel.maximumNumberOfLines = 1
        sidebarTitleLabel.translatesAutoresizingMaskIntoConstraints = false
        sidebarTitleLabel.setAccessibilityIdentifier("workspace-shell-title")
        sidebarTitleLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)
        sidebarTitleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        content.addSubview(sidebarTitleLabel)

        configureIconButton(zoomOutButton, symbol: "minus", id: "sidebar-zoom-out", label: "Zoom Out", action: #selector(zoomOutTapped))
        configureIconButton(zoomInButton, symbol: "plus", id: "sidebar-zoom-in", label: "Zoom In", action: #selector(zoomInTapped))
        configureIconButton(sidebarPinButton, symbol: "pin", id: "toggle-sidebar-pin", label: "Pin sidebar", action: #selector(sidebarPinTapped))
        applyPinGlyph(sidebarPinButton, pinned: false)
        content.addSubview(zoomOutButton)
        content.addSubview(zoomInButton)
        content.addSubview(sidebarPinButton)

        filePane.view.setAccessibilityIdentifier("workspace-shell-file-tree")
        sourceControl.onActivate = { [weak self] url in self?.session?.openFile(url) }
        sourceControl.view.setAccessibilityIdentifier("source-control-panel")
        sidebarPanelArea.setAccessibilityIdentifier("workspace-shell-sidebar-panel")
        sidebarPanelArea.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(sidebarPanelArea)

        let edge = makeSeparator()
        content.addSubview(edge)

        resizeHandle.onProposeWidth = { [weak self] width in self?.proposeSidebarWidth(width) }
        resizeHandle.onEndResize = { [weak self] in self?.commitSidebarWidth() }
        resizeHandle.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(resizeHandle)  // added last: sits over the content's right edge for hits

        NSLayoutConstraint.activate([
            switcher.view.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            switcher.view.trailingAnchor.constraint(equalTo: edge.leadingAnchor),
            switcher.view.topAnchor.constraint(equalTo: content.topAnchor, constant: 6),

            divider.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 8),
            divider.trailingAnchor.constraint(equalTo: edge.leadingAnchor, constant: -8),
            divider.topAnchor.constraint(equalTo: switcher.view.bottomAnchor, constant: 6),
            divider.heightAnchor.constraint(equalToConstant: 1),

            activityBar.view.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            activityBar.view.trailingAnchor.constraint(equalTo: edge.leadingAnchor),
            activityBar.view.topAnchor.constraint(equalTo: divider.bottomAnchor, constant: 4),
            activityBar.view.heightAnchor.constraint(equalToConstant: 30),

            sidebarTitleLabel.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 14),
            sidebarTitleLabel.trailingAnchor.constraint(equalTo: zoomOutButton.leadingAnchor, constant: -6),
            sidebarTitleLabel.topAnchor.constraint(equalTo: activityBar.view.bottomAnchor, constant: 8),

            zoomOutButton.trailingAnchor.constraint(equalTo: zoomInButton.leadingAnchor, constant: -2),
            zoomOutButton.centerYAnchor.constraint(equalTo: sidebarTitleLabel.centerYAnchor),
            zoomInButton.trailingAnchor.constraint(equalTo: sidebarPinButton.leadingAnchor, constant: -2),
            zoomInButton.centerYAnchor.constraint(equalTo: sidebarTitleLabel.centerYAnchor),
            sidebarPinButton.trailingAnchor.constraint(equalTo: edge.leadingAnchor, constant: -6),
            sidebarPinButton.centerYAnchor.constraint(equalTo: sidebarTitleLabel.centerYAnchor),

            sidebarPanelArea.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            sidebarPanelArea.trailingAnchor.constraint(equalTo: edge.leadingAnchor),
            sidebarPanelArea.topAnchor.constraint(equalTo: sidebarTitleLabel.bottomAnchor, constant: 8),
            sidebarPanelArea.bottomAnchor.constraint(equalTo: content.bottomAnchor),

            edge.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            edge.topAnchor.constraint(equalTo: content.topAnchor),
            edge.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            edge.widthAnchor.constraint(equalToConstant: 1),

            resizeHandle.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            resizeHandle.topAnchor.constraint(equalTo: content.topAnchor),
            resizeHandle.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            resizeHandle.widthAnchor.constraint(equalToConstant: 8),
        ])
        showSidebarPanel(.explorer)
    }

    private func showSidebarPanel(_ tab: SidebarTab) {
        activityBar.select(tab)
        let panel: NSView
        switch tab {
        case .explorer: panel = filePane.view
        case .sourceControl: panel = sourceControl.view
        }
        sidebarPanelArea.subviews.forEach { $0.removeFromSuperview() }
        panel.translatesAutoresizingMaskIntoConstraints = false
        sidebarPanelArea.addSubview(panel)
        NSLayoutConstraint.activate([
            panel.leadingAnchor.constraint(equalTo: sidebarPanelArea.leadingAnchor),
            panel.trailingAnchor.constraint(equalTo: sidebarPanelArea.trailingAnchor),
            panel.topAnchor.constraint(equalTo: sidebarPanelArea.topAnchor),
            panel.bottomAnchor.constraint(equalTo: sidebarPanelArea.bottomAnchor),
        ])
    }

    private func applyGitStatus(_ status: GitStatus, root: URL?) {
        if let root {
            activityBar.setSourceControlCount(sourceControl.apply(status, root: root))
        } else {
            sourceControl.clear()
            activityBar.setSourceControlCount(0)
        }
    }

    /// Top bar: workspace tools stay on the left; the window-spawning chips + top-bar pin ride the
    /// right edge as [PTY Manager] [＋ IDE] [＋ Agents] [＋ Terminal] [pin]. A low-hugging spacer pushes the
    /// chips to the right so they stay together beside the pin.
    private func buildTopBar() {
        let browserButton = NSButton(title: "Browser", target: self, action: #selector(browserTapped))
        browserButton.setAccessibilityIdentifier("workspace-shell-browser")
        let gestureButton = NSButton(title: "Gesture", target: self, action: #selector(gestureTapped))
        gestureButton.setAccessibilityIdentifier("workspace-shell-gesture")
        let voiceButton = NSButton(title: "Voice", target: self, action: #selector(voiceTapped))
        voiceButton.setAccessibilityIdentifier("workspace-shell-voice")
        voiceButton.isEnabled = voiceCommandEnabled
        self.voiceButton = voiceButton
        let ptyManagerButton = NSButton(title: "PTY Manager", target: self, action: #selector(openPtyManagerTapped))
        ptyManagerButton.setAccessibilityIdentifier("open-pty-manager")
        configureIconButton(topBarPinButton, symbol: "pin", id: "toggle-topbar-pin", label: "Pin top bar", action: #selector(topBarPinTapped))
        applyPinGlyph(topBarPinButton, pinned: false)

        let spacer = NSView()
        spacer.translatesAutoresizingMaskIntoConstraints = false
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        spacer.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let topBarStack = NSStackView(views: [browserButton, gestureButton, voiceButton, spacer, ptyManagerButton, ideControl, agentsControl, terminalControl, topBarPinButton])
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

    private func makeWindowControl(kind: WorkspaceWindowKind) -> WorkspaceWindowSplitControl {
        WorkspaceWindowSplitControl(
            kind: kind,
            open: { [weak self] in self?.openWindowTapped(kind) },
            chooser: { [weak self] in self?.makeWindowChooserMenu(kind) ?? NSMenu() }
        )
    }

    /// A 1pt appearance-adaptive separator line (NSBox draws + flips with light/dark).
    private func makeSeparator() -> NSBox {
        let box = NSBox()
        box.boxType = .separator
        box.translatesAutoresizingMaskIntoConstraints = false
        return box
    }

    /// Shared setup for a flat borderless icon button (zoom −/+, the two pins). The glyph is set here
    /// for the zoom buttons; the pins override it via `applyPinGlyph` to swap pin/pin.fill on toggle.
    private func configureIconButton(_ button: HoverButton, symbol: String, id: String, label: String, action: Selector) {
        button.isBordered = false
        button.bezelStyle = .regularSquare
        button.imagePosition = .imageOnly
        button.cornerRadius = 5
        button.restingColor = .clear
        button.hoverColor = HoverButton.subtleFill
        button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)?
            .withSymbolConfiguration(.init(pointSize: 11, weight: .semibold))
        button.contentTintColor = .secondaryLabelColor
        button.target = self
        button.action = action
        button.toolTip = label
        button.setAccessibilityRole(.button)
        button.setAccessibilityIdentifier(id)
        button.setAccessibilityLabel(label)
        button.translatesAutoresizingMaskIntoConstraints = false
        button.setContentHuggingPriority(.required, for: .horizontal)
        button.widthAnchor.constraint(equalToConstant: 24).isActive = true
        button.heightAnchor.constraint(equalToConstant: 22).isActive = true
    }

    /// Reflect a pin's state: a filled accent-tinted pin when pinned, an outline dim pin when not.
    private func applyPinGlyph(_ button: HoverButton, pinned: Bool) {
        button.image = NSImage(systemSymbolName: pinned ? "pin.fill" : "pin", accessibilityDescription: pinned ? "Unpin" : "Pin")?
            .withSymbolConfiguration(.init(pointSize: 12, weight: .regular))
        button.contentTintColor = pinned ? AppTheme.accent : .tertiaryLabelColor
        button.toolTip = pinned ? "Unpin (auto-hide)" : "Pin open"
        button.setAccessibilityValue(pinned ? "pinned" : "not pinned")
    }

    // MARK: - Actions

    /// The wide half of a "＋" chip. The size is the window's before the user has moved it: an IDE
    /// opens wide enough to hold a sidebar, an editor, and a terminal; an Agents window is a tall
    /// column of one feed. A Terminal takes neither a size nor a Desktop from here -- it is rooted at
    /// the active workspace's folder and cascades within that workspace, which only the session knows.
    private func openWindowTapped(_ kind: WorkspaceWindowKind) {
        switch kind {
        case .ide: openWindowInSlot(.ide, size: CGSize(width: 1_180, height: 760))
        case .agents: openWindowInSlot(.agents, size: CGSize(width: 480, height: 720))
        case .terminal: onOpenTerminal?()
        }
    }

    private func openWindowInSlot(_ kind: WorkspaceWindowKind, size: CGSize) {
        guard let desktop = desktopSwitcher.currentAssignment() else {
            logger.error(
                "workspace-shell: cannot open \(kind.label, privacy: .public) because the current Desktop is unavailable"
            )
            return
        }
        onOpenWindow?(kind, WorkspaceWindowPlacement(
            desktop: desktop,
            frame: centeredRect(in: currentSlotFrame(), size: size)
        ))
    }

    private func makeWindowChooserMenu(_ kind: WorkspaceWindowKind) -> NSMenu {
        WorkspaceWindowChooserMenu.make(
            kind: kind,
            windows: onListWindows?(kind) ?? [],
            openCodexWindow: { [weak self] in self?.openCodexWindowTapped() },
            focus: { [weak self] id in self?.onFocusWindow?(kind, id) },
            close: { [weak self] id in self?.onCloseWindow?(kind, id) }
        )
    }

    private func openCodexWindowTapped() {
        guard let desktop = desktopSwitcher.currentAssignment() else {
            logger.error("workspace-shell: cannot open Codex because the current Desktop is unavailable")
            return
        }
        onOpenCodexWindow?(desktop)
    }

    @objc private func browserTapped() { onBrowserCommand?() }

    @objc private func gestureTapped() { onGestureCommand?() }

    @objc private func voiceTapped() { onVoiceCommand?() }

    @objc private func openPtyManagerTapped() { onOpenPtyManager?() }

    private func showPtyManager() {
        let controller = ptyManagerWindow ?? PtyManagerWindowController(
            terminalWindowRegistry: terminalWindowRegistry,
            currentDesktopAssignment: { [weak self] in
                self?.desktopSwitcher.currentAssignment()
            }
        )
        ptyManagerWindow = controller
        controller.show()
    }

    @objc private func sidebarPinTapped() { togglePin(.sidebar, button: sidebarPinButton) }
    @objc private func topBarPinTapped() { togglePin(.topBar, button: topBarPinButton) }

    private func togglePin(_ surface: WorkspaceShellSurface, button: HoverButton) {
        if pinnedSurfaces.contains(surface) { pinnedSurfaces.remove(surface) } else { pinnedSurfaces.insert(surface) }
        applyPinGlyph(button, pinned: pinnedSurfaces.contains(surface))
        updateConfiguration()
        relayout()
    }

    @objc private func zoomInTapped() { applyZoom(.zoomIn) }
    @objc private func zoomOutTapped() { applyZoom(.zoomOut) }

    /// Apply a text-zoom step across the shell: the file tree, switcher rows, title header (here) and
    /// the web-viewer editor + rendered markdown (via the session), then persist it — matching the
    /// donor, where the sidebar zoom scaled everything.
    private func applyZoom(_ command: WorkspaceTextZoomCommand) {
        guard let session else { return }
        let zoom = session.applyTextZoom(command)
        switcher.setTextZoom(zoom)
        sourceControl.setTextZoom(zoom)
        refreshSwitcher()
        applyTitleFont(zoom)
    }

    private func applyTitleFont(_ zoom: WorkspaceTextZoom) {
        sidebarTitleLabel.font = .systemFont(ofSize: zoom.sidebarLabelPointSize, weight: .semibold)
    }

    // MARK: - Sidebar resize (drag handle)

    /// Live-resize during a drag: the handle reports the pointer x in the sidebar panel, which is the
    /// proposed width (distance from the left edge). Clamp and relayout so the panel follows the drag.
    private func proposeSidebarWidth(_ proposed: CGFloat) {
        sidebarWidth = SidebarWidth.clamped(proposed, screenWidth: currentScreen().width)
        relayout()
    }

    /// The drag released: persist the settled width through the store.
    private func commitSidebarWidth() {
        session?.setSidebarWidth(sidebarWidth, screenWidth: currentScreen().width)
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
            Task { [weak self] in
                do { try await self?.session?.addWorkspace(workspace) }
                catch { self?.presentFailure("Could not add workspace", error) }
            }
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

    func presentCodexWindowLaunchFailure(_ error: CodexWindowLaunchError) {
        presentFailure("Could not open Codex window", error)
    }

    // MARK: - Switcher render

    private func refreshSwitcher() {
        switcher.render(
            workspaces: session?.store.workspaces ?? [],
            activeID: session?.store.activeID,
            missionControlNumbersBySpaceID: session?.missionControlNumbersBySpaceID ?? [:],
            monitorPresentationsByDisplayID: session?.monitorPresentationsByDisplayID ?? [:]
        )
        sidebarTitleLabel.stringValue = (session?.store.active?.name).map { $0.uppercased() } ?? "WORKSPACE"
    }

    // MARK: - AX self-report

    private func logAXSelfReport() {
        let ids = axIdentifiers(in: overlay.sidebarContentView)
            .union(axIdentifiers(in: overlay.topBarContentView))
            .union(axIdentifiers(in: overlay.dockContentView))
        let expected = [
            "open-ide", "open-agents", "open-terminal", "open-pty-manager",
            "workspace-switcher", "add-workspace", "workspace-shell-title",
            "activity-bar", "activity-explorer", "activity-source-control",
            "sidebar-zoom-out", "sidebar-zoom-in", "workspace-shell-file-tree",
            "sidebar-resize-handle", "toggle-sidebar-pin", "toggle-topbar-pin",
            "workspace-dock-enrichment",
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
