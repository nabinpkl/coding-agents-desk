import AgentDeskWire
import WorkspaceIDE

enum WorkspaceIDELocalLaneBridgeError: Error {
    case stopped
}

/// In-process protocol-v11 lane used by the Mac IDE. It deliberately passes through
/// `WorkspaceLaneSession`, so local and iPhone IDEs exercise the same request and push semantics.
@MainActor
final class WorkspaceIDELocalLaneBridge {
    let dataSource: WorkspaceIDELaneDataSource

    private let session: WorkspaceLaneSession
    private let continuation: AsyncStream<WorkspaceLaneResponse>.Continuation
    private var stopped = false

    init(
        files: WorkspaceFilesResponder,
        workspaces: WorkspaceCoordinator,
        ideState: WorkspaceIDEStateCoordinator,
        observation: WorkspaceObservationCoordinator
    ) {
        let pair = AsyncStream<WorkspaceLaneResponse>.makeStream()
        continuation = pair.continuation
        session = WorkspaceLaneSession(
            push: { response in pair.continuation.yield(response) },
            files: files,
            workspaces: workspaces,
            ideState: ideState,
            observation: observation
        )
        dataSource = WorkspaceIDELaneDataSource(
            request: { [weak session] request in
                guard let session else { throw WorkspaceIDELocalLaneBridgeError.stopped }
                return await session.handle(request)
            },
            events: { pair.stream }
        )
    }

    func stop() {
        guard !stopped else { return }
        stopped = true
        continuation.finish()
        Task { [session] in await session.stop() }
    }
}
