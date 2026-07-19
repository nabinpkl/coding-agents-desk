import Foundation
import Testing
import AgentDeskWire

@testable import AgentDeskHost

struct WorkspaceIDEStateCoordinatorTests {
    private func temporaryURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
            .appendingPathComponent("workspace-ide-state.json")
    }

    @Test func appliesOperationsPersistsAndReloads() async throws {
        let url = temporaryURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let workspaceID = UUID().uuidString
        let coordinator = WorkspaceIDEStateCoordinator(storeURL: url)

        let opened = try await coordinator.apply(
            workspaceID: workspaceID,
            baseRevision: 0,
            operationID: WorkspaceIDEOperationID(value: "open-readme"),
            operation: .open(path: "README.md")
        )
        #expect(opened.revision == 1)
        #expect(opened.orderedOpenPaths == ["README.md"])

        let expanded = try await coordinator.apply(
            workspaceID: workspaceID,
            baseRevision: 1,
            operationID: WorkspaceIDEOperationID(value: "expand-src"),
            operation: .expand(path: "src")
        )
        #expect(expanded.revision == 2)
        #expect(expanded.expandedDirectoryPaths == ["src"])

        let reloaded = try await WorkspaceIDEStateCoordinator(storeURL: url).snapshot(workspaceID: workspaceID)
        #expect(reloaded == expanded)
    }

    @Test func duplicateOperationIsIdempotentEvenAfterRevisionAdvances() async throws {
        let coordinator = WorkspaceIDEStateCoordinator(storeURL: temporaryURL())
        let workspaceID = UUID().uuidString
        let operationID = WorkspaceIDEOperationID(value: "same-operation")
        let first = try await coordinator.apply(
            workspaceID: workspaceID,
            baseRevision: 0,
            operationID: operationID,
            operation: .open(path: "one.txt")
        )
        _ = try await coordinator.apply(
            workspaceID: workspaceID,
            baseRevision: first.revision,
            operationID: WorkspaceIDEOperationID(value: "second-operation"),
            operation: .open(path: "two.txt")
        )

        let replayed = try await coordinator.apply(
            workspaceID: workspaceID,
            baseRevision: 0,
            operationID: operationID,
            operation: .open(path: "one.txt")
        )
        #expect(replayed.revision == 2)
        #expect(replayed.orderedOpenPaths == ["one.txt", "two.txt"])
    }

    @Test func rejectsStaleRevisionAndInvalidPaths() async throws {
        let coordinator = WorkspaceIDEStateCoordinator(storeURL: temporaryURL())
        let workspaceID = UUID().uuidString
        _ = try await coordinator.apply(
            workspaceID: workspaceID,
            baseRevision: 0,
            operationID: WorkspaceIDEOperationID(value: "first"),
            operation: .open(path: "one.txt")
        )

        await #expect(throws: WorkspaceIDEStateCoordinatorError.revisionConflict(currentRevision: 1)) {
            _ = try await coordinator.apply(
                workspaceID: workspaceID,
                baseRevision: 0,
                operationID: WorkspaceIDEOperationID(value: "stale"),
                operation: .open(path: "two.txt")
            )
        }
        await #expect(throws: WorkspaceIDEStateCoordinatorError.invalidPath) {
            _ = try await coordinator.apply(
                workspaceID: workspaceID,
                baseRevision: 1,
                operationID: WorkspaceIDEOperationID(value: "escape"),
                operation: .expand(path: "../outside")
            )
        }
    }

    @Test func fansEachCommittedSnapshotToWorkspaceSubscribers() async throws {
        let coordinator = WorkspaceIDEStateCoordinator(storeURL: temporaryURL())
        let workspaceID = UUID().uuidString
        let otherWorkspaceID = UUID().uuidString
        let received = StateRecorder()
        let token = await coordinator.subscribe(workspaceID: workspaceID) { state in
            await received.append(state)
        }
        defer { Task { await coordinator.unsubscribe(token) } }

        _ = try await coordinator.apply(
            workspaceID: otherWorkspaceID,
            baseRevision: 0,
            operationID: WorkspaceIDEOperationID(value: "other"),
            operation: .open(path: "other.txt")
        )
        _ = try await coordinator.apply(
            workspaceID: workspaceID,
            baseRevision: 0,
            operationID: WorkspaceIDEOperationID(value: "mine"),
            operation: .open(path: "mine.txt")
        )

        #expect(await received.states.map(\.orderedOpenPaths) == [["mine.txt"]])
    }

    @Test func boundsDurableOpenStateAndPathSize() async throws {
        let coordinator = WorkspaceIDEStateCoordinator(storeURL: temporaryURL())
        let workspaceID = UUID().uuidString
        var revision: UInt64 = 0

        for index in 0..<WorkspaceIDEStateCoordinator.maximumOpenPaths {
            _ = try await coordinator.apply(
                workspaceID: workspaceID,
                baseRevision: revision,
                operationID: WorkspaceIDEOperationID(value: "open-\(index)"),
                operation: .open(path: "files/\(index).txt")
            )
            revision += 1
        }
        await #expect(throws: WorkspaceIDEStateCoordinatorError.stateLimitExceeded) {
            try await coordinator.apply(
                workspaceID: workspaceID,
                baseRevision: revision,
                operationID: WorkspaceIDEOperationID(value: "open-over-limit"),
                operation: .open(path: "files/overflow.txt")
            )
        }

        let oversizedPath = String(
            repeating: "a",
            count: WorkspaceIDEStateCoordinator.maximumPathBytes + 1
        )
        await #expect(throws: WorkspaceIDEStateCoordinatorError.invalidPath) {
            try await coordinator.apply(
                workspaceID: workspaceID,
                baseRevision: revision,
                operationID: WorkspaceIDEOperationID(value: "oversized-path"),
                operation: .expand(path: oversizedPath)
            )
        }
    }
}

private actor StateRecorder {
    private(set) var states: [WorkspaceIDESharedState] = []
    func append(_ state: WorkspaceIDESharedState) { states.append(state) }
}
