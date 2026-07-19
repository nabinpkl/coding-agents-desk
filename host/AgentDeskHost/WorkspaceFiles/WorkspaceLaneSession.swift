import Foundation
import AgentDeskWire

/// Per-stream subscription owner for protocol-v11 workspace requests. The shared coordinators own
/// state and observation; this object owns only the lane's subscription lifetimes and projections.
@available(macOS 26.0, *)
@MainActor
final class WorkspaceLaneSession {
    typealias Push = @Sendable (WorkspaceLaneResponse) async -> Void

    private let push: Push
    private let files: WorkspaceFilesResponder
    private let workspaces: WorkspaceCoordinator
    private let ideState: WorkspaceIDEStateCoordinator
    private let observation: WorkspaceObservationCoordinator
    private var stateSubscriptions: [String: WorkspaceIDEStateSubscription] = [:]
    private var observationSubscriptions: [String: WorkspaceObservationSubscription] = [:]
    private var latestGit: [String: WorkspaceGitStatusResult] = [:]
    private var workspaceSubscription: WorkspaceCoordinatorSubscription?

    init(
        push: @escaping Push,
        files: WorkspaceFilesResponder,
        workspaces: WorkspaceCoordinator,
        ideState: WorkspaceIDEStateCoordinator,
        observation: WorkspaceObservationCoordinator
    ) {
        self.push = push
        self.files = files
        self.workspaces = workspaces
        self.ideState = ideState
        self.observation = observation
    }

    func handle(_ request: WorkspaceLaneRequest) async -> WorkspaceLaneResponse {
        await ensureWorkspaceSubscription()
        switch request {
        case .files(let fileRequest):
            return .files(await files.handle(fileRequest))
        case .subscribe(let requestID, let workspaceID):
            return await subscribe(requestID: requestID, workspaceID: workspaceID)
        case .unsubscribe(let requestID, let workspaceID):
            return await unsubscribe(requestID: requestID, workspaceID: workspaceID)
        case .operation(
            let requestID,
            let workspaceID,
            let baseRevision,
            let operationID,
            let operation
        ):
            return await apply(
                requestID: requestID,
                workspaceID: workspaceID,
                baseRevision: baseRevision,
                operationID: operationID,
                operation: operation
            )
        case .gitStatus(let requestID, let workspaceID):
            guard await workspaceExists(workspaceID) else {
                return error(requestID, workspaceID, .workspaceUnavailable)
            }
            let result = latestGit[canonicalWorkspaceID(workspaceID)] ?? WorkspaceGitStatusResult(
                workspaceID: canonicalWorkspaceID(workspaceID),
                generation: 0,
                entries: []
            )
            return .gitStatus(requestID: requestID, result: result)
        }
    }

    func stop() async {
        if let workspaceSubscription {
            await workspaces.unsubscribe(workspaceSubscription)
            self.workspaceSubscription = nil
        }
        for token in observationSubscriptions.values { observation.unobserve(token) }
        observationSubscriptions.removeAll()
        for token in stateSubscriptions.values { await ideState.unsubscribe(token) }
        stateSubscriptions.removeAll()
        latestGit.removeAll()
    }

    private func ensureWorkspaceSubscription() async {
        guard workspaceSubscription == nil else { return }
        workspaceSubscription = await workspaces.subscribe { [push] store in
            let summaries = store.workspaces.map {
                WorkspaceSummary(
                    id: $0.id.uuidString,
                    name: $0.name,
                    desktopOrdinal: $0.desktopAssignment?.ordinal,
                    desktopAutoAssignEnabled: $0.desktopAutoAssignEnabled
                )
            }
            await push(.workspaceList(WorkspaceListPush(workspaces: summaries)))
        }
    }

