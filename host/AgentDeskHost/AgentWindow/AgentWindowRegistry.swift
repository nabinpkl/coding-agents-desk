import AgentDeskWire
import AppKit
import CoreGraphics
import PtyClientSwift
import OSLog

@MainActor
protocol AgentWindowControlling: AnyObject {
    /// `activating` is false for the launch restore, matching the IDE window: the host starts at
    /// login, and a window that takes focus out from under whatever you were doing is worse than no
    /// restore at all.
    func show(activating: Bool)

    /// Reports the window's frame whenever the user moves or resizes it, its terminal pane's
    /// attachment as that opens and closes, and its zoom step as the user changes it, so the
    /// registry keeps the remembered presentation current without polling and without depending on
    /// a clean exit to write it.
    func observePresentation(
        placementChanged: @escaping (WorkspaceWindowPlacement) -> Void,
        terminalChanged: @escaping (AgentWindowTerminalAttachment?) -> Void,
        zoomChanged: @escaping (Int) -> Void
    )

    /// Reopens the terminal pane against an attachment a previous host run left behind.
    func resumeTerminal(_ attachment: AgentWindowTerminalAttachment)

    /// Brings an already-open window forward and gives it key status. Whether the window's Desktop is
    /// the active one is settled before this runs; a window can only be raised within its own Space.
    func focus()

    /// Closes on the user's behalf, along the same path as clicking the window's own close button:
    /// the agent terminal ENDS rather than detaching, and the window forfeits its stored placement.
    /// Distinct from `beginStop`, which is host termination and preserves both.
    func beginUserClose()

    @discardableResult
    func beginStop() -> Task<Void, Never>
}

/// Owns the independent macOS Agents windows and their terminal endpoints. A window is created for
/// the Desktop that issued the top-bar command, then discarded when the user closes it. Feed state,
/// terminal request identity, and push routing are never shared between windows.
@MainActor
final class AgentWindowRegistry {
    typealias EndpointFactory = @MainActor (UUID) -> AgentSessionTerminalEndpoint
    typealias ControllerFactory = @MainActor (
        _ id: UUID,
        _ placement: WorkspaceWindowPlacement,
        _ zoomStep: Int,
        _ endpoint: AgentSessionTerminalEndpoint,
        _ onClosed: @escaping @MainActor () -> Void
    ) -> any AgentWindowControlling
    /// Makes one Desktop the active one and answers whether it got there. Injected rather than
    /// reached for so the registry can be tested without a live WindowServer, and left nil when the
    /// host has no Spaces authority at all, in which case a listed window is raised where it stands.
    typealias DesktopActivating = @MainActor (WorkspaceDesktopAssignment) async -> Bool

    private struct Entry {
        let cascadeOrdinal: Int
        let endpoint: AgentSessionTerminalEndpoint
        let controller: any AgentWindowControlling
        var placement: WorkspaceWindowPlacement
        var terminal: AgentWindowTerminalAttachment?
        var zoomStep: Int
    }

    private let store: AgentWindowPresentationStore
    private let endpointFactory: EndpointFactory
    private let controllerFactory: ControllerFactory
    private let activateDesktop: DesktopActivating?
    private let cascadeStep: CGFloat
    private let presentationPersistDelay: Duration
    private let logger = Logger(subsystem: Config.logSubsystem, category: "agent-window")
    private var entries: [UUID: Entry] = [:]
    private var endpointShutdownTasks: [UUID: Task<Void, Never>] = [:]
    private var persistTasks: [UUID: Task<Void, Never>] = [:]
    private var stopTask: Task<Void, Never>?
    private var hasRestored = false
    private var hasResumedStoredTerminals = false
    private var shuttingDown = false

    init(
        store: AgentWindowPresentationStore,
        cascadeStep: CGFloat = 24,
        presentationPersistDelay: Duration = .milliseconds(200),
        activateDesktop: DesktopActivating? = nil,
        endpointFactory: @escaping EndpointFactory,
        controllerFactory: @escaping ControllerFactory
    ) {
        self.store = store
        self.cascadeStep = cascadeStep
        self.presentationPersistDelay = presentationPersistDelay
        self.activateDesktop = activateDesktop
        self.endpointFactory = endpointFactory
        self.controllerFactory = controllerFactory
    }

