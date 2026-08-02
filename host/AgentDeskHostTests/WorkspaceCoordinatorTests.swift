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

    @Test func textZoomUsesFourteenPointMarkdownBaseline() {
        let baseline = WorkspaceTextZoom()

        #expect(baseline.markdownPointSize == 14)
        #expect(baseline.zoomedIn().markdownPointSize == 15)
        #expect(baseline.zoomedOut().markdownPointSize == 13)
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

    @Test func reconcilesAllDesktopAssignmentsInOnePublishedMutation() async throws {
        let (coordinator, root, directory) = try fixture()
        defer { try? FileManager.default.removeItem(at: directory) }
        let firstID = UUID()
        let secondID = UUID()
        _ = try await coordinator.apply(.add(Workspace(
            id: firstID,
            root: root,
            name: "First",
            desktopAssignment: WorkspaceDesktopAssignment(spaceID: 10, displayID: "D1", ordinal: 0)
        )))
        _ = try await coordinator.apply(.add(Workspace(
            id: secondID,
            root: root.appendingPathComponent("second"),
            name: "Second",
            desktopAssignment: WorkspaceDesktopAssignment(spaceID: 20, displayID: "D1", ordinal: 1)
        )))
        let recorder = WorkspaceStoreRecorder()
        let token = await coordinator.subscribe { store in await recorder.append(store) }

        let reconciled = try await coordinator.apply(.reconcileDesktopAssignments([
            10: WorkspaceDesktopAssignment(spaceID: 10, displayID: "D2", ordinal: 1),
            20: WorkspaceDesktopAssignment(spaceID: 20, displayID: "D2", ordinal: 0),
        ]))
        await coordinator.unsubscribe(token)

        #expect(await recorder.snapshots.count == 1)
        #expect(reconciled.workspace(id: firstID)?.desktopAssignment?.displayID == "D2")
        #expect(reconciled.workspace(id: firstID)?.desktopAssignment?.ordinal == 1)
        #expect(reconciled.workspace(id: secondID)?.desktopAssignment?.displayID == "D2")
        #expect(reconciled.workspace(id: secondID)?.desktopAssignment?.ordinal == 0)
    }

    @Test func unassignedObservedDesktopClearsActiveWorkspace() async throws {
        let (coordinator, root, directory) = try fixture()
        defer { try? FileManager.default.removeItem(at: directory) }
        let workspaceID = UUID()
        let assignedDesktop = WorkspaceDesktopAssignment(spaceID: 10, displayID: "D1", ordinal: 0)
        let unassignedDesktop = WorkspaceDesktopAssignment(spaceID: 20, displayID: "D1", ordinal: 1)
        let registered = try await coordinator.apply(.add(Workspace(
            id: workspaceID,
            root: root,
            name: "Project",
            desktopAssignment: assignedDesktop
        )))

        let observedWorkspaceID = registered.preferredWorkspaceID(assignedTo: unassignedDesktop)
        let reconciled = try await coordinator.apply(.select(observedWorkspaceID))

        #expect(observedWorkspaceID == nil)
        #expect(reconciled.activeID == nil)
        #expect(try WorkspaceStore.load(
            from: directory.appendingPathComponent("workspaces.json")
        ).activeID == nil)
    }
}

private actor WorkspaceStoreRecorder {
    private(set) var snapshots: [WorkspaceStore] = []
    func append(_ store: WorkspaceStore) { snapshots.append(store) }
}
