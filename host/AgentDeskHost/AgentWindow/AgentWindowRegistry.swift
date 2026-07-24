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
    func show()

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
    }

    private let endpointFactory: EndpointFactory
    private let controllerFactory: ControllerFactory
    private let cascadeStep: CGFloat
    private var entries: [UUID: Entry] = [:]
    private var endpointShutdownTasks: [UUID: Task<Void, Never>] = [:]
    private var stopTask: Task<Void, Never>?

    init(
        cascadeStep: CGFloat = 24,
        endpointFactory: @escaping EndpointFactory,
        controllerFactory: @escaping ControllerFactory
    ) {
        self.cascadeStep = cascadeStep
        self.endpointFactory = endpointFactory
        self.controllerFactory = controllerFactory
    }

    convenience init(
        sidecarClient: any SidecarClient,
        terminalCoordinator: any AgentSessionTerminalCoordinating,
        terminalTombstoneLimit: Int,
        makeTerminalPtyClient: @escaping @MainActor () -> PtyClient
    ) {
        self.init(
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
        guard stopTask == nil else { return }
        let id = UUID()
        let usedCascadeOrdinals = Set(entries.values.compactMap { entry in
            entry.desktopSpaceID == placement.desktopSpaceID ? entry.cascadeOrdinal : nil
        })
        var cascadeOrdinal = 0
        while usedCascadeOrdinals.contains(cascadeOrdinal) {
            cascadeOrdinal += 1
        }
        let frame = placement.frame.offsetBy(
            dx: CGFloat(cascadeOrdinal) * cascadeStep,
            dy: CGFloat(-cascadeOrdinal) * cascadeStep
        )
        let endpoint = endpointFactory(id)
        let controller = controllerFactory(id, frame, endpoint) { [weak self] in
            self?.removeWindow(id)
        }
        entries[id] = Entry(
            desktopSpaceID: placement.desktopSpaceID,
            cascadeOrdinal: cascadeOrdinal,
            endpoint: endpoint,
            controller: controller
        )
        controller.show()
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
        let entries = Array(entries.values)
        let controllerTasks = entries.map { $0.controller.beginStop() }
        let existingEndpointShutdownTasks = Array(endpointShutdownTasks.values)
        let task = Task { @MainActor in
            for controllerTask in controllerTasks {
                await controllerTask.value
            }
            for entry in entries {
                await entry.endpoint.shutdown()
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