    private func subscribe(
        requestID: WorkspaceRequestID,
        workspaceID rawWorkspaceID: String
    ) async -> WorkspaceLaneResponse {
        guard await workspaceExists(rawWorkspaceID),
              let workspaceUUID = UUID(uuidString: rawWorkspaceID),
              let workspace = try? await workspaces.workspace(id: workspaceUUID) else {
            return error(requestID, rawWorkspaceID, .workspaceUnavailable)
        }
        let workspaceID = workspaceUUID.uuidString
        if let token = stateSubscriptions.removeValue(forKey: workspaceID) {
            await ideState.unsubscribe(token)
        }
        if let token = observationSubscriptions.removeValue(forKey: workspaceID) {
            observation.unobserve(token)
        }

        do {
            let (stateToken, snapshot) = try await ideState.subscribeAndSnapshot(
                workspaceID: workspaceID
            ) { [push] state in
                await push(.ideSnapshot(requestID: nil, state: state))
            }
            stateSubscriptions[workspaceID] = stateToken
            observationSubscriptions[workspaceID] = observation.observe(workspace: workspace) { [weak self, push] update in
                guard let self else { return }
                self.latestGit[workspaceID] = update.git
                Task {
                    await push(.workspaceChanged(update.change))
                    await push(.gitStatus(requestID: nil, result: update.git))
                }
            }
            return .ideSnapshot(requestID: requestID, state: snapshot)
        } catch {
            return map(error, requestID: requestID, workspaceID: workspaceID)
        }
    }

    private func unsubscribe(
        requestID: WorkspaceRequestID,
        workspaceID rawWorkspaceID: String
    ) async -> WorkspaceLaneResponse {
        let workspaceID = canonicalWorkspaceID(rawWorkspaceID)
        if let token = stateSubscriptions.removeValue(forKey: workspaceID) {
            await ideState.unsubscribe(token)
        }
        if let token = observationSubscriptions.removeValue(forKey: workspaceID) {
            observation.unobserve(token)
        }
        latestGit.removeValue(forKey: workspaceID)
        do {
            return .ideSnapshot(requestID: requestID, state: try await ideState.snapshot(workspaceID: workspaceID))
        } catch {
            return map(error, requestID: requestID, workspaceID: workspaceID)
        }
    }

    private func apply(
        requestID: WorkspaceRequestID,
        workspaceID: String,
        baseRevision: UInt64,
        operationID: WorkspaceIDEOperationID,
        operation: WorkspaceIDEOperation
    ) async -> WorkspaceLaneResponse {
        guard await workspaceExists(workspaceID) else {
            return error(requestID, workspaceID, .workspaceUnavailable)
        }
        do {
            let snapshot = try await ideState.apply(
                workspaceID: workspaceID,
                baseRevision: baseRevision,
                operationID: operationID,
                operation: operation
            )
            return .ideSnapshot(requestID: requestID, state: snapshot)
        } catch {
            return map(error, requestID: requestID, workspaceID: workspaceID)
        }
    }

    private func workspaceExists(_ workspaceID: String) async -> Bool {
        (try? await workspaces.contains(workspaceID: workspaceID)) == true
    }

    private func canonicalWorkspaceID(_ raw: String) -> String {
        UUID(uuidString: raw)?.uuidString ?? raw
    }

    private func map(
        _ source: Error,
        requestID: WorkspaceRequestID,
        workspaceID: String
    ) -> WorkspaceLaneResponse {
        switch source {
        case WorkspaceIDEStateCoordinatorError.revisionConflict:
            return error(requestID, workspaceID, .revisionConflict)
        case WorkspaceIDEStateCoordinatorError.invalidWorkspaceID:
            return error(requestID, workspaceID, .workspaceUnavailable)
        case WorkspaceIDEStateCoordinatorError.invalidOperationID,
             WorkspaceIDEStateCoordinatorError.invalidPath,
             WorkspaceIDEStateCoordinatorError.invalidReorder,
             WorkspaceIDEStateCoordinatorError.stateLimitExceeded:
            return error(requestID, workspaceID, .invalidRequest)
        default:
            return error(requestID, workspaceID, .operationRejected)
        }
    }

    private func error(
        _ requestID: WorkspaceRequestID,
        _ workspaceID: String,
        _ code: WorkspaceLaneErrorCode
    ) -> WorkspaceLaneResponse {
        .error(WorkspaceLaneError(requestID: requestID, workspaceID: workspaceID, code: code))
    }
}
