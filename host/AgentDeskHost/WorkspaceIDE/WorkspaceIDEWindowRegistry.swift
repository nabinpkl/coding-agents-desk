import AppKit
import CoreGraphics
import OSLog

@MainActor
protocol WorkspaceIDEWindowControlling: AnyObject {
    func show(activating: Bool)
    func observePlacement(_ changed: @escaping (WorkspaceWindowPlacement) -> Void)

    /// Brings an already-open window forward and gives it key status. Whether the window's Desktop is
    /// the active one is settled before this runs; a window can only be raised within its own Space.
    func focus()

    /// Closes on the user's behalf, along the same path as clicking the window's own close button:
    /// the window forfeits its stored placement. Distinct from `stop`, which is host termination
    /// and preserves it for the next launch.
    func beginUserClose()

    func stop()
}

@MainActor
final class WorkspaceIDEWindowRegistry {
    typealias ControllerFactory = @MainActor (
        _ id: UUID,
        _ placement: WorkspaceWindowPlacement,
        _ onClosed: @escaping @MainActor () -> Void
    ) -> any WorkspaceIDEWindowControlling

    private struct Entry {
        let cascadeOrdinal: Int
        let controller: any WorkspaceIDEWindowControlling
        var placement: WorkspaceWindowPlacement
    }

    private let store: WorkspaceIDEWindowPresentationStore
    private let controllerFactory: ControllerFactory
    private let activateDesktop: DesktopActivating?
    private let cascadeStep: CGFloat
    private let persistDelay: Duration
    private let logger = Logger(subsystem: Config.logSubsystem, category: "workspace-ide-window")
    private var entries: [UUID: Entry] = [:]
    private var persistTasks: [UUID: Task<Void, Never>] = [:]
    private var stopTask: Task<Void, Never>?
    private var hasRestored = false
    private var isStopping = false

    init(
        store: WorkspaceIDEWindowPresentationStore,
        cascadeStep: CGFloat = 28,
        persistDelay: Duration = .milliseconds(200),
        activateDesktop: DesktopActivating? = nil,
        controllerFactory: @escaping ControllerFactory
    ) {
        self.store = store
        self.cascadeStep = cascadeStep
        self.persistDelay = persistDelay
        self.activateDesktop = activateDesktop
        self.controllerFactory = controllerFactory
    }

    var requiresTerminationWait: Bool {
        !entries.isEmpty || stopTask != nil
    }

    var openWindowCountForTesting: Int { entries.count }

    /// The open windows, for a chooser that lists them.
    ///
    /// Ordered by Desktop and then by the window's place in its Desktop's cascade, because the
    /// backing storage is a dictionary and an order that reshuffled between openings would move the
    /// row under the pointer between the moment it is read and the moment it is clicked.
    var openWindows: [WorkspaceWindowSummary] {
        entries
            .map { id, entry in
                WorkspaceWindowSummary(
                    id: id,
                    kind: .ide,
                    desktopOrdinal: entry.placement.desktop.ordinal,
                    cascadeOrdinal: entry.cascadeOrdinal
                )
            }
            .sorted { left, right in
                (left.desktopOrdinal, left.cascadeOrdinal, left.id.uuidString)
                    < (right.desktopOrdinal, right.cascadeOrdinal, right.id.uuidString)
            }
    }

    /// Brings one listed window to the user, through the reveal every family shares. The window is
    /// looked up again inside `raise`, after the Desktop switch has finished, because it can be closed
    /// from its own titlebar while that switch is still in flight.
    func focusWindow(id: UUID) {
        guard !isStopping, let entry = entries[id] else { return }
        WorkspaceWindowReveal.reveal(
            desktop: entry.placement.desktop,
            activateDesktop: activateDesktop,
            logger: logger,
            family: "workspace-ide-window"
        ) { [weak self] in
            guard let self, !self.isStopping else { return }
            self.entries[id]?.controller.focus()
        }
    }

    /// Closes one window as if the user had clicked its own close button. Unknown ids are ignored
    /// rather than trapped: a chooser can only ever hold the list as it was when it was opened, and
    /// the window may have been closed from its own titlebar since.
    func closeWindow(id: UUID) {
        guard !isStopping, let entry = entries[id] else { return }
        entry.controller.beginUserClose()
    }

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
                activating: false
            )
        }
    }

    @discardableResult
    func beginStopAll() -> Task<Void, Never> {
        if let stopTask { return stopTask }
        isStopping = true
        for task in persistTasks.values { task.cancel() }
        persistTasks.removeAll()
        for id in entries.keys { persist(id: id) }
        for entry in entries.values { entry.controller.stop() }
        // Nothing is awaited any more -- the panel's own teardown is synchronous and the sidecar
        // owns everything that used to need draining -- but the task is kept so termination has one
        // handle to wait on whatever a window comes to own next.
        let task = Task { @MainActor in }
        stopTask = task
        return task
    }

    private func openWindow(
        id: UUID,
        placement: WorkspaceWindowPlacement,
        cascadeOrdinal: Int,
        activating: Bool
    ) {
        let controller = controllerFactory(id, placement) { [weak self] in
            self?.removeWindow(id)
        }
        entries[id] = Entry(
            cascadeOrdinal: cascadeOrdinal,
            controller: controller,
            placement: placement
        )
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
                cascadeOrdinal: entry.cascadeOrdinal
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
        } catch {
            logger.error("Workspace IDE presentation removal failed: \(String(describing: error), privacy: .public)")
        }
    }
}
