import Foundation
import AgentDeskWire

/// Owns the workspace store lifecycle for the macOS shell (R21): loads the authoritative store,
/// registers new roots, selects the active workspace, and vends a root-scoped file tree for the
/// active workspace. It also reads and writes files in the active workspace through the shared
/// `WorkspaceFilesResponder`, so a macOS-shell edit and an iOS `.files` edit serialize against the
/// same actor rather than racing two independent write paths. The AppKit shell panel renders from
/// this and calls its mutators; the controller holds no view state, keeping shell feature state out
/// of `AppDelegate`.
@MainActor
final class WorkspaceShellController {
    private let repository: WorkspaceRepository
    private let filesResponder: WorkspaceFilesResponder
    private(set) var store: WorkspaceStore
    /// True while a mutator is in flight. Add/select/load are deliberate, low-frequency user actions,
    /// so a second overlapping call is rejected rather than allowed to clobber `store` with a stale
    /// result (the MainActor continuation resume order is not tied to the actor's processing order).
    private var isMutating = false
    /// Called after the store changes so the panel can re-render.
    var onChange: (() -> Void)?

    init(
        repository: WorkspaceRepository,
        filesResponder: WorkspaceFilesResponder,
        store: WorkspaceStore = WorkspaceStore()
    ) {
        self.repository = repository
        self.filesResponder = filesResponder
        self.store = store
    }

    /// Loads the authoritative store (importing the donor once on first run). Throws loud on a
    /// corrupt store rather than presenting an empty shell that looks like "no workspaces".
    func load() async throws {
        try await mutate { repository in
            let loaded = try await repository.load()
            // A persisted store can carry workspaces with no active selection: the donor import
            // deliberately leaves `activeID` nil, and older stores predate the field. Select the
            // first workspace so the shell renders its file tree instead of an empty pane, mirroring
            // the iOS Files surface's single-workspace auto-select. The selection is persisted, so a
            // later launch loads with an active workspace and this no-ops.
            guard loaded.active == nil, let first = loaded.workspaces.first else {
                return loaded
            }
            return try await repository.select(first.id)
        }
    }

    /// Registers a workspace root and makes it active. The repository validates the root (exists, is
    /// a directory, not a symlink) and persists the store.
    func addWorkspace(root: URL, name: String? = nil) async throws {
        try await mutate { try await $0.register(root: root, name: name ?? root.lastPathComponent) }
    }

    func selectWorkspace(_ id: UUID) async throws {
        try await mutate { try await $0.select(id) }
    }

    /// Runs one store mutation under the busy-guard. The guard-then-set is synchronous before the
    /// first await, so a concurrent second call observes `isMutating == true` and returns without
    /// issuing a racing repository op.
    private func mutate(_ operation: (WorkspaceRepository) async throws -> WorkspaceStore) async rethrows {
        guard !isMutating else { return }
        isMutating = true
        defer { isMutating = false }
        store = try await operation(repository)
        onChange?()
    }

    /// A root-scoped file tree for the active workspace, or nil when none is selected. The tree
    /// enforces workspace-root containment and never expands symlinks.
    func activeFileTree(
        reader: WorkspaceShellDirectoryReading = FileManagerWorkspaceShellDirectoryReader()
    ) -> WorkspaceShellFileTree? {
        guard let active = store.active else { return nil }
        return WorkspaceShellFileTree(workspaceID: active.id, root: active.root, reader: reader)
    }

    /// Reads a workspace-relative file through the shared responder. The workspace id is passed
    /// explicitly (captured when an edit session opens) so a mid-session workspace switch can't
    /// redirect the read to a different workspace.
    func readFile(workspaceID: String, path: String) async -> WorkspaceFileResponse {
        await filesResponder.handle(
            .read(requestID: makeRequestID(), workspaceID: workspaceID, path: path)
        )
    }

    /// Writes a workspace-relative file, revision-checked against `expectedRevision`, through the
    /// shared responder (serialized with iOS `.files` writes). The workspace id is explicit for the
    /// same reason as `readFile`.
    func writeFile(
        workspaceID: String,
        path: String,
        expectedRevision: WorkspaceFileRevision,
        text: String
    ) async -> WorkspaceFileResponse {
        await filesResponder.handle(
            .write(requestID: makeRequestID(), workspaceID: workspaceID, path: path, expectedRevision: expectedRevision, text: text)
        )
    }

    private func makeRequestID() -> WorkspaceFileRequestID {
        WorkspaceFileRequestID(value: UUID().uuidString)
    }
}
