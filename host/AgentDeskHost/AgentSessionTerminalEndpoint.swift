import AgentDeskWire

protocol AgentSessionTerminalCoordinating: Sendable {
    func open(_ request: AgentSessionTerminalOpenRequest) async throws -> AgentSessionTerminalReady
    func acknowledgeAttachment(requestID: String, ptySessionName: String) async
    func transferRequest(
        from oldRequestID: String,
        to newRequestID: String,
        ptySessionName: String
    ) async -> Bool
    func close(requestID: String, ptySessionName: String?) async
}

extension AgentSessionTerminalCoordinator: AgentSessionTerminalCoordinating {}

struct AgentSessionTerminalEndpointStateSnapshot: Equatable, Sendable {
    let activeRequestCount: Int
    let tombstoneRequestIDs: [String]
}

actor AgentSessionTerminalEndpoint {
    typealias Push = @Sendable (AgentTerminalHostMessage) async -> Void

    private struct RequestState {
        let context: AgentResumeTerminalContext
        let generation: UInt64
        var ptySessionName: String?
    }

    private struct RequestTransfer {
        let token: UInt64
        let oldRequestID: String
        let newRequestID: String
        let context: AgentResumeTerminalContext
        let oldGeneration: UInt64
        let newGeneration: UInt64
        let ptySessionName: String
        let task: Task<Bool, Never>
    }

    private let coordinator: any AgentSessionTerminalCoordinating
    private let platform: AgentSessionTerminalPlatform
    private let requestNamespace: String
    private var push: Push?
    private var pushBindingID: String?
    private var nextGeneration: UInt64 = 0
    private var activeRequests: [String: RequestState] = [:]
    private var pendingTransfers: [String: RequestTransfer] = [:]
    private var tombstones: AgentSessionTerminalRequestTombstones
    private var isShutdown = false

    init(
        coordinator: any AgentSessionTerminalCoordinating,
        platform: AgentSessionTerminalPlatform,
        requestNamespace: String,
        tombstoneLimit: Int,
        push: Push? = nil
    ) {
        self.coordinator = coordinator
        self.platform = platform
        self.requestNamespace = requestNamespace
        self.tombstones = AgentSessionTerminalRequestTombstones(limit: tombstoneLimit)
        self.push = push
    }

    func stateSnapshot() -> AgentSessionTerminalEndpointStateSnapshot {
        AgentSessionTerminalEndpointStateSnapshot(
            activeRequestCount: activeRequests.count,
            tombstoneRequestIDs: tombstones.orderedRequestIDs
        )
    }

    func shutdown() async {
        guard !isShutdown else { return }
        isShutdown = true
        while let requestID = pendingTransfers.keys.first {
            await settleTransfer(for: requestID)
        }
        let requestsToClose = activeRequests
        activeRequests.removeAll(keepingCapacity: false)
        tombstones.removeAll()
        pushBindingID = nil
        push = nil

        for (requestID, state) in requestsToClose {
            await coordinator.close(
                requestID: namespacedRequestID(requestID),
                ptySessionName: state.ptySessionName
            )
        }
    }

    func setPush(_ push: Push?) {
        pushBindingID = nil
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

    func handle(_ message: AgentTerminalClientMessage) async {
        switch message {
        case .open(let open):
            guard let response = await openLocal(open) else { return }
            await push?(response)
        case .attached(let acknowledgement):
            await acknowledge(acknowledgement)
        case .close(let message):
            await close(message)
        }
    }

    func openLocal(_ open: AgentTerminalOpen) async -> AgentTerminalHostMessage? {
        await settleTransfer(for: open.requestID)
        guard !isShutdown else { return sessionEndedError(for: open) }
        if tombstones.contains(open.requestID) {
            return sessionEndedError(for: open)
        }
        if let state = activeRequests[open.requestID] {
            guard state.context == open.context else {
                return sessionEndedError(for: open)
            }
            if let ptySessionName = state.ptySessionName {
                return .ready(AgentTerminalReady(
                    requestID: open.requestID,
                    context: open.context,
                    ptySessionName: ptySessionName
                ))
            }
        } else {
            nextGeneration &+= 1
            activeRequests[open.requestID] = RequestState(
                context: open.context,
                generation: nextGeneration,
                ptySessionName: nil
            )
        }

        guard let generation = activeRequests[open.requestID]?.generation else { return nil }
        let request = AgentSessionTerminalOpenRequest(
            requestID: namespacedRequestID(open.requestID),
            context: AgentSessionTerminalContext(
                projectPath: open.context.projectPath,
                source: open.context.source,
                harnessSessionID: open.context.harnessSessionID
            ),
            platform: platform
        )

        do {
            let ready = try await coordinator.open(request)
            guard var state = activeRequests[open.requestID],
                  state.generation == generation,
                  state.context == open.context else {
                return nil
            }
            state.ptySessionName = ready.ptySessionName
            activeRequests[open.requestID] = state
            return .ready(AgentTerminalReady(
                requestID: open.requestID,
                context: open.context,
                ptySessionName: ready.ptySessionName
            ))
        } catch {
            guard let state = activeRequests[open.requestID],
                  state.generation == generation,
                  state.context == open.context else {
                return nil
            }
            finishRequest(open.requestID)
            return .error(terminalError(
                for: open,
                ptySessionName: state.ptySessionName,
                code: wireCode(for: error)
            ))
        }
    }

    /// Moves one live request identity without closing its leased PTY. Both IDs are fenced while the
    /// coordinator moves its handoff key; close/shutdown and stale callbacks await the same transfer
    /// task before observing ownership. The old wire ID is tombstoned before the new ID can return
    /// ready. Transfer failure retires both IDs and closes the old coordinator authority.
    func transferLocal(
        from oldRequestID: String,
        to open: AgentTerminalOpen
    ) async -> AgentTerminalHostMessage? {
        if oldRequestID == open.requestID {
            return await openLocal(open)
        }

        await settleTransfer(for: oldRequestID)
        await settleTransfer(for: open.requestID)
        guard !isShutdown,
              !tombstones.contains(oldRequestID),
              !tombstones.contains(open.requestID),
              activeRequests[open.requestID] == nil,
              let oldState = activeRequests[oldRequestID],
              oldState.context == open.context,
              let ptySessionName = oldState.ptySessionName else {
            return sessionEndedError(for: open)
        }

        nextGeneration &+= 1
        let newGeneration = nextGeneration
        nextGeneration &+= 1
        let token = nextGeneration
        let oldCoordinatorRequestID = namespacedRequestID(oldRequestID)
        let newCoordinatorRequestID = namespacedRequestID(open.requestID)
        let coordinator = coordinator
        let task = Task {
            await coordinator.transferRequest(
                from: oldCoordinatorRequestID,
                to: newCoordinatorRequestID,
                ptySessionName: ptySessionName
            )
        }
        let transfer = RequestTransfer(
            token: token,
            oldRequestID: oldRequestID,
            newRequestID: open.requestID,
            context: open.context,
            oldGeneration: oldState.generation,
            newGeneration: newGeneration,
            ptySessionName: ptySessionName,
            task: task
        )
        pendingTransfers[oldRequestID] = transfer
        pendingTransfers[open.requestID] = transfer

        await settleTransfer(for: open.requestID)
        guard let state = activeRequests[open.requestID],
              state.generation == newGeneration,
              state.context == open.context,
              state.ptySessionName == ptySessionName else {
            return sessionEndedError(for: open)
        }
        return .ready(AgentTerminalReady(
            requestID: open.requestID,
            context: open.context,
            ptySessionName: ptySessionName
        ))
    }

    func handleCoordinatorEvent(_ event: AgentSessionTerminalCoordinatorEvent) async {
        switch event {
        case .handoffTimedOut(let internalRequestID, let ready):
            guard let requestID = wireRequestID(from: internalRequestID) else { return }
            await settleTransfer(for: requestID)
            guard
                  let state = activeRequests[requestID],
                  state.ptySessionName == nil || state.ptySessionName == ready.ptySessionName else {
                return
            }
            finishRequest(requestID)
            await push?(.error(AgentTerminalError(
                requestID: requestID,
                context: state.context,
                ptySessionName: ready.ptySessionName,
                code: .handoffTimedOut
            )))
        }
    }

    func terminalEnded(
        requestID: String,
        context: AgentResumeTerminalContext,
        ptySessionName: String,
        exitStatus: Int32?
    ) async {
        await settleTransfer(for: requestID)
        guard let state = activeRequests[requestID],
              state.context == context,
              state.ptySessionName == nil || state.ptySessionName == ptySessionName else {
            return
        }
        finishRequest(requestID)
        await push?(.ended(AgentTerminalEnded(
            requestID: requestID,
            context: context,
            ptySessionName: ptySessionName,
            exitStatus: exitStatus
        )))
    }

    private func acknowledge(_ acknowledgement: AgentTerminalAttachedAck) async {
        await settleTransfer(for: acknowledgement.requestID)
        guard let state = activeRequests[acknowledgement.requestID],
              state.context == acknowledgement.context,
              state.ptySessionName == acknowledgement.ptySessionName else {
            return
        }
        await coordinator.acknowledgeAttachment(
            requestID: namespacedRequestID(acknowledgement.requestID),
            ptySessionName: acknowledgement.ptySessionName
        )
    }

    private func close(_ close: AgentTerminalClose) async {
        await settleTransfer(for: close.requestID)
        guard let state = activeRequests[close.requestID],
              state.context == close.context else {
            return
        }
        if let suppliedName = close.ptySessionName {
            guard suppliedName == state.ptySessionName else { return }
        }
        finishRequest(close.requestID)
        await coordinator.close(
            requestID: namespacedRequestID(close.requestID),
            ptySessionName: state.ptySessionName
        )
    }

    private func terminalError(
        for open: AgentTerminalOpen,
        ptySessionName: String?,
        code: AgentTerminalErrorCode
    ) -> AgentTerminalError {
        AgentTerminalError(
            requestID: open.requestID,
            context: open.context,
            ptySessionName: ptySessionName,
            code: code
        )
    }

    private func sessionEndedError(for open: AgentTerminalOpen) -> AgentTerminalHostMessage {
        .error(AgentTerminalError(
            requestID: open.requestID,
            context: open.context,
            ptySessionName: nil,
            code: .sessionEnded
        ))
    }

    private func finishRequest(_ requestID: String) {
        guard activeRequests.removeValue(forKey: requestID) != nil else { return }
        tombstones.insert(requestID)
    }

    private func settleTransfer(for requestID: String) async {
        guard let transfer = pendingTransfers[requestID] else { return }
        let transferred = await transfer.task.value
        guard pendingTransfers[transfer.oldRequestID]?.token == transfer.token,
              pendingTransfers[transfer.newRequestID]?.token == transfer.token else {
            return
        }
        pendingTransfers.removeValue(forKey: transfer.oldRequestID)
        pendingTransfers.removeValue(forKey: transfer.newRequestID)

        let oldState = activeRequests[transfer.oldRequestID]
        let endpointStateMatches = oldState?.generation == transfer.oldGeneration
            && oldState?.context == transfer.context
            && oldState?.ptySessionName == transfer.ptySessionName
            && activeRequests[transfer.newRequestID] == nil

        if transferred, endpointStateMatches {
            activeRequests.removeValue(forKey: transfer.oldRequestID)
            tombstones.insert(transfer.oldRequestID)
            activeRequests[transfer.newRequestID] = RequestState(
                context: transfer.context,
                generation: transfer.newGeneration,
                ptySessionName: transfer.ptySessionName
            )
            return
        }

        activeRequests.removeValue(forKey: transfer.oldRequestID)
        activeRequests.removeValue(forKey: transfer.newRequestID)
        tombstones.insert(transfer.oldRequestID)
        tombstones.insert(transfer.newRequestID)
        await coordinator.close(
            requestID: namespacedRequestID(
                transferred ? transfer.newRequestID : transfer.oldRequestID
            ),
            ptySessionName: transfer.ptySessionName
        )
    }

    private func wireCode(for error: Error) -> AgentTerminalErrorCode {
        guard let coordinatorError = error as? AgentSessionTerminalCoordinatorError else {
            return .launchFailed
        }
        switch coordinatorError {
        case .invalidContext: return .invalidContext
        case .activeElsewhere: return .activeElsewhere
        case .launchFailed: return .launchFailed
        case .handoffTimedOut: return .handoffTimedOut
        case .sessionEnded: return .sessionEnded
        }
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
