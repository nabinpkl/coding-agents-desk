import Foundation
import AgentDeskWire

@MainActor
protocol WorkspaceObservationWatch: AnyObject {
    func start(root: URL)
    func stop()
}

extension FolderWatch: WorkspaceObservationWatch {}

protocol WorkspaceGitStatusReading: Sendable {
    func readSnapshot(workspaceRoot: URL) -> WorkspaceGitSnapshot
}

extension GitStatusReader: WorkspaceGitStatusReading {}

struct WorkspaceObservationSubscription: Hashable, Sendable {
    fileprivate let value: UUID
}

struct WorkspaceObservationUpdate: Sendable {
    let change: WorkspaceChangedPush
    let git: WorkspaceGitStatusResult
    let nativeGitStatus: GitStatus
}

/// Reference-counts one recursive watcher per workspace and performs exactly one Git read for each
/// emitted filesystem generation. Native and remote consumers receive the same immutable update.
@MainActor
final class WorkspaceObservationCoordinator {
    typealias Subscriber = @MainActor (WorkspaceObservationUpdate) -> Void
    typealias WatchFactory = @MainActor (@escaping ([String]) -> Void) -> any WorkspaceObservationWatch

    private final class Entry {
        let workspace: Workspace
        let watch: any WorkspaceObservationWatch
        var generation: UInt64 = 0
        var changedPaths: [String] = []
        var latest: WorkspaceObservationUpdate?
        var subscribers: [WorkspaceObservationSubscription: Subscriber] = [:]
        var readTask: Task<Void, Never>?

        init(workspace: Workspace, watch: any WorkspaceObservationWatch) {
            self.workspace = workspace
            self.watch = watch
        }
    }

    private let reader: any WorkspaceGitStatusReading
    private let makeWatch: WatchFactory
    private var entries: [UUID: Entry] = [:]

    init(
        reader: any WorkspaceGitStatusReading = GitStatusReader(),
        makeWatch: @escaping WatchFactory = { callback in FolderWatch(onChange: callback) }
    ) {
        self.reader = reader
        self.makeWatch = makeWatch
    }

    func observe(
        workspace: Workspace,
        receive: @escaping Subscriber
    ) -> WorkspaceObservationSubscription {
        let token = WorkspaceObservationSubscription(value: UUID())
        let entry: Entry
        if let existing = entries[workspace.id] {
            entry = existing
        } else {
            let id = workspace.id
            let watch = makeWatch { [weak self] paths in self?.handleChange(workspaceID: id, absolutePaths: paths) }
            entry = Entry(workspace: workspace, watch: watch)
            entries[id] = entry
            watch.start(root: workspace.root)
            read(workspaceID: id)
        }
        entry.subscribers[token] = receive
        if let latest = entry.latest { receive(latest) }
        return token
    }

    func unobserve(_ token: WorkspaceObservationSubscription) {
        guard let pair = entries.first(where: { $0.value.subscribers[token] != nil }) else { return }
        pair.value.subscribers.removeValue(forKey: token)
        guard pair.value.subscribers.isEmpty else { return }
        pair.value.readTask?.cancel()
        pair.value.watch.stop()
        entries.removeValue(forKey: pair.key)
    }

    func latestGitResult(workspaceID: UUID) -> WorkspaceGitStatusResult? {
        entries[workspaceID]?.latest?.git
    }

    func latestNativeGitStatus(workspaceID: UUID) -> GitStatus? {
        entries[workspaceID]?.latest?.nativeGitStatus
    }

    func stop() {
        for entry in entries.values {
            entry.readTask?.cancel()
            entry.watch.stop()
        }
        entries.removeAll()
    }

    private func handleChange(workspaceID: UUID, absolutePaths: [String]) {
        guard let entry = entries[workspaceID] else { return }
        entry.generation &+= 1
        entry.changedPaths = relativePaths(absolutePaths, root: entry.workspace.root)
        read(workspaceID: workspaceID)
    }

    private func read(workspaceID: UUID) {
        guard let entry = entries[workspaceID] else { return }
        let generation = entry.generation
        let changedPaths = entry.changedPaths
        let workspace = entry.workspace
        let reader = self.reader
        entry.readTask?.cancel()
        entry.readTask = Task { [weak self] in
            let snapshot = await Task.detached(priority: .userInitiated) {
                reader.readSnapshot(workspaceRoot: workspace.root)
            }.value
            guard !Task.isCancelled, let self, let current = self.entries[workspaceID],
                  current.generation == generation else { return }
            let update = WorkspaceObservationUpdate(
                change: WorkspaceChangedPush(
                    workspaceID: workspaceID.uuidString,
                    generation: generation,
                    changedPaths: changedPaths
                ),
                git: WorkspaceGitStatusResult(
                    workspaceID: workspaceID.uuidString,
                    generation: generation,
                    entries: snapshot.entries
                ),
                nativeGitStatus: snapshot.status
            )
            current.latest = update
            for subscriber in current.subscribers.values { subscriber(update) }
        }
    }

    private func relativePaths(_ absolutePaths: [String], root: URL) -> [String] {
        let rootPath = root.standardizedFileURL.path
        let prefix = rootPath.hasSuffix("/") ? rootPath : rootPath + "/"
        return Array(Set(absolutePaths.compactMap { raw -> String? in
            let path = URL(fileURLWithPath: raw).standardizedFileURL.path
            if path == rootPath { return "" }
            guard path.hasPrefix(prefix) else { return nil }
            return String(path.dropFirst(prefix.count))
        })).sorted()
    }
}
