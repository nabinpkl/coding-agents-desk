import Foundation
import AgentDeskWire

/// Serializes every authenticated file operation against the current workspace store. All workspace
/// lanes share one responder, so requests run one at a time on this actor's executor.
///
/// This serialization is load-bearing for write correctness: `WorkspaceFileService.write` reads a
/// file, compares its revision, and only then renames the replacement into place, with no `await`
/// in between. Because that read-verify-write is fully synchronous, running it on this actor makes
/// it atomic with respect to every other request — two concurrent writes to the same path cannot
/// both pass the revision guard, so the second is reported as a conflict instead of silently
/// discarding the first writer's change.
actor WorkspaceFilesResponder {
    private let workspaceCoordinator: WorkspaceCoordinator
    private let maxUTF8Bytes: Int
    private let maxDocumentBytes: Int

    init(
        workspaceCoordinator: WorkspaceCoordinator,
        maxUTF8Bytes: Int,
        maxDocumentBytes: Int = WorkspaceLaneCodec.maximumDocumentBytes
    ) {
        self.workspaceCoordinator = workspaceCoordinator
        self.maxUTF8Bytes = maxUTF8Bytes
        self.maxDocumentBytes = maxDocumentBytes
    }

    init(workspaceCoordinator: WorkspaceCoordinator, maxBytes: Int) {
        self.workspaceCoordinator = workspaceCoordinator
        self.maxUTF8Bytes = maxBytes
        self.maxDocumentBytes = WorkspaceLaneCodec.maximumDocumentBytes
    }

    func handle(_ request: WorkspaceFileRequest) async -> WorkspaceFileResponse {
        let store: WorkspaceStore
        do {
            store = try await workspaceCoordinator.snapshot()
        } catch {
            // The store file is unreadable or corrupt. Fail loud to the caller rather than serve a
            // silent empty workspace list that would look like "no workspaces".
            return .error(
                requestID: request.requestID,
                error: WorkspaceFileError(
                    code: .notFound,
                    message: "Workspace store is unavailable."
                )
            )
        }
        // Synchronous: this runs to completion on the actor before any other request, which is what
        // makes the revision-checked write atomic.
        return WorkspaceFileService(
            store: store,
            maxUTF8Bytes: maxUTF8Bytes,
            maxDocumentBytes: maxDocumentBytes
        ).handle(request)
    }
}
