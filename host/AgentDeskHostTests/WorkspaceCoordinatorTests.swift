import CoreGraphics
import Foundation
import Testing

@testable import AgentDeskHost

struct WorkspaceCoordinatorTests {
    private func fixture() throws -> (WorkspaceCoordinator, URL, URL) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let root = directory.appendingPathComponent("project", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let repository = WorkspaceRepository(
            donorURL: directory.appendingPathComponent("missing-donor.json"),
            destinationURL: directory.appendingPathComponent("workspaces.json")
        )
        return (WorkspaceCoordinator(repository: repository), root, directory)
    }

    @Test func ownsRegistrationSelectionAndPresentationMutations() async throws {
        let (coordinator, root, directory) = try fixture()
        defer { try? FileManager.default.removeItem(at: directory) }
        let id = UUID()

        let registered = try await coordinator.apply(.register(id: id, root: root, name: "Project"))
        #expect(registered.activeID == id)
        let zoomed = try await coordinator.apply(.setTextZoom(WorkspaceTextZoom(step: 2)))
        #expect(zoomed.textZoom.step == 2)
        let resized = try await coordinator.apply(.setSidebarWidth(440, screenWidth: 1_200))
        #expect(resized.sidebarWidth == 440)

        let persisted = try WorkspaceStore.load(from: directory.appendingPathComponent("workspaces.json"))
        #expect(persisted == resized)
    }

    @Test func publishesOneImmutableSnapshotPerEffectiveMutation() async throws {
        let (coordinator, root, directory) = try fixture()
        defer { try? FileManager.default.removeItem(at: directory) }
        let recorder = WorkspaceStoreRecorder()
        let token = await coordinator.subscribe { store in await recorder.append(store) }

        let id = UUID()
        _ = try await coordinator.apply(.register(id: id, root: root, name: "Project"))
        _ = try await coordinator.apply(.select(id))
        await coordinator.unsubscribe(token)

        let snapshots = await recorder.snapshots
        #expect(snapshots.count == 1)
        #expect(snapshots.first?.activeID == id)
    }
}

private actor WorkspaceStoreRecorder {
    private(set) var snapshots: [WorkspaceStore] = []
    func append(_ store: WorkspaceStore) { snapshots.append(store) }
}
