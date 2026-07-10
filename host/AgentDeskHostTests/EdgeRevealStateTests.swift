import CoreGraphics
import Testing

@testable import AgentDeskHost

struct EdgeRevealStateTests {
    private let screen = CGRect(x: 0, y: 0, width: 1440, height: 900)
    private let descriptors = [
        WorkspaceShellRevealDescriptor(
            surface: .sidebar,
            edge: .left,
            frame: CGRect(x: 0, y: 0, width: 240, height: 900)
        ),
        WorkspaceShellRevealDescriptor(
            surface: .topBar,
            edge: .top,
            frame: CGRect(x: 0, y: 862, width: 1440, height: 38)
        ),
    ]

    @Test mutating func hiddenSurfaceOnlyRevealsFromItsEdgeBand() {
        var machine = WorkspaceShellRevealStateMachine()

        let interior = pointer(CGPoint(x: 100, y: 400))
        #expect(machine.send(.pointerMoved(interior), configuration: .init()).revealed.isEmpty)

        let edge = pointer(CGPoint(x: 2, y: 400))
        #expect(machine.send(.pointerMoved(edge), configuration: .init()).contains(.sidebar))
    }

    @Test mutating func revealedSurfaceStaysOpenUntilPointerLeavesSurfaceAndEdge() {
        var machine = WorkspaceShellRevealStateMachine()
        _ = machine.send(.pointerMoved(pointer(CGPoint(x: 2, y: 400))), configuration: .init())

        let retained = pointer(CGPoint(x: 100, y: 400), inside: [.sidebar])
        #expect(machine.send(.pointerMoved(retained), configuration: .init()).contains(.sidebar))

        let departed = pointer(CGPoint(x: 300, y: 400))
        #expect(!machine.send(.pointerMoved(departed), configuration: .init()).contains(.sidebar))
    }

    @Test mutating func pinnedSurfaceRemainsVisibleWithoutPointerMovement() {
        var machine = WorkspaceShellRevealStateMachine()

        let state = machine.send(
            .configurationChanged,
            configuration: WorkspaceShellRevealConfiguration(pinned: [.topBar])
        )

        #expect(state.contains(.topBar))
    }

    @Test mutating func controllerPublishesOnlyStateChanges() {
        var observed: [WorkspaceShellRevealState] = []
        var controller = WorkspaceShellEdgeRevealController { observed.append($0) }
        controller.update(screen: screen, descriptors: descriptors, configuration: .init())

        controller.pointerMoved(to: CGPoint(x: 2, y: 400))
        controller.pointerMoved(to: CGPoint(x: 2, y: 400))
        controller.pointerMoved(to: CGPoint(x: 300, y: 400))

        #expect(observed == [
            WorkspaceShellRevealState(revealed: [.sidebar]),
            WorkspaceShellRevealState(),
        ])
    }

    private func pointer(_ point: CGPoint, inside: Set<WorkspaceShellSurface> = []) -> WorkspaceShellRevealPointer {
        WorkspaceShellRevealPointer(
            point: point,
            screen: screen,
            descriptors: descriptors,
            insideSurfaces: inside,
            defaultTriggerBand: 4
        )
    }
}