    convenience init(
        store: AgentWindowPresentationStore,
        sidecarClient: any SidecarClient,
        terminalCoordinator: any AgentSessionTerminalCoordinating,
        terminalTombstoneLimit: Int,
        makeTerminalPtyClient: @escaping @MainActor () -> PtyClient,
        placementCoordinator: DesktopWindowPlacementCoordinator,
        composerCoordinator: AgentWindowComposerCoordinator,
        desktopSwitcher: WorkspaceDesktopSwitcher
    ) {
        self.init(
            store: store,
            // Waits for the Space to actually be the active one rather than for the gesture to be
            // accepted: raising a window while the transition is still in flight lands it behind
            // whatever the Desktop settles on.
            activateDesktop: { desktop in
                let confirmation = try? await desktopSwitcher.switchToDesktopAndWait(
                    spaceID: desktop.spaceID,
                    displayID: desktop.displayID
                )
                return confirmation == .reached
            },
            endpointFactory: { id in
                AgentSessionTerminalEndpoint(
                    coordinator: terminalCoordinator,
                    platform: .macOS,
                    requestNamespace: "macos-agent-window-\(id.uuidString)",
                    tombstoneLimit: terminalTombstoneLimit
                )
            },
            controllerFactory: { id, placement, zoomStep, endpoint, onClosed in
                AgentWindowController(
                    sidecarClient: sidecarClient,
                    localTerminalEndpoint: endpoint,
                    terminalPtyClient: makeTerminalPtyClient(),
                    initialPlacement: placement,
                    placementCoordinator: placementCoordinator,
                    composerCoordinator: composerCoordinator,
                    // Per window, not per registry: two Agents windows are two panels, each with its
                    // own watches, and a shared id would send one's status to the other.
                    composerSinkID: "agents-window-\(id.uuidString)",
                    initialZoomStep: zoomStep,
                    onClosed: onClosed
                )
            }
        )
    }

    var requiresTerminationWait: Bool {
        !entries.isEmpty || !endpointShutdownTasks.isEmpty || stopTask != nil
    }
    var openWindowCountForTesting: Int { entries.count }

    /// The open windows, for a chooser that lists them.
    ///
    /// Ordered by Desktop and then by the window's place in its Desktop's cascade, because the
    /// backing storage is a dictionary and an order that reshuffled between openings would move the
    /// row under the pointer between the moment it is read and the moment it is clicked.
    var openWindows: [AgentWindowSummary] {
        entries
            .map { id, entry in
                AgentWindowSummary(
                    id: id,
                    desktopOrdinal: entry.placement.desktop.ordinal,
                    cascadeOrdinal: entry.cascadeOrdinal
                )
            }
            .sorted { left, right in
                (left.desktopOrdinal, left.cascadeOrdinal, left.id.uuidString)
                    < (right.desktopOrdinal, right.cascadeOrdinal, right.id.uuidString)
            }
    }

    /// Brings one listed window to the user: switches to the Desktop it lives on, then raises it
    /// there. The two halves are in that order because a window cannot be raised onto a Desktop it is
    /// not on, and this is the one place that knows which Desktop that is.
    func focusWindow(id: UUID) {
        guard !shuttingDown, let entry = entries[id] else { return }
        guard let activateDesktop else {
            entry.controller.focus()
            return
        }
        let desktop = entry.placement.desktop
        Task { @MainActor [weak self] in
            let reached = await activateDesktop(desktop)
            // Re-read: the switch is a real wait, and the window can be closed from its own titlebar
            // while the Desktop is still animating.
            guard let self, !self.shuttingDown, let entry = self.entries[id] else { return }
            if !reached {
                // Raised anyway. The window may already be reachable (the switch is also refused
                // when Spaces cannot be read at all), and refusing to act on the click would leave
                // the user with a silent no-op instead of a window they can look for.
                self.logger.error(
                    "agents-window focus: Desktop \(desktop.ordinal + 1, privacy: .public) on display \(desktop.displayID, privacy: .public) did not become active"
                )
            }
            entry.controller.focus()
        }
    }

