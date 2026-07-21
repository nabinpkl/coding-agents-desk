import CoreGraphics

enum WorkspaceShellSurface: Hashable, CaseIterable {
    case sidebar
    case topBar
    case dockEnrichment
}

enum WorkspaceShellRevealEdge: Equatable {
    case left
    case top
    case bottom

    func contains(_ point: CGPoint, in screen: CGRect, band: CGFloat) -> Bool {
        switch self {
        case .left:
            point.x <= screen.minX + band
        case .top:
            point.y >= screen.maxY - band
        case .bottom:
            point.y <= screen.minY + band
        }
    }
}

struct WorkspaceShellRevealDescriptor: Equatable {
    let surface: WorkspaceShellSurface
    let edge: WorkspaceShellRevealEdge
    let frame: CGRect
    /// The region that KEEPS a revealed surface open (donor `retentionFrame`), which can be larger than
    /// the visible `frame`. For a surface floated off its edge (the dock strip), this spans from the
    /// screen edge up to the strip's far edge so the pointer bridging the gap below it does not hide it,
    /// while the reveal itself still triggers only in the thin edge band. Defaults to `frame`.
    let retentionFrame: CGRect?
    let triggerBand: CGFloat?

    init(
        surface: WorkspaceShellSurface,
        edge: WorkspaceShellRevealEdge,
        frame: CGRect,
        retentionFrame: CGRect? = nil,
        triggerBand: CGFloat? = nil
    ) {
        self.surface = surface
        self.edge = edge
        self.frame = frame
        self.retentionFrame = retentionFrame
        self.triggerBand = triggerBand
    }

    func containsRetainedSurface(_ point: CGPoint, tolerance: CGFloat) -> Bool {
        (retentionFrame ?? frame).insetBy(dx: -tolerance, dy: -tolerance).contains(point)
    }
}

/// One display's reveal geometry. The controller keeps every connected display here and selects the
/// target under the pointer, while the overlay keeps one authoritative set of interactive views.
struct WorkspaceShellRevealTarget: Equatable {
    let screen: CGRect
    let descriptors: [WorkspaceShellRevealDescriptor]
}

struct WorkspaceShellRevealPointerFacts: Equatable {
    let isNearTriggerEdge: Bool
    let isInsideSurface: Bool
}

struct WorkspaceShellRevealPointer: Equatable {
    let isOnScreen: Bool
    let factsBySurface: [WorkspaceShellSurface: WorkspaceShellRevealPointerFacts]

    init(
        point: CGPoint,
        screen: CGRect,
        descriptors: [WorkspaceShellRevealDescriptor],
        insideSurfaces: Set<WorkspaceShellSurface>,
        defaultTriggerBand: CGFloat,
        surfaceTolerance: CGFloat = 0
    ) {
        let isOnScreen = screen.contains(point)
        self.isOnScreen = isOnScreen
        factsBySurface = Dictionary(uniqueKeysWithValues: descriptors.map { descriptor in
            let triggerBand = max(0, descriptor.triggerBand ?? defaultTriggerBand)
            return (
                descriptor.surface,
                WorkspaceShellRevealPointerFacts(
                    isNearTriggerEdge: isOnScreen
                        && descriptor.edge.contains(point, in: screen, band: triggerBand),
                    isInsideSurface: insideSurfaces.contains(descriptor.surface)
                        || descriptor.containsRetainedSurface(point, tolerance: surfaceTolerance)
                )
            )
        })
    }
}

struct WorkspaceShellRevealState: Equatable {
    let revealed: Set<WorkspaceShellSurface>

    init(revealed: Set<WorkspaceShellSurface> = []) {
        self.revealed = revealed
    }

    func contains(_ surface: WorkspaceShellSurface) -> Bool {
        revealed.contains(surface)
    }
}

/// The reveal state plus the display where the single interactive overlay must be presented.
struct WorkspaceShellRevealPresentation: Equatable {
    let state: WorkspaceShellRevealState
    let screen: CGRect?
}

struct WorkspaceShellRevealConfiguration: Equatable {
    let pinned: Set<WorkspaceShellSurface>
    let held: Set<WorkspaceShellSurface>

    init(pinned: Set<WorkspaceShellSurface> = [], held: Set<WorkspaceShellSurface> = []) {
        self.pinned = pinned
        self.held = held
    }
}

