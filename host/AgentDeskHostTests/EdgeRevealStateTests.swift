import CoreGraphics
import Testing

@testable import AgentDeskHost

struct EdgeRevealStateTests {
    private let screen = CGRect(x: 0, y: 0, width: 1440, height: 900)
    private let secondScreen = CGRect(x: 1440, y: 0, width: 1280, height: 800)
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

    @Test mutating func controllerDoesNotRepublishRepeatedPointerState() {
        var observed: [WorkspaceShellRevealPresentation] = []
        var controller = WorkspaceShellEdgeRevealController { observed.append($0) }
        controller.update(
            targets: [WorkspaceShellRevealTarget(screen: screen, descriptors: descriptors)],
            preferredScreen: screen,
            configuration: .init()
        )

        controller.pointerMoved(to: CGPoint(x: 2, y: 400))
        controller.pointerMoved(to: CGPoint(x: 2, y: 400))
        controller.pointerMoved(to: CGPoint(x: 300, y: 400))

        #expect(observed == [
            WorkspaceShellRevealPresentation(state: .init(), screen: screen),
            WorkspaceShellRevealPresentation(state: .init(revealed: [.sidebar]), screen: screen),
            WorkspaceShellRevealPresentation(state: .init(), screen: screen),
        ])
    }

    @Test mutating func controllerSelectsTheMonitorUnderThePointer() {
        let secondDescriptors = descriptors(for: secondScreen)
        var observed: [WorkspaceShellRevealPresentation] = []
        var controller = WorkspaceShellEdgeRevealController { observed.append($0) }
        controller.update(
            targets: [
                WorkspaceShellRevealTarget(screen: screen, descriptors: descriptors),
                WorkspaceShellRevealTarget(screen: secondScreen, descriptors: secondDescriptors),
            ],
            preferredScreen: screen,
            configuration: .init()
        )

        controller.pointerMoved(to: CGPoint(x: secondScreen.minX + 2, y: secondScreen.midY))

        #expect(observed.last == WorkspaceShellRevealPresentation(
            state: .init(revealed: [.sidebar]),
            screen: secondScreen
        ))
    }

    @Test mutating func controllerRevealsTopBarOnTheSecondMonitorTopEdge() {
        let secondDescriptors = descriptors(for: secondScreen)
        var observed: [WorkspaceShellRevealPresentation] = []
        var controller = WorkspaceShellEdgeRevealController { observed.append($0) }
        controller.update(
            targets: [
                WorkspaceShellRevealTarget(screen: screen, descriptors: descriptors),
                WorkspaceShellRevealTarget(screen: secondScreen, descriptors: secondDescriptors),
            ],
            preferredScreen: screen,
            configuration: .init()
        )

        controller.pointerMoved(to: CGPoint(x: secondScreen.midX, y: secondScreen.maxY - 2))

        #expect(observed.last == WorkspaceShellRevealPresentation(
            state: .init(revealed: [.topBar]),
            screen: secondScreen
        ))
    }

    @Test mutating func controllerMovesTheOverlayTargetEvenWhenRevealStateDoesNotChange() {
        let secondDescriptors = descriptors(for: secondScreen)
        var observed: [WorkspaceShellRevealPresentation] = []
        var controller = WorkspaceShellEdgeRevealController { observed.append($0) }
        controller.update(
            targets: [
                WorkspaceShellRevealTarget(screen: screen, descriptors: descriptors),
                WorkspaceShellRevealTarget(screen: secondScreen, descriptors: secondDescriptors),
            ],
            preferredScreen: screen,
            configuration: .init()
        )

        controller.pointerMoved(to: CGPoint(x: secondScreen.midX, y: secondScreen.midY))

        #expect(observed.last == WorkspaceShellRevealPresentation(state: .init(), screen: secondScreen))
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

    private func descriptors(for screen: CGRect) -> [WorkspaceShellRevealDescriptor] {
        [
            WorkspaceShellRevealDescriptor(
                surface: .sidebar,
                edge: .left,
                frame: CGRect(x: screen.minX, y: screen.minY, width: 240, height: screen.height)
            ),
            WorkspaceShellRevealDescriptor(
                surface: .topBar,
                edge: .top,
                frame: CGRect(x: screen.minX, y: screen.maxY - 38, width: screen.width, height: 38)
            ),
        ]
    }
}
