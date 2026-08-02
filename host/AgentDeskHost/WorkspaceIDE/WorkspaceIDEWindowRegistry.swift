import AppKit
import CoreGraphics
import OSLog
import WorkspaceIDE

@MainActor
protocol WorkspaceIDEWindowControlling: AnyObject {
    func show(activating: Bool)
    func observePlacement(_ changed: @escaping (WorkspaceWindowPlacement) -> Void)
    func stop()
    func discardLocalPersistence()
}

@MainActor
final class WorkspaceIDEWindowRegistry {
    typealias EndpointFactory = @MainActor (UUID) -> WorkspaceTerminalEndpoint
    typealias ControllerFactory = @MainActor (
        _ id: UUID,
        _ placement: WorkspaceWindowPlacement,
        _ localStateStore: WorkspaceIDEWindowLocalStateStore,
        _ terminalStore: WorkspaceIDETerminalWorkspaceStore,
        _ endpoint: WorkspaceTerminalEndpoint,
        _ onClosed: @escaping @MainActor () -> Void
    ) -> any WorkspaceIDEWindowControlling

    private struct Entry {
        let cascadeOrdinal: Int
        let controller: any WorkspaceIDEWindowControlling
        let endpoint: WorkspaceTerminalEndpoint
        var placement: WorkspaceWindowPlacement
        var localState: WorkspaceIDELocalState
    }

    private let store: WorkspaceIDEWindowPresentationStore
    private let endpointFactory: EndpointFactory
    private let controllerFactory: ControllerFactory
    private let cascadeStep: CGFloat
    private let persistDelay: Duration
    private let logger = Logger(subsystem: Config.logSubsystem, category: "workspace-ide-window")
    private var entries: [UUID: Entry] = [:]
    private var persistTasks: [UUID: Task<Void, Never>] = [:]
    private var endpointShutdownTasks: [UUID: Task<Void, Never>] = [:]
    private var stopTask: Task<Void, Never>?
    private var hasRestored = false
    private var isStopping = false

    init(
        store: WorkspaceIDEWindowPresentationStore,
        cascadeStep: CGFloat = 28,
        persistDelay: Duration = .milliseconds(200),
        endpointFactory: @escaping EndpointFactory,
        controllerFactory: @escaping ControllerFactory
    ) {
        self.store = store
        self.cascadeStep = cascadeStep
        self.persistDelay = persistDelay
        self.endpointFactory = endpointFactory
        self.controllerFactory = controllerFactory
    }

    var requiresTerminationWait: Bool {
        !entries.isEmpty || !endpointShutdownTasks.isEmpty || stopTask != nil
    }

    var openWindowCountForTesting: Int { entries.count }

    func open(_ placement: WorkspaceWindowPlacement) {
        guard !isStopping else { return }
        let usedOrdinals = Set(entries.values.compactMap { entry in
            entry.placement.desktop.spaceID == placement.desktop.spaceID ? entry.cascadeOrdinal : nil
        })
        var cascadeOrdinal = 0
        while usedOrdinals.contains(cascadeOrdinal) { cascadeOrdinal += 1 }
        openWindow(
            id: UUID(),
            placement: WorkspaceWindowPlacement(
                desktop: placement.desktop,
                frame: placement.frame.offsetBy(
                    dx: CGFloat(cascadeOrdinal) * cascadeStep,
                    dy: CGFloat(-cascadeOrdinal) * cascadeStep
                )
            ),
            cascadeOrdinal: cascadeOrdinal,
            localState: WorkspaceIDELocalState(),
            activating: true
        )
    }

    func startRestoration(visibleFrames: [CGRect] = NSScreen.screens.map(\.visibleFrame)) {
        guard !isStopping, !hasRestored else { return }
        hasRestored = true
        for descriptor in store.descriptors where entries[descriptor.id] == nil {
            openWindow(
                id: descriptor.id,
                placement: WorkspaceWindowPlacement(
                    desktop: descriptor.placement.desktop,
                    frame: DesktopWindowScreenPlacement.constrained(
                        descriptor.placement.frame,
                        within: visibleFrames
                    )
                ),
                cascadeOrdinal: descriptor.cascadeOrdinal,
                localState: descriptor.localState,
                activating: false
            )
        }
    }

