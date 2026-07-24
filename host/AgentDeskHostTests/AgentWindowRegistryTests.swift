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
}

@MainActor
private final class AgentWindowRegistryFixture {
    let coordinator: AgentWindowRegistryTerminalCoordinator
    private let recorder: AgentWindowRegistryRecorder
    let registry: AgentWindowRegistry

    var ids: [UUID] { recorder.ids }
    var controllers: [FakeManagedAgentWindow] { recorder.controllers }

    init(suspendStop: Bool = false) {
        let coordinator = AgentWindowRegistryTerminalCoordinator()
        let recorder = AgentWindowRegistryRecorder()
        self.coordinator = coordinator
        self.recorder = recorder
        registry = AgentWindowRegistry(
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
    private var stopTask: Task<Void, Never>?
    private var stopContinuation: CheckedContinuation<Void, Never>?
    private(set) var showCount = 0
    private(set) var stopCount = 0

    init(
        frame: CGRect,
        suspendStop: Bool,
        onClosed: @escaping @MainActor () -> Void
    ) {
        self.frame = frame
        self.suspendStop = suspendStop
        self.onClosed = onClosed
    }

    func show() {
        showCount += 1
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
