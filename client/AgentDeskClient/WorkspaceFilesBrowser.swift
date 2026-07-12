import Foundation
import os
import AgentDeskWire

/// What the browser needs from the Files transport. Abstracted so the browser's request-issuance and
/// generation-capture orchestration is testable without a live QUIC stream.
protocol WorkspaceFilesRequesting: Sendable {
    func request(_ request: WorkspaceFileRequest) async throws -> WorkspaceFileResponse
}

extension WorkspaceFilesTransport: WorkspaceFilesRequesting {}

struct WorkspaceFilesResumeState: Equatable, Sendable {
    let workspaceID: String
    let filePath: String?
}

protocol WorkspaceFilesResumeStoring: AnyObject {
    var state: WorkspaceFilesResumeState? { get set }
}

final class WorkspaceFilesResumeStore: WorkspaceFilesResumeStoring, @unchecked Sendable {
    static let shared = WorkspaceFilesResumeStore()

    private enum Key {
        static let workspaceID = "agentDesk.workspaceFiles.workspaceID"
        static let filePath = "agentDesk.workspaceFiles.filePath"
    }

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    var state: WorkspaceFilesResumeState? {
        get {
            guard let workspaceID = defaults.string(forKey: Key.workspaceID) else { return nil }
            return WorkspaceFilesResumeState(
                workspaceID: workspaceID,
                filePath: defaults.string(forKey: Key.filePath)
            )
        }
        set {
            guard let newValue else {
                defaults.removeObject(forKey: Key.workspaceID)
                defaults.removeObject(forKey: Key.filePath)
                return
            }
            defaults.set(newValue.workspaceID, forKey: Key.workspaceID)
            if let filePath = newValue.filePath {
                defaults.set(filePath, forKey: Key.filePath)
            } else {
                defaults.removeObject(forKey: Key.filePath)
            }
        }
    }
}

/// Drives the iOS Files surface: it owns the `WorkspaceFilesBrowserModel`, issues the matching
/// `WorkspaceFileRequest` for each navigation over the transport, and folds each response back into
/// the model tagged with the generation captured when the request was issued. Because the model
/// ignores responses for a superseded generation, a navigation that happens while a request is in
/// flight simply supersedes it — the late response is dropped rather than shown.
@MainActor
final class WorkspaceFilesBrowser {
    private(set) var model = WorkspaceFilesBrowserModel()
    /// Called after any model change so a view can re-render. Set by the surface controller.
    var onChange: (() -> Void)?

    private let transport: WorkspaceFilesRequesting
    private let makeRequestID: @Sendable () -> WorkspaceFileRequestID
    private let resumeStore: WorkspaceFilesResumeStoring
    private let logger = Logger(subsystem: Config.logSubsystem, category: "workspace-files")

    init(
        transport: WorkspaceFilesRequesting,
        makeRequestID: @escaping @Sendable () -> WorkspaceFileRequestID = { WorkspaceFileRequestID(value: UUID().uuidString) },
        resumeStore: WorkspaceFilesResumeStoring = WorkspaceFilesResumeStore.shared
    ) {
        self.transport = transport
        self.makeRequestID = makeRequestID
        self.resumeStore = resumeStore
    }

    func loadWorkspaces() async {
        do {
            let response = try await transport.request(.listWorkspaces(requestID: makeRequestID()))
            if case .workspaces(_, let result) = response {
                model = model.withWorkspaces(result.workspaces)
                onChange?()
                await restoreSelection(from: result.workspaces)
            } else {
                // The host answers .listWorkspaces with .error when its store is unreadable; surface
                // that rather than leaving the view silently stuck.
                model = model.failed(generation: model.generation, message: failureMessage(response))
                onChange?()
            }
        } catch {
            model = model.failed(generation: model.generation, message: message(for: error))
            onChange?()
        }
    }

    func selectWorkspace(_ id: String) async {
        resumeStore.state = WorkspaceFilesResumeState(workspaceID: id, filePath: nil)
        model = model.selectingWorkspace(id)
        onChange?()
        await loadCurrentDirectory()
    }

    private func restoreSelection(from workspaces: [WorkspaceSummary]) async {
        guard let state = resumeStore.state else { return }
        guard workspaces.contains(where: { $0.id == state.workspaceID }) else {
            resumeStore.state = nil
            return
        }
        model = model.selectingWorkspace(state.workspaceID)
        onChange?()
        await loadCurrentDirectory()
        guard model.selectedWorkspaceID == state.workspaceID, resumeStore.state == state else { return }
        if let filePath = state.filePath, !filePath.isEmpty {
            await openFile(WorkspaceDirectoryEntry(
                name: (filePath as NSString).lastPathComponent,
                path: filePath,
                isDirectory: false
            ), workspaceID: state.workspaceID)
        }
    }

    func enter(_ entry: WorkspaceDirectoryEntry) async {
        let updated = model.enteringDirectory(entry)
        guard updated != model else { return } // a file tap is not a navigation
        model = updated
        onChange?()
        await loadCurrentDirectory()
    }

    func navigateUp() async {
        let updated = model.navigatingUp()
        guard updated != model else { return } // already at the root
        model = updated
        onChange?()
        await loadCurrentDirectory()
    }

