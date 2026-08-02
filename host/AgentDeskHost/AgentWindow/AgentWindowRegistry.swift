import AgentDeskWire
import AppKit
import CoreGraphics
import PtyClientSwift

struct AgentWindowPlacement: Equatable {
    let desktopSpaceID: UInt64?
    let frame: CGRect
}

@MainActor
protocol AgentWindowControlling: AnyObject {
    /// `activating` is false for the launch restore, matching the IDE window: the host starts at
    /// login, and a window that takes focus out from under whatever you were doing is worse than no
    /// restore at all.
    func show(activating: Bool)

    /// Reports the window's frame whenever the user moves or resizes it, and its terminal pane's
    /// attachment as that opens and closes, so the registry keeps the remembered presentation
    /// current without polling and without depending on a clean exit to write it.
    func observePresentation(
        frameChanged: @escaping (CGRect) -> Void,
        terminalChanged: @escaping (AgentWindowTerminalAttachment?) -> Void
    )

    /// Reopens the terminal pane against an attachment a previous host run left behind.
    func resumeTerminal(_ attachment: AgentWindowTerminalAttachment)

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
        _ frame: CGRect,
        _ endpoint: AgentSessionTerminalEndpoint,
        _ onClosed: @escaping @MainActor () -> Void
    ) -> any AgentWindowControlling

    private struct Entry {
        let desktopSpaceID: UInt64?
        let cascadeOrdinal: Int
        let endpoint: AgentSessionTerminalEndpoint
        let controller: any AgentWindowControlling
        var frame: CGRect
        var terminal: AgentWindowTerminalAttachment?
    }

    private let store: AgentWindowPresentationStore
    private let endpointFactory: EndpointFactory
    private let controllerFactory: ControllerFactory
    private let cascadeStep: CGFloat
    private let framePersistDelay: Duration
    private var entries: [UUID: Entry] = [:]
    private var endpointShutdownTasks: [UUID: Task<Void, Never>] = [:]
    private var frameTasks: [UUID: Task<Void, Never>] = [:]
    private var stopTask: Task<Void, Never>?
    private var hasRestored = false
    private var shuttingDown = false

    init(
        store: AgentWindowPresentationStore,
        cascadeStep: CGFloat = 24,
        framePersistDelay: Duration = .milliseconds(200),
        endpointFactory: @escaping EndpointFactory,
        controllerFactory: @escaping ControllerFactory
    ) {
        self.store = store
        self.cascadeStep = cascadeStep
        self.framePersistDelay = framePersistDelay
        self.endpointFactory = endpointFactory
        self.controllerFactory = controllerFactory
    }

    convenience init(
        store: AgentWindowPresentationStore,
        sidecarClient: any SidecarClient,
        terminalCoordinator: any AgentSessionTerminalCoordinating,
        terminalTombstoneLimit: Int,
        makeTerminalPtyClient: @escaping @MainActor () -> PtyClient
    ) {
        self.init(
            store: store,
            endpointFactory: { id in
                AgentSessionTerminalEndpoint(
                    coordinator: terminalCoordinator,
                    platform: .macOS,
                    requestNamespace: "macos-agent-window-\(id.uuidString)",
                    tombstoneLimit: terminalTombstoneLimit
                )
            },
            controllerFactory: { _, frame, endpoint, onClosed in
                AgentWindowController(
                    sidecarClient: sidecarClient,
                    localTerminalEndpoint: endpoint,
                    terminalPtyClient: makeTerminalPtyClient(),
                    initialFrame: frame,
                    onClosed: onClosed
                )
            }
        )
    }

    var requiresTerminationWait: Bool {
        !entries.isEmpty || !endpointShutdownTasks.isEmpty || stopTask != nil
    }
    var openWindowCountForTesting: Int { entries.count }

    func open(_ placement: AgentWindowPlacement) {
        guard !shuttingDown else { return }
        let usedCascadeOrdinals = Set(entries.values.compactMap { entry in
            entry.desktopSpaceID == placement.desktopSpaceID ? entry.cascadeOrdinal : nil
        })
        var cascadeOrdinal = 0
        while usedCascadeOrdinals.contains(cascadeOrdinal) {
            cascadeOrdinal += 1
        }
        openWindow(
            id: UUID(),
            desktopSpaceID: placement.desktopSpaceID,
            cascadeOrdinal: cascadeOrdinal,
            frame: placement.frame.offsetBy(
                dx: CGFloat(cascadeOrdinal) * cascadeStep,
                dy: CGFloat(-cascadeOrdinal) * cascadeStep
            ),
            activating: true
        )
    }

    /// Puts back every Agents window that was on screen when the host last quit, at the frame it
    /// was left at and without taking focus. Called once at launch; windows the user closed
    /// themselves are already gone from the store and stay gone.
    func startRestoration(visibleFrames: [CGRect] = NSScreen.screens.map(\.visibleFrame)) {
        guard !shuttingDown, !hasRestored else { return }
        hasRestored = true
        for descriptor in store.descriptors where entries[descriptor.id] == nil {
            openWindow(
                id: descriptor.id,
                desktopSpaceID: descriptor.desktopSpaceID,
                cascadeOrdinal: descriptor.cascadeOrdinal,
                // The display setup can change between runs, so a remembered frame is only a
                // proposal until it is checked against the screens that actually exist now.
                frame: AgentWindowScreenPlacement.constrained(
                    descriptor.frame.cgRect,
                    within: visibleFrames
                ),
                terminal: descriptor.terminal,
                activating: false
            )
        }
    }

    private func openWindow(
        id: UUID,
        desktopSpaceID: UInt64?,
        cascadeOrdinal: Int,
        frame: CGRect,
        terminal: AgentWindowTerminalAttachment? = nil,
        activating: Bool
    ) {
        let endpoint = endpointFactory(id)
        let controller = controllerFactory(id, frame, endpoint) { [weak self] in
            self?.removeWindow(id)
        }
        entries[id] = Entry(
            desktopSpaceID: desktopSpaceID,
            cascadeOrdinal: cascadeOrdinal,
            endpoint: endpoint,
            controller: controller,
            frame: frame,
            terminal: terminal
        )
        persist(id: id)
        controller.observePresentation(
            frameChanged: { [weak self] frame in
                self?.scheduleFrame(frame, id: id)
            },
            terminalChanged: { [weak self] attachment in
                self?.recordTerminal(attachment, id: id)
            }
        )
        controller.show(activating: activating)
        if let terminal {
            controller.resumeTerminal(terminal)
        }
    }

    /// Coalesces a drag or resize into one write. A live drag emits a frame per event, and the
    /// store rewrites the whole document each time.
    private func scheduleFrame(_ frame: CGRect, id: UUID) {
        guard !shuttingDown else { return }
        frameTasks[id]?.cancel()
        let delay = framePersistDelay
        frameTasks[id] = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled, let self, self.entries[id] != nil else { return }
            self.entries[id]?.frame = frame
            self.persist(id: id)
            self.frameTasks[id] = nil
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
        try? store.upsert(AgentWindowPresentationDescriptor(
            id: id,
            frame: AgentWindowFrame(entry.frame),
            desktopSpaceID: entry.desktopSpaceID,
            cascadeOrdinal: entry.cascadeOrdinal,
            terminal: entry.terminal
        ))
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
        for task in frameTasks.values { task.cancel() }
        frameTasks.removeAll()
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
        frameTasks.removeValue(forKey: id)?.cancel()
        // Only a window the user closed forfeits its place, and with it the agent terminal it was
        // running; on the way out every window closes without meaning to.
        guard !shuttingDown else { return }
        try? store.remove(id: id)
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