enum WorkspaceShellRevealEvent: Equatable {
    case pointerMoved(WorkspaceShellRevealPointer)
    case configurationChanged
}

struct WorkspaceShellRevealStateMachine: Equatable {
    private(set) var state: WorkspaceShellRevealState
    private var lastPointer: WorkspaceShellRevealPointer?

    init(state: WorkspaceShellRevealState = WorkspaceShellRevealState()) {
        self.state = state
    }

    @discardableResult
    mutating func send(
        _ event: WorkspaceShellRevealEvent,
        configuration: WorkspaceShellRevealConfiguration
    ) -> WorkspaceShellRevealState {
        switch event {
        case .pointerMoved(let pointer):
            lastPointer = pointer
            state = Self.transition(from: state, pointer: pointer, configuration: configuration)
        case .configurationChanged:
            guard let lastPointer else {
                state = WorkspaceShellRevealState(
                    revealed: state.revealed.union(configuration.pinned).union(configuration.held)
                )
                return state
            }
            state = Self.transition(from: state, pointer: lastPointer, configuration: configuration)
        }
        return state
    }

    private static func transition(
        from current: WorkspaceShellRevealState,
        pointer: WorkspaceShellRevealPointer,
        configuration: WorkspaceShellRevealConfiguration
    ) -> WorkspaceShellRevealState {
        let candidates = current.revealed
            .union(configuration.pinned)
            .union(configuration.held)
            .union(pointer.factsBySurface.keys)
        let revealed = Set(candidates.filter { surface in
            if configuration.pinned.contains(surface) || configuration.held.contains(surface) {
                return true
            }
            let facts = pointer.factsBySurface[surface]
            if current.revealed.contains(surface) {
                return facts?.isNearTriggerEdge == true || facts?.isInsideSurface == true
            }
            return facts?.isNearTriggerEdge == true
        })
        return WorkspaceShellRevealState(revealed: revealed)
    }
}

struct WorkspaceShellEdgeRevealController {
    private let apply: (WorkspaceShellRevealPresentation) -> Void
    private var targets: [WorkspaceShellRevealTarget] = []
    private var activeScreen: CGRect?
    private var configuration = WorkspaceShellRevealConfiguration()
    private var machine = WorkspaceShellRevealStateMachine()

    init(apply: @escaping (WorkspaceShellRevealPresentation) -> Void) {
        self.apply = apply
    }

    mutating func update(
        targets: [WorkspaceShellRevealTarget],
        preferredScreen: CGRect?,
        configuration: WorkspaceShellRevealConfiguration
    ) {
        self.targets = targets
        self.configuration = configuration
        let selectedScreen = targets.first(where: { $0.screen == preferredScreen })?.screen
            ?? targets.first(where: { $0.screen == activeScreen })?.screen
            ?? targets.first?.screen
        publish(.configurationChanged, screen: selectedScreen, force: true)
    }

    mutating func pointerMoved(
        to point: CGPoint,
        insideSurfaces: Set<WorkspaceShellSurface> = [],
        defaultTriggerBand: CGFloat = 4,
        surfaceTolerance: CGFloat = 0
    ) {
        let target = targets.first(where: { $0.screen.contains(point) })
        let pointer = WorkspaceShellRevealPointer(
            point: point,
            screen: target?.screen ?? .zero,
            descriptors: target?.descriptors ?? [],
            insideSurfaces: insideSurfaces,
            defaultTriggerBand: defaultTriggerBand,
            surfaceTolerance: surfaceTolerance
        )
        publish(.pointerMoved(pointer), screen: target?.screen ?? activeScreen)
    }

    mutating func setConfiguration(_ configuration: WorkspaceShellRevealConfiguration) {
        self.configuration = configuration
        publish(.configurationChanged, screen: activeScreen)
    }

    private mutating func publish(
        _ event: WorkspaceShellRevealEvent,
        screen: CGRect?,
        force: Bool = false
    ) {
        let previous = machine.state
        let next = machine.send(event, configuration: configuration)
        let screenChanged = screen != activeScreen
        activeScreen = screen
        if force || next != previous || screenChanged {
            apply(WorkspaceShellRevealPresentation(state: next, screen: screen))
        }
    }
}
