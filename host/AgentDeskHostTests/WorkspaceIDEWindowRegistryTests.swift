import AgentDeskWire
import CoreGraphics
import Foundation
import Testing
import WorkspaceIDE

@testable import AgentDeskHost

@MainActor
@Suite(.serialized)
struct WorkspaceIDEWindowRegistryTests {
    @Test func eachPlusClickCreatesAnIndependentWindowAndCascadesPerDesktop() {
        let fixture = Fixture()
        defer { fixture.remove() }
        let baseFrame = CGRect(x: 100, y: 200, width: 1_180, height: 760)

        fixture.registry.open(placement(spaceID: 41, frame: baseFrame))
        fixture.registry.open(placement(spaceID: 41, frame: baseFrame))
        fixture.registry.open(placement(spaceID: 99, frame: baseFrame))

        #expect(fixture.controllers.count == 3)
        #expect(Set(fixture.ids).count == 3)
        #expect(fixture.controllers.map(\.placement.frame) == [
            baseFrame,
            baseFrame.offsetBy(dx: 28, dy: -28),
            baseFrame,
        ])
        #expect(fixture.controllers.map(\.activations) == [[true], [true], [true]])
    }

    @Test func restartRestoresEveryWindowStatePlacementAndIdentityWithoutFocus() async {
        let url = Fixture.makeStoreURL()
        let before = Fixture(storeURL: url)
        defer { before.remove() }
        let originalFrame = CGRect(x: 100, y: 200, width: 1_180, height: 760)
        before.registry.open(placement(spaceID: 41, frame: originalFrame))
        before.registry.open(placement(spaceID: 99, frame: originalFrame))
        let moved = CGRect(x: 620, y: 80, width: 1_000, height: 680)
        before.controllers[0].move(to: moved)
        var state = before.controllers[0].localStateStore.load()
        state.sidebarVisible = false
        before.controllers[0].localStateStore.save(state)
        await before.registry.beginStopAll().value

        let after = Fixture(storeURL: url)
        after.registry.startRestoration(
            visibleFrames: [CGRect(x: 0, y: 0, width: 2_560, height: 1_440)]
        )

        #expect(Set(after.ids) == Set(before.ids))
        #expect(Set(after.controllers.map(\.placement.frame)) == [moved, originalFrame])
        #expect(after.controllers.map(\.activations) == [[false], [false]])
        #expect(after.controllers.contains { !$0.localStateStore.load().sidebarVisible })
    }

    @Test func userCloseDeletesOnlyThatWindowButHostTerminationPreservesTheRest() async {
        let url = Fixture.makeStoreURL()
        let fixture = Fixture(storeURL: url)
        defer { fixture.remove() }
        let frame = CGRect(x: 100, y: 200, width: 1_180, height: 760)
        fixture.registry.open(placement(spaceID: 41, frame: frame))
        fixture.registry.open(placement(spaceID: 41, frame: frame))
        let survivingID = fixture.ids[1]

        fixture.controllers[0].closeAsUser()
        await fixture.registry.beginStopAll().value

        #expect(WorkspaceIDEWindowPresentationStore(url: url).descriptors.map(\.id) == [survivingID])
    }

    private func placement(spaceID: UInt64, frame: CGRect) -> WorkspaceWindowPlacement {
        WorkspaceWindowPlacement(
            desktop: WorkspaceDesktopAssignment(
                spaceID: spaceID,
                displayID: "display-\(spaceID)",
                ordinal: 0
            ),
            frame: frame
        )
    }
}

@MainActor
private final class Fixture {
    let storeURL: URL
    let registry: WorkspaceIDEWindowRegistry
    private let recorder: Recorder

    var ids: [UUID] { recorder.ids }
    var controllers: [FakeWorkspaceIDEWindow] { recorder.controllers }

    static func makeStoreURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("workspace-ide-presentations-\(UUID().uuidString)", isDirectory: true)
            .appendingPathComponent("presentations.json")
    }

    init(storeURL: URL = Fixture.makeStoreURL()) {
        self.storeURL = storeURL
        let recorder = Recorder()
        self.recorder = recorder
        let coordinator = FakeWorkspaceTerminalCoordinator()
        registry = WorkspaceIDEWindowRegistry(
            store: WorkspaceIDEWindowPresentationStore(url: storeURL),
            persistDelay: .milliseconds(1),
            endpointFactory: { id in
                WorkspaceTerminalEndpoint(
                    coordinator: coordinator,
                    requestNamespace: "test-workspace-ide-\(id.uuidString)",
                    clientTitle: "test",
                    tombstoneLimit: 8,
                    push: nil
                )
            },
            controllerFactory: { id, placement, stateStore, _, _, onClosed in
                let controller = FakeWorkspaceIDEWindow(
                    placement: placement,
                    localStateStore: stateStore,
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
private final class Recorder {
    var ids: [UUID] = []
    var controllers: [FakeWorkspaceIDEWindow] = []
}

@MainActor
private final class FakeWorkspaceIDEWindow: WorkspaceIDEWindowControlling {
    private(set) var placement: WorkspaceWindowPlacement
    let localStateStore: WorkspaceIDEWindowLocalStateStore
    private var placementChanged: ((WorkspaceWindowPlacement) -> Void)?
    private var onClosed: (@MainActor () -> Void)?
    private(set) var activations: [Bool] = []

    init(
        placement: WorkspaceWindowPlacement,
        localStateStore: WorkspaceIDEWindowLocalStateStore,
        onClosed: @escaping @MainActor () -> Void
    ) {
        self.placement = placement
        self.localStateStore = localStateStore
        self.onClosed = onClosed
    }

    func show(activating: Bool) {
        activations.append(activating)
    }

    func observePlacement(_ changed: @escaping (WorkspaceWindowPlacement) -> Void) {
        placementChanged = changed
    }

    func move(to frame: CGRect) {
        placement.frame = frame
        placementChanged?(placement)
    }

    func closeAsUser() {
        let closed = onClosed
        onClosed = nil
        closed?()
    }

    func stop() {
        onClosed = nil
    }

    func discardLocalPersistence() {}
}

private actor FakeWorkspaceTerminalCoordinator: WorkspaceTerminalCoordinating {
    func open(_ request: WorkspaceTerminalOpenRequest) async throws -> WorkspaceTerminalCoordinatorReady {
        throw FakeWorkspaceTerminalCoordinatorError.unexpectedOpen
    }

    func acknowledgeAttachment(requestID: String, workspaceID: String, ptySessionName: String) async {}

    func cancel(requestID: String, workspaceID: String, ptySessionName: String?) async {}
}

private enum FakeWorkspaceTerminalCoordinatorError: Error {
    case unexpectedOpen
}