    /// Closes one window as if the user had clicked its own close button. Unknown ids are ignored
    /// rather than trapped: a chooser can only ever hold the list as it was when it was opened, and
    /// the window may have been closed from its own titlebar since.
    func closeWindow(id: UUID) {
        guard !shuttingDown, let entry = entries[id] else { return }
        entry.controller.beginUserClose()
    }

    func open(_ placement: WorkspaceWindowPlacement) {
        guard !shuttingDown else { return }
        let usedCascadeOrdinals = Set(entries.values.compactMap { entry in
            entry.placement.desktop.spaceID == placement.desktop.spaceID ? entry.cascadeOrdinal : nil
        })
        var cascadeOrdinal = 0
        while usedCascadeOrdinals.contains(cascadeOrdinal) {
            cascadeOrdinal += 1
        }
        openWindow(
            id: UUID(),
            cascadeOrdinal: cascadeOrdinal,
            placement: WorkspaceWindowPlacement(
                desktop: placement.desktop,
                frame: placement.frame.offsetBy(
                    dx: CGFloat(cascadeOrdinal) * cascadeStep,
                    dy: CGFloat(-cascadeOrdinal) * cascadeStep
                )
            ),
            activating: true
        )
    }

    /// Puts back every Agents window that was on screen when the host last quit, at the frame it
    /// was left at and without taking focus. Called once at launch; windows the user closed
    /// themselves are already gone from the store and stay gone.
    func startRestoration(
        visibleFrames: [CGRect] = NSScreen.screens.map(\.visibleFrame),
        resumeTerminals: Bool = true
    ) {
        guard !shuttingDown, !hasRestored else { return }
        hasRestored = true
        hasResumedStoredTerminals = resumeTerminals
        for descriptor in store.descriptors where entries[descriptor.id] == nil {
            openWindow(
                id: descriptor.id,
                cascadeOrdinal: descriptor.cascadeOrdinal,
                // The display setup can change between runs, so a remembered frame is only a
                // proposal until it is checked against the screens that actually exist now.
                placement: WorkspaceWindowPlacement(
                    desktop: descriptor.placement.desktop,
                    frame: DesktopWindowScreenPlacement.constrained(
                        descriptor.placement.frame,
                        within: visibleFrames
                    )
                ),
                terminal: descriptor.terminal,
                zoomStep: descriptor.zoomStep,
                activating: false,
                resumeTerminal: resumeTerminals
            )
        }
    }

    /// Window reconstruction does not depend on the PTY runtime. AppDelegate calls this once the
    /// runtime answers so remembered terminal panes can reattach without withholding their Agents
    /// windows during startup.
    func resumeStoredTerminals() {
        guard !shuttingDown, !hasResumedStoredTerminals else { return }
        hasResumedStoredTerminals = true
        for entry in entries.values {
            if let terminal = entry.terminal {
                entry.controller.resumeTerminal(terminal)
            }
        }
    }

    private func openWindow(
        id: UUID,
        cascadeOrdinal: Int,
        placement: WorkspaceWindowPlacement,
        terminal: AgentWindowTerminalAttachment? = nil,
        zoomStep: Int = 0,
        activating: Bool,
        resumeTerminal: Bool = true
    ) {
        let endpoint = endpointFactory(id)
        let controller = controllerFactory(id, placement, zoomStep, endpoint) { [weak self] in
            self?.removeWindow(id)
        }
        entries[id] = Entry(
            cascadeOrdinal: cascadeOrdinal,
            endpoint: endpoint,
            controller: controller,
            placement: placement,
            terminal: terminal,
            zoomStep: zoomStep
        )
        persist(id: id)
        controller.observePresentation(
            placementChanged: { [weak self] placement in
                self?.schedulePlacement(placement, id: id)
            },
            terminalChanged: { [weak self] attachment in
                self?.recordTerminal(attachment, id: id)
            },
            zoomChanged: { [weak self] step in
                self?.scheduleZoom(step, id: id)
            }
        )
        controller.show(activating: activating)
        if let terminal, resumeTerminal {
            controller.resumeTerminal(terminal)
        }
    }

    private func schedulePlacement(_ placement: WorkspaceWindowPlacement, id: UUID) {
        guard !shuttingDown, entries[id] != nil else { return }
        entries[id]?.placement = placement
        schedulePersist(id: id)
    }

