import AgentDeskWire

protocol WorkspaceTerminalCoordinating: Sendable {
    func open(_ request: WorkspaceTerminalOpenRequest) async throws -> WorkspaceTerminalCoordinatorReady
    func acknowledgeAttachment(
        requestID: String,
        workspaceID: String,
        ptySessionName: String
    ) async
    func cancel(requestID: String, workspaceID: String, ptySessionName: String?) async
}

extension WorkspaceTerminalCoordinator: WorkspaceTerminalCoordinating {}

actor WorkspaceTerminalEndpoint {
    typealias Push = @Sendable (WorkspaceTerminalHostMessage) async -> Void

    private struct RequestState {
        let workspaceID: String
        let generation: UInt64
        var ptySessionName: String?
    }

    private let coordinator: any WorkspaceTerminalCoordinating
    private let requestNamespace: String
    private let clientTitle: String
    private var push: Push?
    private var pushBindingID: String?
    private var nextGeneration: UInt64 = 0
    private var activeRequests: [String: RequestState] = [:]
    private var tombstones: AgentSessionTerminalRequestTombstones
    private var isShutdown = false

    init(
        coordinator: any WorkspaceTerminalCoordinating,
        requestNamespace: String,
        clientTitle: String,
        tombstoneLimit: Int,
        push: Push?
    ) {
        self.coordinator = coordinator
        self.requestNamespace = requestNamespace
        self.clientTitle = clientTitle
        self.tombstones = AgentSessionTerminalRequestTombstones(limit: tombstoneLimit)
        self.push = push
    }

    func bindPush(id: String, push: @escaping Push) {
        guard !isShutdown else { return }
        pushBindingID = id
        self.push = push
    }

    func unbindPush(id: String) {
        guard pushBindingID == id else { return }
        pushBindingID = nil
        push = nil
    }

    func handle(_ message: WorkspaceTerminalClientMessage) async {
        switch message {
        case .open(let open):
            guard let response = await openLocal(open) else { return }
            await push?(response)
        case .attached(let acknowledgement):
            await acknowledge(acknowledgement)
        case .cancel(let cancellation):
            await cancel(cancellation)
        }
    }

    func openLocal(_ open: WorkspaceTerminalOpen) async -> WorkspaceTerminalHostMessage? {
        guard !isShutdown, !tombstones.contains(open.requestID) else {
            return sessionEndedError(for: open)
        }
        if let state = activeRequests[open.requestID] {
            guard state.workspaceID.caseInsensitiveCompare(open.workspaceID) == .orderedSame else {
                return sessionEndedError(for: open)
            }
            if let ptySessionName = state.ptySessionName {
                return .ready(WorkspaceTerminalReady(
                    requestID: open.requestID,
                    workspaceID: open.workspaceID,
                    ptySessionName: ptySessionName
                ))
            }
        } else {
            nextGeneration &+= 1
            activeRequests[open.requestID] = RequestState(
                workspaceID: open.workspaceID,
                generation: nextGeneration,
                ptySessionName: nil
            )
        }

        guard let generation = activeRequests[open.requestID]?.generation else { return nil }
        let request = WorkspaceTerminalOpenRequest(
            requestID: namespacedRequestID(open.requestID),
            workspaceID: open.workspaceID,
            preferredSessionName: open.preferredSessionName,
            columns: open.columns,
            rows: open.rows,
            clientTitle: clientTitle
        )

        do {
            let ready = try await coordinator.open(request)
            guard var state = activeRequests[open.requestID],
                  state.generation == generation,
                  state.workspaceID.caseInsensitiveCompare(open.workspaceID) == .orderedSame else {
                await coordinator.cancel(
                    requestID: request.requestID,
                    workspaceID: open.workspaceID,
                    ptySessionName: ready.ptySessionName
                )
                return nil
            }
            state.ptySessionName = ready.ptySessionName
            activeRequests[open.requestID] = state
            return .ready(WorkspaceTerminalReady(
                requestID: open.requestID,
                workspaceID: open.workspaceID,
                ptySessionName: ready.ptySessionName
            ))
        } catch {
            guard let state = activeRequests[open.requestID],
                  state.generation == generation,
                  state.workspaceID.caseInsensitiveCompare(open.workspaceID) == .orderedSame else {
                return nil
            }
            finishRequest(open.requestID)
            return .error(WorkspaceTerminalError(
                requestID: open.requestID,
                workspaceID: open.workspaceID,
                ptySessionName: state.ptySessionName,
                code: wireCode(for: error)
            ))
        }
    }

    func handleCoordinatorEvent(_ event: WorkspaceTerminalCoordinatorEvent) async {
        switch event {
        case .handoffTimedOut(let internalRequestID, let ready):
            guard let requestID = wireRequestID(from: internalRequestID),
                  let state = activeRequests[requestID],
                  state.workspaceID.caseInsensitiveCompare(ready.workspaceID.uuidString) == .orderedSame,
                  state.ptySessionName == nil || state.ptySessionName == ready.ptySessionName else {
                return
            }
            finishRequest(requestID)
            await push?(.error(WorkspaceTerminalError(
                requestID: requestID,
                workspaceID: state.workspaceID,
                ptySessionName: ready.ptySessionName,
                code: .handoffTimedOut
            )))
        }
    }

    func shutdown() async {
        guard !isShutdown else { return }
        isShutdown = true
        let requests = activeRequests
        activeRequests.removeAll(keepingCapacity: false)
        tombstones.removeAll()
        pushBindingID = nil
        push = nil
        for (requestID, state) in requests {
            await coordinator.cancel(
                requestID: namespacedRequestID(requestID),
                workspaceID: state.workspaceID,
                ptySessionName: state.ptySessionName
            )
        }
    }

    private func acknowledge(_ acknowledgement: WorkspaceTerminalAttachedAck) async {
        guard let state = activeRequests[acknowledgement.requestID],
              state.workspaceID.caseInsensitiveCompare(acknowledgement.workspaceID) == .orderedSame,
              state.ptySessionName == acknowledgement.ptySessionName else {
            return
        }
        await coordinator.acknowledgeAttachment(
            requestID: namespacedRequestID(acknowledgement.requestID),
            workspaceID: acknowledgement.workspaceID,
            ptySessionName: acknowledgement.ptySessionName
        )
    }

    private func cancel(_ cancellation: WorkspaceTerminalCancel) async {
        guard let state = activeRequests[cancellation.requestID],
              state.workspaceID.caseInsensitiveCompare(cancellation.workspaceID) == .orderedSame,
              cancellation.ptySessionName == nil || cancellation.ptySessionName == state.ptySessionName else {
            return
        }
        finishRequest(cancellation.requestID)
        await coordinator.cancel(
            requestID: namespacedRequestID(cancellation.requestID),
            workspaceID: cancellation.workspaceID,
            ptySessionName: state.ptySessionName
        )
    }

    private func finishRequest(_ requestID: String) {
        guard activeRequests.removeValue(forKey: requestID) != nil else { return }
        tombstones.insert(requestID)
    }

    private func wireCode(for error: Error) -> WorkspaceTerminalErrorCode {
        guard let error = error as? WorkspaceTerminalCoordinatorError else { return .launchFailed }
        switch error {
        case .workspaceUnavailable: return .workspaceUnavailable
        case .invalidSession: return .invalidSession
        case .launchFailed: return .launchFailed
        case .handoffTimedOut: return .handoffTimedOut
        case .sessionEnded: return .sessionEnded
        }
    }

    private func sessionEndedError(for open: WorkspaceTerminalOpen) -> WorkspaceTerminalHostMessage {
        .error(WorkspaceTerminalError(
            requestID: open.requestID,
            workspaceID: open.workspaceID,
            code: .sessionEnded
        ))
    }

    private func namespacedRequestID(_ requestID: String) -> String {
        "\(requestNamespace):\(requestID)"
    }

    private func wireRequestID(from namespacedRequestID: String) -> String? {
        let prefix = "\(requestNamespace):"
        guard namespacedRequestID.hasPrefix(prefix) else { return nil }
        return String(namespacedRequestID.dropFirst(prefix.count))
    }
}