    func openFile(_ entry: WorkspaceDirectoryEntry) async {
        guard !entry.isDirectory, let workspaceID = model.selectedWorkspaceID else { return }
        await openFile(entry, workspaceID: workspaceID)
    }

    private func openFile(_ entry: WorkspaceDirectoryEntry, workspaceID: String) async {
        guard !entry.isDirectory, model.selectedWorkspaceID == workspaceID else { return }
        resumeStore.state = WorkspaceFilesResumeState(workspaceID: workspaceID, filePath: entry.path)
        model = model.openingFile(entry)
        onChange?()
        let previewGeneration = model.previewGeneration
        do {
            let response = try await transport.request(
                .read(requestID: makeRequestID(), workspaceID: workspaceID, path: entry.path)
            )
            if case .error = response {
                clearRememberedFile(workspaceID: workspaceID, path: entry.path)
            }
            applyPreview(response, previewGeneration: previewGeneration)
        } catch {
            model = model.previewFailed(previewGeneration: previewGeneration, message: message(for: error))
            onChange?()
        }
    }

    private func clearRememberedFile(workspaceID: String, path: String) {
        guard resumeStore.state == WorkspaceFilesResumeState(workspaceID: workspaceID, filePath: path) else {
            return
        }
        resumeStore.state = WorkspaceFilesResumeState(workspaceID: workspaceID, filePath: nil)
    }

    func closePreview() {
        model = model.closingPreview()
        onChange?()
    }

    private func applyPreview(_ response: WorkspaceFileResponse, previewGeneration: Int) {
        let previous = model
        switch response {
        case .read(_, let result):
            model = model.previewLoaded(
                previewGeneration: previewGeneration, text: result.text, revision: result.revision
            )
        case .error, .workspaces, .directory, .write, .conflict:
            model = model.previewFailed(previewGeneration: previewGeneration, message: failureMessage(response))
        }
        if model != previous { onChange?() }
    }

    /// Writes the editor's text back to the open file, revision-checked against what was read. A
    /// stale revision (the host changed the file since) comes back as a conflict without overwriting.
    func saveFile(_ text: String) async {
        // Don't overlap saves: a second in-flight write for the same file would carry the same
        // stale expectedRevision and come back as a misleading self-inflicted conflict. Guard in the
        // browser rather than trusting the view to disable its button.
        guard model.saveStatus != .saving else { return }
        guard let workspaceID = model.selectedWorkspaceID,
              case .loaded(let path, _, let revision)? = model.preview
        else { return }
        model = model.savingFile()
        onChange?()
        let previewGeneration = model.previewGeneration
        do {
            let response = try await transport.request(.write(
                requestID: makeRequestID(), workspaceID: workspaceID,
                path: path, expectedRevision: revision, text: text
            ))
            applySave(response, previewGeneration: previewGeneration, text: text)
        } catch {
            model = model.saveFailed(previewGeneration: previewGeneration, message: message(for: error))
            onChange?()
        }
    }

    private func applySave(_ response: WorkspaceFileResponse, previewGeneration: Int, text: String) {
        let previous = model
        switch response {
        case .write(_, let result):
            model = model.saved(previewGeneration: previewGeneration, text: text, revision: result.revision)
        case .conflict:
            model = model.saveConflicted(previewGeneration: previewGeneration)
        case .error, .workspaces, .directory, .read:
            model = model.saveFailed(previewGeneration: previewGeneration, message: failureMessage(response))
        }
        if model != previous { onChange?() }
    }

    private func loadCurrentDirectory() async {
        guard let workspaceID = model.selectedWorkspaceID else { return }
        // Capture the generation this request belongs to, so a response that arrives after a newer
        // navigation is correlated to (and rejected by) the model as stale.
        let generation = model.generation
        let path = model.path
        do {
            let response = try await transport.request(
                .listDirectory(requestID: makeRequestID(), workspaceID: workspaceID, path: path)
            )
            apply(response, generation: generation)
        } catch {
            model = model.failed(generation: generation, message: message(for: error))
            onChange?()
        }
    }

    private func apply(_ response: WorkspaceFileResponse, generation: Int) {
        let previous = model
        switch response {
        case .directory(_, let result):
            model = model.directoryLoaded(generation: generation, entries: result.entries)
        case .error, .workspaces, .read, .write, .conflict:
            model = model.failed(generation: generation, message: failureMessage(response))
        }
        // The model no-ops a superseded generation; skip the redundant re-render in that case.
        if model != previous { onChange?() }
    }

    /// A user-facing message for a response that is not the success we expected, logging the real
    /// response so a field failure stays diagnosable behind the collapsed string.
    private func failureMessage(_ response: WorkspaceFileResponse) -> String {
        if case .error(_, let error) = response {
            logger.error("workspace files error: \(String(describing: error), privacy: .public)")
            return error.message ?? "The request failed."
        }
        logger.error("unexpected workspace files response: \(String(describing: response), privacy: .public)")
        return "Unexpected response from the workspace."
    }

    private func message(for error: Error) -> String {
        logger.error("workspace files transport error: \(String(describing: error), privacy: .public)")
        if error is WorkspaceFilesTransportError { return "The connection to the workspace was lost." }
        return "The request failed."
    }
}
