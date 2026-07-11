import Foundation
import os
import AgentDeskWire

/// What the browser needs from the Files transport. Abstracted so the browser's request-issuance and
/// generation-capture orchestration is testable without a live QUIC stream.
protocol WorkspaceFilesRequesting: Sendable {
    func request(_ request: WorkspaceFileRequest) async throws -> WorkspaceFileResponse
}

extension WorkspaceFilesTransport: WorkspaceFilesRequesting {}

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
    private let logger = Logger(subsystem: Config.logSubsystem, category: "workspace-files")

    init(
        transport: WorkspaceFilesRequesting,
        makeRequestID: @escaping @Sendable () -> WorkspaceFileRequestID = { WorkspaceFileRequestID(value: UUID().uuidString) }
    ) {
        self.transport = transport
        self.makeRequestID = makeRequestID
    }

    func loadWorkspaces() async {
        do {
            let response = try await transport.request(.listWorkspaces(requestID: makeRequestID()))
            if case .workspaces(_, let result) = response {
                model = model.withWorkspaces(result.workspaces)
                onChange?()
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
        model = model.selectingWorkspace(id)
        onChange?()
        await loadCurrentDirectory()
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
