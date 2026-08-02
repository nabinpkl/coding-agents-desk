import AgentDeskWire
import CoreGraphics
import Foundation
import Testing

@testable import AgentDeskHost

@MainActor
@Suite(.serialized)
struct AgentWindowRegistryTests {
    @Test func eachOpenCreatesAnIndependentWindowAndCascadesOnlyOnThatDesktop() {
        let fixture = AgentWindowRegistryFixture()
        let baseFrame = CGRect(x: 100, y: 200, width: 480, height: 720)

        fixture.registry.open(AgentWindowPlacement(desktopSpaceID: 41, frame: baseFrame))
        fixture.registry.open(AgentWindowPlacement(desktopSpaceID: 41, frame: baseFrame))
        fixture.registry.open(AgentWindowPlacement(desktopSpaceID: 41, frame: baseFrame))
        fixture.registry.open(AgentWindowPlacement(desktopSpaceID: 99, frame: baseFrame))

        #expect(fixture.controllers.count == 4)
        #expect(Set(fixture.ids).count == 4)
        #expect(fixture.controllers.map(\.showCount) == [1, 1, 1, 1])
        #expect(fixture.controllers[0].frame == baseFrame)
        #expect(fixture.controllers[1].frame == baseFrame.offsetBy(dx: 24, dy: -24))
        #expect(fixture.controllers[2].frame == baseFrame.offsetBy(dx: 48, dy: -48))
        #expect(fixture.controllers[3].frame == baseFrame)
        #expect(fixture.registry.openWindowCountForTesting == 4)

        fixture.controllers[1].close()
        #expect(fixture.registry.openWindowCountForTesting == 3)

        fixture.registry.open(AgentWindowPlacement(desktopSpaceID: 41, frame: baseFrame))
        #expect(fixture.controllers[4].frame == baseFrame.offsetBy(dx: 24, dy: -24))
        #expect(fixture.registry.openWindowCountForTesting == 4)
    }

    @Test func terminationStartsEveryWindowCloseOnceAndWaitsForAllOfThem() async {
        let fixture = AgentWindowRegistryFixture(suspendStop: true)
        let placement = AgentWindowPlacement(
            desktopSpaceID: 41,
            frame: CGRect(x: 100, y: 200, width: 480, height: 720)
        )
        fixture.registry.open(placement)
        fixture.registry.open(placement)

        let firstStop = fixture.registry.beginStopAll()
        let repeatedStop = fixture.registry.beginStopAll()
        await Task.yield()

        #expect(fixture.controllers.map(\.stopCount) == [1, 1])
        #expect(fixture.registry.openWindowCountForTesting == 2)

        fixture.registry.open(placement)
        #expect(fixture.controllers.count == 2)

        fixture.controllers.forEach { $0.resumeStop() }
        await firstStop.value
        await repeatedStop.value

        #expect(fixture.registry.openWindowCountForTesting == 0)
    }

    @Test func everyOpenWindowComesBackWhereItWasLeftWithoutTakingFocus() async {
        let storeURL = AgentWindowRegistryFixture.makeStoreURL()
        let before = AgentWindowRegistryFixture(storeURL: storeURL)
        defer { before.remove() }
        let baseFrame = CGRect(x: 100, y: 200, width: 480, height: 720)
        before.registry.open(AgentWindowPlacement(desktopSpaceID: 41, frame: baseFrame))
        before.registry.open(AgentWindowPlacement(desktopSpaceID: 41, frame: baseFrame))
        let dragged = CGRect(x: 640, y: 80, width: 520, height: 600)
        before.controllers[0].moveTo(dragged)
        await settleFramePersist(before, contains: dragged)

        // Quitting is not the user putting these windows away, so the placements survive it.
        await before.registry.beginStopAll().value
        #expect(before.storedFrames.count == 2)

        let after = AgentWindowRegistryFixture(storeURL: storeURL)
        after.registry.startRestoration(visibleFrames: [CGRect(x: 0, y: 0, width: 1_920, height: 1_080)])

        #expect(after.controllers.count == 2)
        #expect(Set(after.ids) == Set(before.ids))
        #expect(Set(after.controllers.map(\.frame)) == [dragged, baseFrame.offsetBy(dx: 24, dy: -24)])
        #expect(after.controllers.map(\.activations) == [[false], [false]])
    }

