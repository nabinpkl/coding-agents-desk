import AppKit
import CoreGraphics
import os

/// Presents the macOS workspace shell as the agent-workspace-ide reveal-on-hover chrome (ADR-0054): a
/// left-edge sidebar (the donor workspace switcher, a divider, the active-workspace title header with
/// text-zoom −/+ and a pin, the donor FilePane file tree, and a drag-resize handle) and a top bar
/// (Agents on the left; PTY Manager, ＋ Terminal, and a pin on the right). Both are floating all-Spaces
/// overlays that auto-hide like the Dock and slide in on an edge hover. A file opens into the donor
/// FileViewer window centered in the slot (not inline), and switching the workspace switches the macOS
/// Desktop — both driven by WorkspaceShellSession.
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
    /// Surfaces the user has pinned open (per-surface, like the donor's two pins). When Input
    /// Monitoring is absent both are treated pinned so the shell stays reachable (see effectivePinned).
    private var pinnedSurfaces: Set<WorkspaceShellSurface> = []
    /// The live sidebar width (seeded from the store, updated by the resize handle drag).
    private var sidebarWidth: CGFloat = SidebarWidth.defaultValue
    private var screenObserver: NSObjectProtocol?
    private var spaceObserver: NSObjectProtocol?
    private var loadTask: Task<Void, Never>?

    /// The donor sidebar workspace switcher (ported verbatim): one row per workspace with its
    /// desktop badge, hover assign-desktop, auto-assign toggle, hover close, and drag reorder.
    private let switcher = WorkspaceSwitcher()
    private let filePane = FilePane()
    private let viewer = FileViewer()
    /// The bottom dock-enrichment strip (ADR-0054): a per-desktop overview of running apps, revealed on
    /// a bottom-edge hover. `dockPresenter` drives its off-main snapshot + coalesced render.
    private let dockPanel = DockEnrichmentPanel()
    private var dockPresenter: DockEnrichmentPresenter?
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
    private let resizeHandle = SidebarResizeHandle()

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
        buildDock()
        edgeReveal = WorkspaceShellEdgeRevealController(apply: { [weak self] state in
            guard let self else { return }
            self.overlay.setReveal(state.revealed)
            // Revealing the bottom strip triggers a fresh off-main snapshot; hiding it stops the work.
            self.dockPresenter?.setVisible(state.revealed.contains(.dockEnrichment))
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
                slotFrame: { [weak self] in
                    // Invoked on the main actor by the session; a pinned bar insets the slot by the
                    // live sidebar width so an editor/terminal window sits beside it, not under it.
                    MainActor.assumeIsolated {
                        let screen = NSScreen.main?.visibleFrame ?? .zero
                        guard let self else { return computeSlotLayout(screen: screen).slot }
                        let pinned = self.effectivePinned()
                        return computeSlotLayout(
                            screen: screen,
                            config: SlotLayoutConfig(sidebarWidth: self.sidebarWidth),
                            sidebarPinned: pinned.contains(.sidebar),
                            topBarPinned: pinned.contains(.topBar)
                        ).slot
                    }
                }
            )
            session.onActiveChanged = { [weak self] in self?.refreshSwitcher() }
            self.session = session
            // Seed the sidebar chrome from the persisted store: width for the panel, text zoom for
            // the switcher/title, before the first render.
            self.sidebarWidth = session.sidebarWidth
            self.switcher.setTextZoom(session.textZoom)
            self.applyTitleFont(session.textZoom)
            // The top-bar "＋ Terminal" chip spawns a terminal for the active workspace (R55); the
            // "PTY Manager" chip opens the embedded session-list window (R56).
            self.onOpenTerminal = { [weak session] in session?.openTerminal() }
            self.onOpenPtyManager = { [weak self] in self?.showPtyManager() }
            session.start()
            self.refreshSwitcher()
            self.relayout()
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
        dockPresenter?.setVisible(false)
        dockPresenter = nil
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

    /// The surfaces to hold revealed: the user's pins, or both when Input Monitoring is absent (the
    /// reveal tap can't run, so the bars stay pinned-visible rather than becoming unreachable).
    private func effectivePinned() -> Set<WorkspaceShellSurface> {
        inputMonitoringGranted ? pinnedSurfaces : [.sidebar, .topBar]
    }

    private func currentScreen() -> CGRect {
        NSScreen.main?.visibleFrame ?? NSScreen.screens.first?.visibleFrame ?? .zero
    }

    private func updateConfiguration() {
        edgeReveal.setConfiguration(WorkspaceShellRevealConfiguration(pinned: effectivePinned(), held: []))
    }

    private func relayout() {
        let screen = currentScreen()
        let pinned = effectivePinned()
        let layout = WorkspaceShellLayoutCalculator.layout(
            in: screen,
            configuration: WorkspaceShellLayoutConfiguration(sidebarWidth: sidebarWidth),
            pinned: pinned
        )
        overlay.apply(layout: layout)
        edgeReveal.update(
            screen: screen,
            descriptors: [
                WorkspaceShellRevealDescriptor(surface: .sidebar, edge: .left, frame: layout.sidebar),
                WorkspaceShellRevealDescriptor(surface: .topBar, edge: .top, frame: layout.topBar),
                WorkspaceShellRevealDescriptor(surface: .dockEnrichment, edge: .bottom, frame: layout.dockEnrichment),
            ],
            configuration: WorkspaceShellRevealConfiguration(pinned: pinned, held: [])
        )
    }

    private func observeScreenChanges() {
        screenObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                DockDisplayMonitorCache.shared.refreshFromScreens()
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
                // The active Desktop changed; if the strip is showing, re-snapshot so the active-pill
                // highlight and per-desktop grouping follow.
                self?.dockPresenter?.refreshIfVisible()
            }
        }
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
        dockPresenter = DockEnrichmentPresenter(reader: DockAppSnapshotReader(), renderer: dockPanel)
        DockDisplayMonitorCache.shared.refreshFromScreens()
    }

    /// The workspace assigned to a Desktop's Space id, for the dock pill label. Nil when unassigned.
    private func workspaceName(forSpaceID spaceID: UInt64?) -> String? {
        guard let spaceID,
              let workspace = session?.store.workspaces.first(where: { $0.desktopAssignment?.spaceID == spaceID })
        else { return nil }
        return workspace.name
    }

    /// The donor sidebar (minus the left-behind activity/dock/mode areas): the workspace switcher on
    /// top, a divider, the active-workspace title header with text-zoom −/+ and the sidebar pin, and
    /// the file tree filling the rest — with a right-edge hairline and a drag-resize handle over it.
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
        filePane.view.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(filePane.view)

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

            sidebarTitleLabel.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 14),
            sidebarTitleLabel.trailingAnchor.constraint(equalTo: zoomOutButton.leadingAnchor, constant: -6),
            sidebarTitleLabel.topAnchor.constraint(equalTo: divider.bottomAnchor, constant: 8),

            zoomOutButton.trailingAnchor.constraint(equalTo: zoomInButton.leadingAnchor, constant: -2),
            zoomOutButton.centerYAnchor.constraint(equalTo: sidebarTitleLabel.centerYAnchor),
            zoomInButton.trailingAnchor.constraint(equalTo: sidebarPinButton.leadingAnchor, constant: -2),
            zoomInButton.centerYAnchor.constraint(equalTo: sidebarTitleLabel.centerYAnchor),
            sidebarPinButton.trailingAnchor.constraint(equalTo: edge.leadingAnchor, constant: -6),
            sidebarPinButton.centerYAnchor.constraint(equalTo: sidebarTitleLabel.centerYAnchor),

            filePane.view.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            filePane.view.trailingAnchor.constraint(equalTo: edge.leadingAnchor),
            filePane.view.topAnchor.constraint(equalTo: sidebarTitleLabel.bottomAnchor, constant: 8),
            filePane.view.bottomAnchor.constraint(equalTo: content.bottomAnchor),

            edge.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            edge.topAnchor.constraint(equalTo: content.topAnchor),
            edge.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            edge.widthAnchor.constraint(equalToConstant: 1),

            resizeHandle.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            resizeHandle.topAnchor.constraint(equalTo: content.topAnchor),
            resizeHandle.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            resizeHandle.widthAnchor.constraint(equalToConstant: 8),
        ])
    }

    /// Top bar: Agents on the left; the terminal chips + top-bar pin ride the right edge, matching the
    /// donor's trailing cluster [PTY Manager] [＋ Terminal] [pin]. A low-hugging spacer pushes the
    /// chips to the right so they sit rightmost, next to the pin.
    private func buildTopBar() {
        let agentsButton = NSButton(title: "Agents", target: self, action: #selector(agentsTapped))
        agentsButton.setAccessibilityIdentifier("workspace-shell-agents")
        let ptyManagerButton = NSButton(title: "PTY Manager", target: self, action: #selector(openPtyManagerTapped))
        ptyManagerButton.setAccessibilityIdentifier("open-pty-manager")
        let terminalButton = NSButton(title: "＋ Terminal", target: self, action: #selector(openTerminalTapped))
        terminalButton.setAccessibilityIdentifier("open-terminal")
        configureIconButton(topBarPinButton, symbol: "pin", id: "toggle-topbar-pin", label: "Pin top bar", action: #selector(topBarPinTapped))
        applyPinGlyph(topBarPinButton, pinned: false)

        let spacer = NSView()
        spacer.translatesAutoresizingMaskIntoConstraints = false
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        spacer.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let topBarStack = NSStackView(views: [agentsButton, spacer, ptyManagerButton, terminalButton, topBarPinButton])
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

    @objc private func agentsTapped() { onAgentsCommand?() }

    @objc private func openTerminalTapped() { onOpenTerminal?() }

    @objc private func openPtyManagerTapped() { onOpenPtyManager?() }

    private func showPtyManager() {
        let controller = ptyManagerWindow ?? PtyManagerWindowController()
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
        sidebarTitleLabel.stringValue = (session?.store.active?.name).map { $0.uppercased() } ?? "WORKSPACE"
    }

    // MARK: - AX self-report

    private func logAXSelfReport() {
        let ids = axIdentifiers(in: overlay.sidebarContentView)
            .union(axIdentifiers(in: overlay.topBarContentView))
            .union(axIdentifiers(in: overlay.dockContentView))
        let expected = [
            "workspace-shell-agents", "open-terminal", "open-pty-manager",
            "workspace-switcher", "add-workspace", "workspace-shell-title",
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
