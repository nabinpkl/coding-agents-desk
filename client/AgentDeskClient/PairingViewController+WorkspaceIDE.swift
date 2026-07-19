import OSLog
import UIKit
import WorkspaceIDE

extension PairingViewController {
    private static let workspaceIDELogger = Logger(subsystem: Config.logSubsystem, category: "workspace-ide")

    private enum WorkspaceIDEKeys {
        nonisolated(unsafe) static var state: UInt8 = 0
    }

    private final class WorkspaceIDEClientState {
        var surface: WorkspaceIDESurface?
        var transport: WorkspaceTransport?
        var task: Task<Void, Never>?
        var generation = 0
        var loading = false
        weak var boundSession: QuicSessionClientTransport?
    }

    private var workspaceIDEState: WorkspaceIDEClientState {
        if let state = objc_getAssociatedObject(
            self,
            &WorkspaceIDEKeys.state
        ) as? WorkspaceIDEClientState {
            return state
        }
        let state = WorkspaceIDEClientState()
        objc_setAssociatedObject(
            self,
            &WorkspaceIDEKeys.state,
            state,
            .OBJC_ASSOCIATION_RETAIN_NONATOMIC
        )
        return state
    }

    var ideSurface: WorkspaceIDESurface? {
        workspaceIDEState.surface
    }

    func teardownIDESurface() {
        let state = workspaceIDEState
        state.generation += 1
        state.task?.cancel()
        state.task = nil
        state.surface?.teardown()
        state.surface?.removeFromSuperview()
        state.surface = nil
        state.boundSession = nil
        if let transport = state.transport { Task { await transport.close() } }
        state.transport = nil
        state.loading = false
    }

    func rebindIDESurfaceAfterReconnectIfNeeded() {
        let state = workspaceIDEState
        guard state.surface != nil else { return }
        guard state.boundSession !== pairingClient.activeSessionTransport else { return }
        let wasActive = activeControlSurface == .ide
        teardownIDESurface()
        if wasActive { ensureIDESurface() }
    }

    func ensureIDESurface() {
        let state = workspaceIDEState
        guard state.surface == nil, !state.loading else { return }
        guard let session = pairingClient.activeSessionTransport else { return }
        state.loading = true
        let generation = state.generation
        state.task = Task { [weak self] in
            guard let self else { return }
            do {
                let transport = try await session.openWorkspaceTransport()
                guard self.workspaceIDEState.generation == generation else {
                    await transport.close()
                    return
                }
                self.mountIDESurface(transport: transport, session: session)
            } catch {
                self.handleIDESurfaceOpenFailure(error, generation: generation)
            }
        }
    }

    private func mountIDESurface(
        transport: WorkspaceTransport,
        session: QuicSessionClientTransport
    ) {
        let dataSource = WorkspaceIDELaneDataSource(
            request: { try await transport.request($0) },
            events: { await transport.events() }
        )
        let controller = WorkspaceIDEController(
            dataSource: dataSource,
            capabilities: .iPhone,
            draftStore: WorkspaceIDEFileDraftStore(directory: Config.workspaceIDEDraftsDirectory)
        )
        let surface = WorkspaceIDESurface(
            controller: controller,
            terminalCoordinator: session,
            terminalSessionOpener: session
        )
        surface.translatesAutoresizingMaskIntoConstraints = false
        surface.isHidden = activeControlSurface != .ide
        view.addSubview(surface)
        let top = surfaceSegmentedControl.map {
            surface.topAnchor.constraint(equalTo: $0.bottomAnchor, constant: 8)
        } ?? surface.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor)
        NSLayoutConstraint.activate([
            top,
            surface.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            surface.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            surface.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        if let surfaceSegmentedControl { view.bringSubviewToFront(surfaceSegmentedControl) }

        let state = workspaceIDEState
        state.transport = transport
        state.surface = surface
        state.boundSession = session
        state.loading = false
        state.task = nil
    }

    private func handleIDESurfaceOpenFailure(_ error: Error, generation: Int) {
        Self.workspaceIDELogger.error("IDE surface open failed: \(String(describing: error), privacy: .public)")
        let state = workspaceIDEState
        guard state.generation == generation else { return }
        state.loading = false
        state.task = nil
        guard activeControlSurface == .ide else { return }
        activeControlSurface = .control
        if let surfaceSegmentedControl {
            surfaceSegmentedControl.selectedSegmentIndex = segmentIndex(for: .control, in: surfaceSegmentedControl)
        }
        applySurface(.control)
    }
}