    private func scheduleZoom(_ step: Int, id: UUID) {
        guard !shuttingDown, entries[id]?.zoomStep != step else { return }
        entries[id]?.zoomStep = step
        schedulePersist(id: id)
    }

    /// Coalesces a burst into one write. A live drag emits a frame per event and a held zoom key
    /// emits a step per repeat, and the store rewrites the whole document each time.
    ///
    /// One task per window rather than one per field: both describe the same descriptor, so a drag
    /// and a zoom that overlap should land as one write instead of racing to be last. The value is
    /// taken at report time and only the WRITE is deferred, so a cancelled task never loses a
    /// change -- the next one persists everything recorded since.
    private func schedulePersist(id: UUID) {
        persistTasks[id]?.cancel()
        let delay = presentationPersistDelay
        persistTasks[id] = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled, let self, self.entries[id] != nil else { return }
            self.persist(id: id)
            self.persistTasks[id] = nil
        }
    }

    /// Written straight through rather than debounced: a terminal opens or closes once, and the
    /// write has to already be on disk if the host is killed rather than quit.
    private func recordTerminal(_ attachment: AgentWindowTerminalAttachment?, id: UUID) {
        guard !shuttingDown, entries[id]?.terminal != attachment else { return }
        entries[id]?.terminal = attachment
        persist(id: id)
    }

    private func persist(id: UUID) {
        guard let entry = entries[id] else { return }
        do {
            try store.upsert(AgentWindowPresentationDescriptor(
                id: id,
                placement: entry.placement,
                cascadeOrdinal: entry.cascadeOrdinal,
                terminal: entry.terminal,
                zoomStep: entry.zoomStep
            ))
        } catch {
            logger.error("Agents window presentation persist failed: \(String(describing: error), privacy: .public)")
        }
    }

    func handleCoordinatorEvent(_ event: AgentSessionTerminalCoordinatorEvent) async {
        let endpoints = entries.values.map(\.endpoint)
        for endpoint in endpoints {
            await endpoint.handleCoordinatorEvent(event)
        }
    }

    @discardableResult
    func beginStopAll() -> Task<Void, Never> {
        if let stopTask { return stopTask }
        // Set before any close runs, and not derived from `stopTask` (assigned at the end of this
        // function): this is what makes a restart different from the user closing a window. From
        // here on `removeWindow` keeps the stored placement instead of clearing it, so quitting
        // does not erase the very state this restores.
        shuttingDown = true
        // Flushed, not just cancelled. The entries already hold every reported value, so writing
        // them here is what makes the debounce window safe to quit inside -- a zoom keystroke or a
        // drag in the last fraction of a second would otherwise be dropped by the cancel below,
        // which is exactly the state a restart is supposed to bring back.
        for task in persistTasks.values { task.cancel() }
        persistTasks.removeAll()
        for id in entries.keys { persist(id: id) }
        let entries = Array(entries.values)
        let controllerTasks = entries.map { $0.controller.beginStop() }
        let existingEndpointShutdownTasks = Array(endpointShutdownTasks.values)
        let task = Task { @MainActor in
            for controllerTask in controllerTasks {
                await controllerTask.value
            }
            for entry in entries {
                await entry.endpoint.shutdownPreservingSessions()
            }
            for endpointShutdownTask in existingEndpointShutdownTasks {
                await endpointShutdownTask.value
            }
        }
        stopTask = task
        return task
    }

    private func removeWindow(_ id: UUID) {
        guard let entry = entries.removeValue(forKey: id) else { return }
        persistTasks.removeValue(forKey: id)?.cancel()
        // Only a window the user closed forfeits its place, and with it the agent terminal it was
        // running; on the way out every window closes without meaning to.
        guard !shuttingDown else { return }
        do {
            try store.remove(id: id)
        } catch {
            logger.error("Agents window presentation removal failed: \(String(describing: error), privacy: .public)")
        }
        let task = Task {
            await entry.endpoint.shutdown()
        }
        endpointShutdownTasks[id] = task
        Task { @MainActor [weak self] in
            await task.value
            self?.endpointShutdownTasks.removeValue(forKey: id)
        }
    }
}