    @Test func aWindowTheUserClosedStaysClosedAcrossRestart() async {
        let storeURL = AgentWindowRegistryFixture.makeStoreURL()
        let before = AgentWindowRegistryFixture(storeURL: storeURL)
        defer { before.remove() }
        let placement = AgentWindowPlacement(
            desktopSpaceID: 41,
            frame: CGRect(x: 100, y: 200, width: 480, height: 720)
        )
        before.registry.open(placement)
        before.registry.open(placement)

        before.controllers[0].close()
        await before.registry.beginStopAll().value

        let after = AgentWindowRegistryFixture(storeURL: storeURL)
        after.registry.startRestoration(visibleFrames: [CGRect(x: 0, y: 0, width: 1_920, height: 1_080)])

        #expect(after.controllers.count == 1)
        #expect(after.ids == [before.ids[1]])
    }

    @Test func restorationIsIdempotentAndNeverDuplicatesAWindow() {
        let storeURL = AgentWindowRegistryFixture.makeStoreURL()
        let before = AgentWindowRegistryFixture(storeURL: storeURL)
        defer { before.remove() }
        before.registry.open(AgentWindowPlacement(
            desktopSpaceID: nil,
            frame: CGRect(x: 10, y: 20, width: 480, height: 720)
        ))

        let after = AgentWindowRegistryFixture(storeURL: storeURL)
        after.registry.startRestoration(visibleFrames: [CGRect(x: 0, y: 0, width: 1_920, height: 1_080)])
        after.registry.startRestoration(visibleFrames: [CGRect(x: 0, y: 0, width: 1_920, height: 1_080)])

        #expect(after.controllers.count == 1)
    }

    @Test func aFrameRememberedOnAScreenThatIsGoneLandsOnOneThatExists() {
        let detached = CGRect(x: 2_400, y: 1_400, width: 480, height: 720)
        let laptop = CGRect(x: 0, y: 0, width: 1_512, height: 900)

        let placed = AgentWindowScreenPlacement.constrained(detached, within: [laptop])

        #expect(laptop.contains(placed))
        #expect(placed.size == detached.size)
        #expect(AgentWindowScreenPlacement.constrained(detached, within: []) == detached)
    }

    @Test func aWindowTallerThanTheScreenIsCutDownToFitIt() {
        let oversized = CGRect(x: -200, y: -100, width: 3_000, height: 2_000)
        let laptop = CGRect(x: 0, y: 0, width: 1_512, height: 900)

        #expect(AgentWindowScreenPlacement.constrained(oversized, within: [laptop]) == laptop)
    }

    /// The store write is debounced, so a moved window is only remembered once the coalescing
    /// window closes. Polls rather than sleeping a fixed span so the test does not encode a timing
    /// guess about a loaded machine.
    private func settleFramePersist(
        _ fixture: AgentWindowRegistryFixture,
        contains frame: CGRect
    ) async {
        for _ in 0..<200 where !fixture.storedFrames.contains(frame) {
            try? await Task.sleep(for: .milliseconds(10))
        }
    }
}

@MainActor
private final class AgentWindowRegistryFixture {
    let coordinator: AgentWindowRegistryTerminalCoordinator
    private let recorder: AgentWindowRegistryRecorder
    let storeURL: URL
    let registry: AgentWindowRegistry

    var ids: [UUID] { recorder.ids }
    var controllers: [FakeManagedAgentWindow] { recorder.controllers }
    var storedFrames: [CGRect] {
        AgentWindowPresentationStore(url: storeURL).descriptors.map(\.frame.cgRect)
    }

