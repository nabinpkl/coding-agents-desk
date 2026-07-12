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

    /// The file preview/editor overlay, correlated by `previewGeneration` just like navigation. A
    /// loaded preview carries the revision it was read at, so a save can be revision-checked.
    enum Preview: Equatable {
        case loading(path: String)
        case loaded(path: String, text: String, revision: WorkspaceFileRevision)
        case failed(path: String, message: String)

        var path: String {
            switch self {
            case .loading(let path), .loaded(let path, _, _), .failed(let path, _):
                path
            }
        }

        var revision: WorkspaceFileRevision? {
            if case .loaded(_, _, let revision) = self { return revision }
            return nil
        }
    }

    /// The state of an in-progress save of the open file.
    enum SaveStatus: Equatable {
        case idle
        case saving
        /// The host has a newer revision; the user's edits were not written.
        case conflict
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
    /// The active file preview, or nil when no file is open.
    private(set) var preview: Preview?
    /// Monotonic counter identifying the current pending file read, correlated like `generation`.
    private(set) var previewGeneration: Int
    /// The state of an in-progress save of the open file.
    private(set) var saveStatus: SaveStatus

    init(
        workspaces: [WorkspaceSummary] = [],
        selectedWorkspaceID: String? = nil,
        path: String = "",
        entries: [WorkspaceDirectoryEntry] = [],
        status: Status = .idle,
        generation: Int = 0,
        preview: Preview? = nil,
        previewGeneration: Int = 0,
        saveStatus: SaveStatus = .idle
    ) {
        self.workspaces = workspaces
        self.selectedWorkspaceID = selectedWorkspaceID
        self.path = path
        self.entries = entries
        self.status = status
        self.generation = generation
        self.preview = preview
        self.previewGeneration = previewGeneration
        self.saveStatus = saveStatus
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
        copy.dismissPreview()
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
        copy.dismissPreview()
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
        copy.dismissPreview()
        return copy
    }

    /// Closes any open preview and invalidates an in-flight read. Navigation always closes the
    /// preview so the model — not the view's overlay z-order — is the single authority that a
    /// preview and a directory listing are never shown for different locations at once.
    private mutating func dismissPreview() {
        guard preview != nil else { return }
        preview = nil
        previewGeneration += 1
        saveStatus = .idle
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

    /// Opens a file preview, pending its content. A directory is not previewable and is ignored.
    func openingFile(_ entry: WorkspaceDirectoryEntry) -> Self {
        guard !entry.isDirectory else { return self }
        var copy = self
        copy.preview = .loading(path: entry.path)
        copy.previewGeneration += 1
        copy.saveStatus = .idle
        return copy
    }

    func previewLoaded(previewGeneration: Int, text: String, revision: WorkspaceFileRevision) -> Self {
        guard previewGeneration == self.previewGeneration, let path = preview?.path else { return self }
        var copy = self
        copy.preview = .loaded(path: path, text: text, revision: revision)
        copy.saveStatus = .idle
        return copy
    }

    func previewFailed(previewGeneration: Int, message: String) -> Self {
        guard previewGeneration == self.previewGeneration, let path = preview?.path else { return self }
        var copy = self
        copy.preview = .failed(path: path, message: message)
        return copy
    }

    /// Marks the open file as saving. Only valid while a loaded preview is showing.
    func savingFile() -> Self {
        guard case .loaded = preview else { return self }
        var copy = self
        copy.saveStatus = .saving
        return copy
    }

    /// Applies a successful save: the open file's baseline text and revision advance to what was
    /// written, so a subsequent save is checked against the new revision.
    func saved(previewGeneration: Int, text: String, revision: WorkspaceFileRevision) -> Self {
        guard previewGeneration == self.previewGeneration, let path = preview?.path else { return self }
        var copy = self
        copy.preview = .loaded(path: path, text: text, revision: revision)
        copy.saveStatus = .idle
        return copy
    }

    /// The host had a newer revision; the user's edits were not written and are preserved in the
    /// editor for the user to reconcile.
    func saveConflicted(previewGeneration: Int) -> Self {
        guard previewGeneration == self.previewGeneration else { return self }
        var copy = self
        copy.saveStatus = .conflict
        return copy
    }

    func saveFailed(previewGeneration: Int, message: String) -> Self {
        guard previewGeneration == self.previewGeneration else { return self }
        var copy = self
        copy.saveStatus = .failed(message)
        return copy
    }

    /// Dismisses the preview and supersedes any in-flight read or save so its late response is
    /// ignored, and resets save state.
    func closingPreview() -> Self {
        var copy = self
        copy.preview = nil
        copy.previewGeneration += 1
        copy.saveStatus = .idle
        return copy
    }
}