    func handleCoordinatorEvent(_ event: WorkspaceTerminalCoordinatorEvent) async {
        for endpoint in entries.values.map(\.endpoint) {
            await endpoint.handleCoordinatorEvent(event)
        }
    }

    @discardableResult
    func beginStopAll() -> Task<Void, Never> {
        if let stopTask { return stopTask }
        isStopping = true
        for task in persistTasks.values { task.cancel() }
        persistTasks.removeAll()
        for id in entries.keys { persist(id: id) }
        let stoppingEntries = Array(entries.values)
        for entry in stoppingEntries { entry.controller.stop() }
        let existingShutdowns = Array(endpointShutdownTasks.values)
        let task = Task { @MainActor in
            for entry in stoppingEntries { await entry.endpoint.shutdown() }
            for shutdown in existingShutdowns { await shutdown.value }
        }
        stopTask = task
        return task
    }

    private func openWindow(
        id: UUID,
        placement: WorkspaceWindowPlacement,
        cascadeOrdinal: Int,
        localState: WorkspaceIDELocalState,
        activating: Bool
    ) {
        let endpoint = endpointFactory(id)
        let localStateStore = WorkspaceIDEWindowLocalStateStore(state: localState)
        let controller = controllerFactory(
            id,
            placement,
            localStateStore,
            WorkspaceIDETerminalWorkspaceStore(windowID: id),
            endpoint
        ) { [weak self] in
            self?.removeWindow(id)
        }
        entries[id] = Entry(
            cascadeOrdinal: cascadeOrdinal,
            controller: controller,
            endpoint: endpoint,
            placement: placement,
            localState: localState
        )
        localStateStore.onSave = { [weak self] state in
            self?.recordLocalState(state, id: id)
        }
        controller.observePlacement { [weak self] placement in
            self?.recordPlacement(placement, id: id)
        }
        persist(id: id)
        controller.show(activating: activating)
    }

    private func recordPlacement(_ placement: WorkspaceWindowPlacement, id: UUID) {
        guard !isStopping, entries[id] != nil else { return }
        entries[id]?.placement = placement
        schedulePersist(id: id)
    }

    private func recordLocalState(_ state: WorkspaceIDELocalState, id: UUID) {
        guard !isStopping, entries[id]?.localState != state else { return }
        entries[id]?.localState = state
        schedulePersist(id: id)
    }

    private func schedulePersist(id: UUID) {
        persistTasks[id]?.cancel()
        let delay = persistDelay
        persistTasks[id] = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled, let self, self.entries[id] != nil else { return }
            self.persist(id: id)
            self.persistTasks[id] = nil
        }
    }

    private func persist(id: UUID) {
        guard let entry = entries[id] else { return }
        do {
            try store.upsert(WorkspaceIDEWindowPresentationDescriptor(
                id: id,
                placement: entry.placement,
                cascadeOrdinal: entry.cascadeOrdinal,
                localState: entry.localState
            ))
        } catch {
            logger.error("Workspace IDE presentation persist failed: \(String(describing: error), privacy: .public)")
        }
    }

    private func removeWindow(_ id: UUID) {
        guard let entry = entries.removeValue(forKey: id) else { return }
        persistTasks.removeValue(forKey: id)?.cancel()
        guard !isStopping else { return }
        do {
            try store.remove(id: id)
            entry.controller.discardLocalPersistence()
        } catch {
            logger.error("Workspace IDE presentation removal failed: \(String(describing: error), privacy: .public)")
        }
        let task = Task { await entry.endpoint.shutdown() }
        endpointShutdownTasks[id] = task
        Task { @MainActor [weak self] in
            await task.value
            self?.endpointShutdownTasks.removeValue(forKey: id)
        }
    }
}
