import Foundation
import Testing
import AgentDeskWire

@testable import AgentDeskHost

@MainActor
struct WorkspaceLaneSessionTests {
    @Test func correlatesRequestsFansPushesAndStopsSubscriptions() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("workspace-lane-session-\(UUID().uuidString)", isDirectory: true)
        let root = directory.appendingPathComponent("project", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let workspaceID = UUID()
        let workspaces = WorkspaceCoordinator(repository: WorkspaceRepository(
            donorURL: directory.appendingPathComponent("missing-donor.json"),
            destinationURL: directory.appendingPathComponent("workspaces.json")
        ))
        _ = try await workspaces.apply(.register(id: workspaceID, root: root, name: "Project"))

        let reader = LaneGitReader()
        let watches = LaneWatchRecorder()
        let observation = WorkspaceObservationCoordinator(
            reader: reader,
            makeWatch: { callback in watches.make(callback: callback) }
        )
        let pushes = LanePushRecorder()
        let session = WorkspaceLaneSession(
            push: { response in await pushes.append(response) },
            files: WorkspaceFilesResponder(workspaceCoordinator: workspaces, maxBytes: 1_024),
            workspaces: workspaces,
            ideState: WorkspaceIDEStateCoordinator(
                storeURL: directory.appendingPathComponent("workspace-ide-state.json")
            ),
            observation: observation
        )
        let workspaceIDString = workspaceID.uuidString

        let subscribeID = WorkspaceRequestID(value: "subscribe")
        let subscribe = await session.handle(.subscribe(
            requestID: subscribeID,
            workspaceID: workspaceIDString
        ))
        guard case .ideSnapshot(let responseID, let initialState) = subscribe else {
            Issue.record("expected correlated initial IDE snapshot")
            return
        }
        #expect(responseID == subscribeID)
        #expect(initialState.workspaceID == workspaceIDString)
        #expect(initialState.revision == 0)
        #expect(watches.created.count == 1)

        await waitUntil { await pushes.containsGit(generation: 0) }

        let operationID = WorkspaceRequestID(value: "open")
        let operation = await session.handle(.operation(
            requestID: operationID,
            workspaceID: workspaceIDString,
            baseRevision: 0,
            operationID: WorkspaceIDEOperationID(value: "open-readme"),
            operation: .open(path: "README.md")
        ))
        guard case .ideSnapshot(let responseID, let openedState) = operation else {
            Issue.record("expected correlated operation snapshot")
            return
        }
        #expect(responseID == operationID)
        #expect(openedState.orderedOpenPaths == ["README.md"])
        await waitUntil { await pushes.containsState(revision: 1, requestID: nil) }

        watches.created[0].trigger([root.appendingPathComponent("README.md").path])
        await waitUntil { await pushes.containsChange(generation: 1, path: "README.md") }

        let gitID = WorkspaceRequestID(value: "git")
        let gitResponse = await session.handle(.gitStatus(
            requestID: gitID,
            workspaceID: workspaceIDString
        ))
        guard case .gitStatus(let responseID, let git) = gitResponse else {
            Issue.record("expected correlated Git status")
            return
        }
        #expect(responseID == gitID)
        #expect(git.generation == 1)
        #expect(git.entries.first?.relativePath == "README.md")

        let pushCountBeforeStop = await pushes.count
        await session.stop()
        #expect(watches.created[0].stopCount == 1)
        watches.created[0].trigger([root.appendingPathComponent("later.txt").path])
        try? await Task.sleep(for: .milliseconds(30))
        #expect(await pushes.count == pushCountBeforeStop)
    }

    @Test func rejectsUnknownWorkspaceWithoutStartingObservation() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("workspace-lane-session-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let workspaces = WorkspaceCoordinator(repository: WorkspaceRepository(
            donorURL: directory.appendingPathComponent("missing-donor.json"),
            destinationURL: directory.appendingPathComponent("workspaces.json")
        ))
        let watches = LaneWatchRecorder()
        let session = WorkspaceLaneSession(
            push: { _ in },
            files: WorkspaceFilesResponder(workspaceCoordinator: workspaces, maxBytes: 1_024),
            workspaces: workspaces,
            ideState: WorkspaceIDEStateCoordinator(storeURL: directory.appendingPathComponent("state.json")),
            observation: WorkspaceObservationCoordinator(
                reader: LaneGitReader(),
                makeWatch: { callback in watches.make(callback: callback) }
            )
        )
        let requestID = WorkspaceRequestID(value: "missing")

        let response = await session.handle(.subscribe(
            requestID: requestID,
            workspaceID: UUID().uuidString
        ))

        guard case .error(let error) = response else {
            Issue.record("expected workspace-unavailable error")
            return
        }
        #expect(error.requestID == requestID)
        #expect(error.code == .workspaceUnavailable)
        #expect(watches.created.isEmpty)
    }

    private func waitUntil(_ condition: @escaping () async -> Bool) async {
        for _ in 0..<100 where !(await condition()) {
            try? await Task.sleep(for: .milliseconds(10))
        }
        #expect(await condition())
    }
}

private final class LaneGitReader: WorkspaceGitStatusReading, @unchecked Sendable {
    func readSnapshot(workspaceRoot: URL) -> WorkspaceGitSnapshot {
        WorkspaceGitSnapshot(
            status: .empty,
            entries: [WorkspaceGitStatusEntry(
                relativePath: "README.md",
                indexStatus: nil,
                workTreeStatus: "M"
            )]
        )
    }
}

@MainActor
private final class LaneWatchRecorder {
    private(set) var created: [LaneWatch] = []

    func make(callback: @escaping ([String]) -> Void) -> LaneWatch {
        let watch = LaneWatch(callback: callback)
        created.append(watch)
        return watch
    }
}

@MainActor
private final class LaneWatch: WorkspaceObservationWatch {
    private let callback: ([String]) -> Void
    private(set) var stopCount = 0

    init(callback: @escaping ([String]) -> Void) {
        self.callback = callback
    }

    func start(root: URL) {}
    func stop() { stopCount += 1 }
    func trigger(_ paths: [String]) { callback(paths) }
}

private actor LanePushRecorder {
    private(set) var values: [WorkspaceLaneResponse] = []
    var count: Int { values.count }

    func append(_ response: WorkspaceLaneResponse) {
        values.append(response)
    }

    func containsGit(generation: UInt64) -> Bool {
        values.contains {
            guard case .gitStatus(nil, let result) = $0 else { return false }
            return result.generation == generation
        }
    }

    func containsState(revision: UInt64, requestID: WorkspaceRequestID?) -> Bool {
        values.contains {
            guard case .ideSnapshot(let candidateID, let state) = $0 else { return false }
            return candidateID == requestID && state.revision == revision
        }
    }

    func containsChange(generation: UInt64, path: String) -> Bool {
        values.contains {
            guard case .workspaceChanged(let change) = $0 else { return false }
            return change.generation == generation && change.changedPaths.contains(path)
        }
    }
}
