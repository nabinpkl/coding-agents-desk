import AgentDeskWire
import Foundation

public enum WorkspaceIDELaneDataSourceError: Error, Equatable {
    case unexpectedResponse
    case file(WorkspaceFileErrorCode)
    case workspace(WorkspaceLaneErrorCode)
}

/// Transport-neutral projection of the protocol-v11 workspace lane into the IDE data-source contract.
/// The iPhone supplies QUIC request/event closures while macOS supplies an in-process lane session.
public actor WorkspaceIDELaneDataSource: WorkspaceIDEDataSource {
    public typealias Request = @Sendable (WorkspaceLaneRequest) async throws -> WorkspaceLaneResponse
    public typealias Events = @Sendable () async -> AsyncStream<WorkspaceLaneResponse>

    private let request: Request
    private let eventSource: Events

    public init(request: @escaping Request, events: @escaping Events) {
        self.request = request
        self.eventSource = events
    }

    public func listWorkspaces() async throws -> [WorkspaceSummary] {
        let response = try await file(.listWorkspaces(requestID: requestID()))
        guard case .workspaces(_, let result) = response else { throw mappedError(response) }
        return result.workspaces
    }

    public func listDirectory(workspaceID: String, path: String) async throws -> [WorkspaceDirectoryEntry] {
        let response = try await file(.listDirectory(
            requestID: requestID(), workspaceID: workspaceID, path: path
        ))
        guard case .directory(_, let result) = response else { throw mappedError(response) }
        return result.entries
    }

    public func readFile(workspaceID: String, path: String) async throws -> WorkspaceFileReadResult {
        let response = try await file(.read(
            requestID: requestID(), workspaceID: workspaceID, path: path
        ))
        guard case .read(_, let result) = response else { throw mappedError(response) }
        return result
    }

    public func writeFile(
        workspaceID: String,
        path: String,
        expectedRevision: WorkspaceFileRevision,
        text: String
    ) async throws -> WorkspaceIDEWriteOutcome {
        let response = try await file(.write(
            requestID: requestID(), workspaceID: workspaceID, path: path,
            expectedRevision: expectedRevision, text: text
        ))
        switch response {
        case .write(_, let result): return .saved(result)
        case .conflict(_, let conflict): return .conflict(conflict)
        default: throw mappedError(response)
        }
    }

    public func subscribe(workspaceID: String) async throws -> WorkspaceIDESharedState {
        let response = try await request(.subscribe(requestID: requestID(), workspaceID: workspaceID))
        guard case .ideSnapshot(_, let state) = response else { throw mappedError(response) }
        return state
    }

    public func unsubscribe(workspaceID: String) async {
        _ = try? await request(.unsubscribe(requestID: requestID(), workspaceID: workspaceID))
    }

    public func apply(
        workspaceID: String,
        baseRevision: UInt64,
        operationID: WorkspaceIDEOperationID,
        operation: WorkspaceIDEOperation
    ) async throws -> WorkspaceIDESharedState {
        let response = try await request(.operation(
            requestID: requestID(), workspaceID: workspaceID, baseRevision: baseRevision,
            operationID: operationID, operation: operation
        ))
        guard case .ideSnapshot(_, let state) = response else { throw mappedError(response) }
        return state
    }

    public func gitStatus(workspaceID: String) async throws -> WorkspaceGitStatusResult {
        let response = try await request(.gitStatus(requestID: requestID(), workspaceID: workspaceID))
        guard case .gitStatus(_, let result) = response else { throw mappedError(response) }
        return result
    }

    public func events() async -> AsyncStream<WorkspaceIDEDataEvent> {
        let updates = await eventSource()
        return AsyncStream { continuation in
            let task = Task {
                for await response in updates {
                    switch response {
                    case .ideSnapshot(nil, let state): continuation.yield(.sharedState(state))
                    case .gitStatus(nil, let result): continuation.yield(.gitStatus(result))
                    case .workspaceChanged(let change): continuation.yield(.workspaceChanged(change))
                    case .workspaceList(let list): continuation.yield(.workspaces(list.workspaces))
                    case .files, .ideSnapshot, .gitStatus, .error: continue
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func file(_ requestBody: WorkspaceFileRequest) async throws -> WorkspaceFileResponse {
        let response = try await request(.files(requestBody))
        guard case .files(let fileResponse) = response else { throw mappedError(response) }
        return fileResponse
    }

    private func mappedError(_ response: WorkspaceFileResponse) -> WorkspaceIDELaneDataSourceError {
        if case .error(_, let error) = response { return .file(error.code) }
        return .unexpectedResponse
    }

    private func mappedError(_ response: WorkspaceLaneResponse) -> WorkspaceIDELaneDataSourceError {
        if case .error(let error) = response { return .workspace(error.code) }
        return .unexpectedResponse
    }

    private func requestID() -> WorkspaceRequestID {
        WorkspaceRequestID(value: UUID().uuidString)
    }
}