    static func makeStoreURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("agent-presentations-\(UUID().uuidString)", isDirectory: true)
            .appendingPathComponent("presentations.json")
    }

    init(
        suspendStop: Bool = false,
        storeURL: URL = AgentWindowRegistryFixture.makeStoreURL(),
        framePersistDelay: Duration = .milliseconds(1)
    ) {
        let coordinator = AgentWindowRegistryTerminalCoordinator()
        let recorder = AgentWindowRegistryRecorder()
        self.coordinator = coordinator
        self.recorder = recorder
        self.storeURL = storeURL
        registry = AgentWindowRegistry(
            store: AgentWindowPresentationStore(url: storeURL),
            framePersistDelay: framePersistDelay,
            endpointFactory: { id in
                AgentSessionTerminalEndpoint(
                    coordinator: coordinator,
                    platform: .macOS,
                    requestNamespace: "test-agent-window-\(id.uuidString)",
                    tombstoneLimit: 8
                )
            },
            controllerFactory: { id, frame, _, onClosed in
                let controller = FakeManagedAgentWindow(
                    frame: frame,
                    suspendStop: suspendStop,
                    onClosed: onClosed
                )
                recorder.ids.append(id)
                recorder.controllers.append(controller)
                return controller
            }
        )
    }

    func remove() {
        try? FileManager.default.removeItem(at: storeURL.deletingLastPathComponent())
    }
}

@MainActor
private final class AgentWindowRegistryRecorder {
    var ids: [UUID] = []
    var controllers: [FakeManagedAgentWindow] = []
}

@MainActor
private final class FakeManagedAgentWindow: AgentWindowControlling {
    let frame: CGRect
    private let suspendStop: Bool
    private var onClosed: (@MainActor () -> Void)?
    private var onFrameChanged: ((CGRect) -> Void)?
    private var stopTask: Task<Void, Never>?
    private var stopContinuation: CheckedContinuation<Void, Never>?
    private(set) var showCount = 0
    private(set) var stopCount = 0
    private(set) var activations: [Bool] = []

    init(
        frame: CGRect,
        suspendStop: Bool,
        onClosed: @escaping @MainActor () -> Void
    ) {
        self.frame = frame
        self.suspendStop = suspendStop
        self.onClosed = onClosed
    }

    func show(activating: Bool) {
        showCount += 1
        activations.append(activating)
    }

    func observePresentation(frameChanged: @escaping (CGRect) -> Void) {
        onFrameChanged = frameChanged
    }

    /// Stands in for the user dragging the window.
    func moveTo(_ frame: CGRect) {
        onFrameChanged?(frame)
    }

    func close() {
        finishClose()
    }

    @discardableResult
    func beginStop() -> Task<Void, Never> {
        if let stopTask { return stopTask }
        stopCount += 1
        let task = Task { @MainActor [self] in
            if suspendStop {
                await withCheckedContinuation { continuation in
                    stopContinuation = continuation
                }
            }
            finishClose()
        }
        stopTask = task
        return task
    }

    func resumeStop() {
        stopContinuation?.resume()
        stopContinuation = nil
    }

    private func finishClose() {
        let onClosed = onClosed
        self.onClosed = nil
        onClosed?()
    }
}

private actor AgentWindowRegistryTerminalCoordinator: AgentSessionTerminalCoordinating {
    func open(
        _ request: AgentSessionTerminalOpenRequest
    ) async throws -> AgentSessionTerminalReady {
        throw AgentWindowRegistryTerminalError.unexpectedOpen
    }

    func acknowledgeAttachment(requestID: String, ptySessionName: String) async {}

    func transferRequest(
        from oldRequestID: String,
        to newRequestID: String,
        ptySessionName: String
    ) async -> Bool {
        false
    }

    func close(requestID: String, ptySessionName: String?) async {}
}

private enum AgentWindowRegistryTerminalError: Error {
    case unexpectedOpen
}
