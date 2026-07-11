import Foundation
import AgentDeskWire

/// Pure navigation and listing state for the iOS Files surface (R28). UIKit-free so it can be
/// exercised directly in tests; a controller drives it by issuing `WorkspaceFileRequest`s over the
/// transport and folding the responses back in with these transitions. Every transition returns a
/// new value (no in-place mutation of shared state), matching the workspace store's style.
///
/// Responses are correlated by `generation`: every transition that starts a new pending request
/// (workspace select, descend, ascend) bumps it, and the controller echoes the generation it
/// captured when it issued a request back through `directoryLoaded`/`failed`. A response whose
/// generation no longer matches answers a superseded request and is ignored, so a late listing — or
/// a late failure — can never clobber a newer navigation. Bare path equality is not enough because
/// two distinct visits to the same path share a path string but not a generation.
struct WorkspaceFilesBrowserModel: Equatable {
    enum Status: Equatable {
        case idle
        case loading
        case loaded
        case failed(String)
    }

    private(set) var workspaces: [WorkspaceSummary]
    private(set) var selectedWorkspaceID: String?
    /// The current directory, workspace-relative. Empty string is the workspace root.
    private(set) var path: String
    private(set) var entries: [WorkspaceDirectoryEntry]
    private(set) var status: Status
    /// Monotonic counter identifying the current pending navigation. Responses echo the generation
    /// captured when their request was issued; a mismatch means the response is stale.
    private(set) var generation: Int

    init(
        workspaces: [WorkspaceSummary] = [],
        selectedWorkspaceID: String? = nil,
        path: String = "",
        entries: [WorkspaceDirectoryEntry] = [],
        status: Status = .idle,
        generation: Int = 0
    ) {
        self.workspaces = workspaces
        self.selectedWorkspaceID = selectedWorkspaceID
        self.path = path
        self.entries = entries
        self.status = status
        self.generation = generation
    }

    var canNavigateUp: Bool { !path.isEmpty }

    /// The path components from the workspace root to the current directory, for a breadcrumb.
    var breadcrumb: [String] {
        path.isEmpty ? [] : path.split(separator: "/").map(String.init)
    }

    func withWorkspaces(_ workspaces: [WorkspaceSummary]) -> Self {
        var copy = self
        copy.workspaces = workspaces
        return copy
    }

    /// Selects a workspace and resets navigation to its root, pending a directory listing.
    func selectingWorkspace(_ id: String) -> Self {
        var copy = self
        copy.selectedWorkspaceID = id
        copy.path = ""
        copy.entries = []
        copy.status = .loading
        copy.generation += 1
        return copy
    }

    /// Descends into a directory entry. A file entry is not navigable and leaves state unchanged.
    func enteringDirectory(_ entry: WorkspaceDirectoryEntry) -> Self {
        guard entry.isDirectory else { return self }
        var copy = self
        copy.path = entry.path
        copy.entries = []
        copy.status = .loading
        copy.generation += 1
        return copy
    }

    /// Ascends one directory level. A no-op at the workspace root.
    func navigatingUp() -> Self {
        guard canNavigateUp else { return self }
        var copy = self
        copy.path = path.split(separator: "/").dropLast().joined(separator: "/")
        copy.entries = []
        copy.status = .loading
        copy.generation += 1
        return copy
    }

    /// Applies a directory listing to the request identified by `generation`. A response for a
    /// superseded navigation (generation no longer current) is stale and ignored.
    func directoryLoaded(generation: Int, entries: [WorkspaceDirectoryEntry]) -> Self {
        guard generation == self.generation else { return self }
        var copy = self
        copy.entries = entries
        copy.status = .loaded
        return copy
    }

    /// Records a failure for the request identified by `generation`. A failure from a superseded
    /// navigation is ignored, so a late error can never clobber a newer, already-loaded directory.
    func failed(generation: Int, message: String) -> Self {
        guard generation == self.generation else { return self }
        var copy = self
        copy.status = .failed(message)
        return copy
    }
}
