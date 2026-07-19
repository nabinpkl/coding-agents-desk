import Foundation
import Testing
import AgentDeskWire

@testable import AgentDeskHost

@MainActor
struct WorkspaceObservationCoordinatorTests {
    @Test func sharesOneWatchAndOneGitReadPerGeneration() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let workspace = Workspace(id: UUID(), root: root, name: "Project")
        let reader = CountingGitReader()
        let watches = WatchRecorder()
        let firstUpdates = ObservationRecorder()
        let secondUpdates = ObservationRecorder()
        let coordinator = WorkspaceObservationCoordinator(
            reader: reader,
            makeWatch: { callback in watches.make(callback: callback) }
        )

        let first = coordinator.observe(workspace: workspace) { firstUpdates.append($0) }
        let second = coordinator.observe(workspace: workspace) { secondUpdates.append($0) }
        await waitUntil { reader.count == 1 && firstUpdates.count == 1 && secondUpdates.count == 1 }
        #expect(watches.created.count == 1)

        watches.created[0].trigger([
            root.appendingPathComponent("src/main.swift").path,
            "/outside/ignored.txt"
        ])
        await waitUntil { reader.count == 2 && firstUpdates.count == 2 && secondUpdates.count == 2 }
        #expect(firstUpdates.values.last?.change.generation == 1)
        #expect(firstUpdates.values.last?.change.changedPaths == ["src/main.swift"])

        coordinator.unobserve(first)
        #expect(watches.created[0].stopCount == 0)
        coordinator.unobserve(second)
        #expect(watches.created[0].stopCount == 1)
    }

    private func waitUntil(_ condition: @escaping () -> Bool) async {
        for _ in 0..<100 where !condition() {
            try? await Task.sleep(for: .milliseconds(10))
        }
        #expect(condition())
    }
}

private final class CountingGitReader: WorkspaceGitStatusReading, @unchecked Sendable {
    private let lock = NSLock()
    private var storage = 0
    var count: Int { lock.withLock { storage } }

    func readSnapshot(workspaceRoot: URL) -> WorkspaceGitSnapshot {
        lock.withLock { storage += 1 }
        return WorkspaceGitSnapshot(status: .empty, entries: [])
    }
}

@MainActor
private final class WatchRecorder {
    private(set) var created: [FakeObservationWatch] = []
    func make(callback: @escaping ([String]) -> Void) -> FakeObservationWatch {
        let watch = FakeObservationWatch(callback: callback)
        created.append(watch)
        return watch
    }
}

@MainActor
private final class FakeObservationWatch: WorkspaceObservationWatch {
    private let callback: ([String]) -> Void
    private(set) var stopCount = 0
    init(callback: @escaping ([String]) -> Void) { self.callback = callback }
    func start(root: URL) {}
    func stop() { stopCount += 1 }
    func trigger(_ paths: [String]) { callback(paths) }
}

@MainActor
private final class ObservationRecorder {
    private(set) var values: [WorkspaceObservationUpdate] = []
    var count: Int { values.count }
    func append(_ update: WorkspaceObservationUpdate) { values.append(update) }
}
