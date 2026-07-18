import AgentDeskWire

protocol AgentSessionTerminalCoordinating: Sendable {
    func open(_ request: AgentSessionTerminalOpenRequest) async throws -> AgentSessionTerminalReady
    func acknowledgeAttachment(requestID: String, ptySessionName: String) async
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

    private let coordinator: any AgentSessionTerminalCoordinating
    private let platform: AgentSessionTerminalPlatform
    private let requestNamespace: String
    private var push: Push?
    private var pushBindingID: String?
    private var nextGeneration: UInt64 = 0
    private var activeRequests: [String: RequestState] = [:]
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

    func handleCoordinatorEvent(_ event: AgentSessionTerminalCoordinatorEvent) async {
        switch event {
        case .handoffTimedOut(let internalRequestID, let ready):
            guard let requestID = wireRequestID(from: internalRequestID),
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
