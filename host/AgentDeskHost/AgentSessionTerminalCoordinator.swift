import Foundation
import PtyClientSwift

actor AgentSessionTerminalCoordinator {
    private struct Handoff {
        let ready: AgentSessionTerminalReady
        let platform: AgentSessionTerminalPlatform
        let timeoutIdentity: UInt64
        var lease: AgentSessionTerminalPtyLease?
        var acknowledged = false
        var timeoutTask: Task<Void, Never>?
    }

    private let ptyClient: any AgentSessionTerminalPtyClient
    private let livenessChecker: any AgentSessionTerminalLivenessChecking
    private let homeDirectory: URL
    private let executables: AgentResumeLaunch.Executables
    private let waitForHandoffTimeout: @Sendable () async throws -> Void
    private let onEvent: @Sendable (AgentSessionTerminalCoordinatorEvent) -> Void
    private let nameGate = AsyncKeyedGate<String>()

    private var openTasks: [String: Task<AgentSessionTerminalReady, Error>] = [:]
    private var openingIdentities: [String: AgentResumeTerminalIdentity] = [:]
    private var openingPlatforms: [String: AgentSessionTerminalPlatform] = [:]
    private var handoffs: [String: Handoff] = [:]
    private var cancelledRequestIDs: AgentSessionTerminalRequestTombstones
    private var ownedSessionNames: Set<String> = []
    private var closingNames: Set<String> = []
    private var nextHandoffTimeoutIdentity: UInt64 = 0

    init(
        ptyClient: any AgentSessionTerminalPtyClient,
        livenessChecker: any AgentSessionTerminalLivenessChecking,
        homeDirectory: URL,
        executables: AgentResumeLaunch.Executables,
        requestTombstoneLimit: Int,
        waitForHandoffTimeout: @escaping @Sendable () async throws -> Void,
        onEvent: @escaping @Sendable (AgentSessionTerminalCoordinatorEvent) -> Void = { _ in }
    ) {
        self.ptyClient = ptyClient
        self.livenessChecker = livenessChecker
        self.homeDirectory = homeDirectory
        self.executables = executables
        self.cancelledRequestIDs = AgentSessionTerminalRequestTombstones(
            limit: requestTombstoneLimit
        )
        self.waitForHandoffTimeout = waitForHandoffTimeout
        self.onEvent = onEvent
    }

    func open(_ request: AgentSessionTerminalOpenRequest) async throws -> AgentSessionTerminalReady {
        let identity: AgentResumeTerminalIdentity
        do {
            identity = try AgentResumeTerminalIdentity(
                source: request.context.source,
                harnessSessionID: request.context.harnessSessionID,
                projectDirectoryPath: request.context.projectPath,
                homeDirectory: homeDirectory
            )
        } catch let error as AgentResumeValidationError {
            throw AgentSessionTerminalCoordinatorError.invalidContext(error)
        }

        let launch: AgentResumeLaunch
        do {
            launch = try AgentResumeLaunch(identity: identity, executables: executables)
        } catch {
            throw AgentSessionTerminalCoordinatorError.launchFailed(String(describing: error))
        }

        if let handoff = handoffs[request.requestID] {
            guard handoff.ready.identity == identity, handoff.platform == request.platform else {
                throw AgentSessionTerminalCoordinatorError.sessionEnded
            }
            return handoff.ready
        }
        if let task = openTasks[request.requestID] {
            guard openingIdentities[request.requestID] == identity,
                  openingPlatforms[request.requestID] == request.platform else {
                throw AgentSessionTerminalCoordinatorError.sessionEnded
            }
            return try await task.value
        }
        guard !cancelledRequestIDs.contains(request.requestID) else {
            throw AgentSessionTerminalCoordinatorError.sessionEnded
        }
        guard !closingNames.contains(identity.ptySessionName) else {
            throw AgentSessionTerminalCoordinatorError.sessionEnded
        }

        openingIdentities[request.requestID] = identity
        openingPlatforms[request.requestID] = request.platform
        let task = Task {
            try await self.performOpen(request: request, identity: identity, launch: launch)
        }
        openTasks[request.requestID] = task
        return try await task.value
    }

    func acknowledgeAttachment(requestID: String, ptySessionName: String) async {
        guard var handoff = handoffs[requestID],
              handoff.ready.ptySessionName == ptySessionName,
              !handoff.acknowledged else {
            return
        }

        handoff.acknowledged = true
        handoff.timeoutTask?.cancel()
        handoff.timeoutTask = nil
        let lease = handoff.lease
        handoff.lease = nil
        handoffs[requestID] = handoff
        try? await lease?.detach()
    }

    /// Transfers request ownership for an existing handoff without releasing or killing its leased
    /// PTY. The old ID becomes a coordinator tombstone; only the new ID may acknowledge or close.
    /// The handoff's bootstrap lease, acknowledgement state, and original timeout task move together
    /// with the identity. Transfer never restarts or extends the unacknowledged handoff deadline.
    func transferRequest(
        from oldRequestID: String,
        to newRequestID: String,
        ptySessionName: String
    ) -> Bool {
        guard oldRequestID != newRequestID,
              !cancelledRequestIDs.contains(oldRequestID),
              !cancelledRequestIDs.contains(newRequestID),
              handoffs[newRequestID] == nil,
              openTasks[newRequestID] == nil,
              openingIdentities[newRequestID] == nil,
              let oldHandoff = handoffs[oldRequestID],
              oldHandoff.ready.ptySessionName == ptySessionName,
              !closingNames.contains(ptySessionName) else {
            return false
        }

        handoffs.removeValue(forKey: oldRequestID)
        cancelledRequestIDs.insert(oldRequestID)
        let ready = AgentSessionTerminalReady(
            requestID: newRequestID,
            identity: oldHandoff.ready.identity,
            pid: oldHandoff.ready.pid
        )
        handoffs[newRequestID] = Handoff(
            ready: ready,
            platform: oldHandoff.platform,
            timeoutIdentity: oldHandoff.timeoutIdentity,
            lease: oldHandoff.lease,
            acknowledged: oldHandoff.acknowledged,
            timeoutTask: oldHandoff.timeoutTask
        )
        return true
    }

    func close(requestID: String, ptySessionName: String?) async {
        let knownName = handoffs[requestID]?.ready.ptySessionName
            ?? openingIdentities[requestID]?.ptySessionName
        guard let knownName,
              ptySessionName == nil || ptySessionName == knownName else {
            return
        }
        closingNames.insert(knownName)

        let relatedHandoffIDs = handoffs.compactMap { entry in
            entry.value.ready.ptySessionName == knownName ? entry.key : nil
        }
        let relatedOpeningIDs = openingIdentities.compactMap { entry in
            entry.value.ptySessionName == knownName ? entry.key : nil
        }
        var leases: [AgentSessionTerminalPtyLease] = []

        for relatedID in relatedHandoffIDs {
            guard let handoff = handoffs.removeValue(forKey: relatedID) else { continue }
            handoff.timeoutTask?.cancel()
            if let lease = handoff.lease {
                leases.append(lease)
            }
            cancelledRequestIDs.insert(relatedID)
        }
        for relatedID in relatedOpeningIDs {
            openTasks.removeValue(forKey: relatedID)?.cancel()
            openingIdentities.removeValue(forKey: relatedID)
            openingPlatforms.removeValue(forKey: relatedID)
            cancelledRequestIDs.insert(relatedID)
        }

        await nameGate.acquire(knownName)
        for lease in leases {
            try? await lease.detach()
        }
        try? await ptyClient.killSession(name: knownName)
        ownedSessionNames.remove(knownName)
        closingNames.remove(knownName)
        await nameGate.release(knownName)
    }

    private func performOpen(
        request: AgentSessionTerminalOpenRequest,
        identity: AgentResumeTerminalIdentity,
        launch: AgentResumeLaunch
    ) async throws -> AgentSessionTerminalReady {
        let name = identity.ptySessionName
        await nameGate.acquire(name)
        var gateHeld = true
        var createdSession = false
        var sawExistingPanelSession = false
        var lease: AgentSessionTerminalPtyLease?

        do {
            try Task.checkCancellation()
            let sessions = try await ptyClient.listSessions()
            try Task.checkCancellation()
            let existing = sessions.first { $0.name == name }

            if let existing {
                guard existing.state == .running else {
                    throw AgentSessionTerminalCoordinatorError.launchFailed(
                        "deterministic PTY exists with incompatible state"
                    )
                }
                sawExistingPanelSession = true
            } else {
                let isLive = try await livenessChecker.isLive(identity)
                try Task.checkCancellation()
                guard !isLive else {
                    throw AgentSessionTerminalCoordinatorError.activeElsewhere
                }
                createdSession = true
            }

            lease = try await ptyClient.openSession(
                name: name,
                launch: launch.ptyLaunch,
                columns: PtyTerminalDimensions.bootstrap.columns,
                rows: PtyTerminalDimensions.bootstrap.rows,
                createIfMissing: existing == nil,
                clientTitle: request.platform.bootstrapClientTitle
            )
            try Task.checkCancellation()
            guard lease?.attachment.name == name,
                  let pid = lease?.attachment.pid,
                  pid > 0,
                  existing?.pid == nil || existing?.pid == pid else {
                throw AgentSessionTerminalCoordinatorError.launchFailed(
                    "PTY manager returned a mismatched attachment"
                )
            }
            if createdSession {
                ownedSessionNames.insert(name)
            }

            await nameGate.release(name)
            gateHeld = false
            guard openingIdentities[request.requestID] == identity,
                  !cancelledRequestIDs.contains(request.requestID),
                  let lease else {
                throw AgentSessionTerminalCoordinatorError.sessionEnded
            }

            let ready = AgentSessionTerminalReady(
                requestID: request.requestID,
                identity: identity,
                pid: pid
            )
            installHandoff(
                requestID: request.requestID,
                ready: ready,
                lease: lease,
                platform: request.platform
            )
            return ready
        } catch {
            if gateHeld {
                await nameGate.release(name)
            }
            openTasks.removeValue(forKey: request.requestID)
            openingIdentities.removeValue(forKey: request.requestID)
            openingPlatforms.removeValue(forKey: request.requestID)
            let shouldKill = createdSession
                || (sawExistingPanelSession
                    && ownedSessionNames.contains(name)
                    && !hasOtherActivity(for: name, excluding: request.requestID))
            await cleanupFailedOpen(name: name, lease: lease, shouldKill: shouldKill)
            if shouldKill {
                ownedSessionNames.remove(name)
            }

            if let coordinatorError = error as? AgentSessionTerminalCoordinatorError {
                throw coordinatorError
            }
            if error is CancellationError {
                throw AgentSessionTerminalCoordinatorError.sessionEnded
            }
            throw AgentSessionTerminalCoordinatorError.launchFailed(String(describing: error))
        }
    }

    private func installHandoff(
        requestID: String,
        ready: AgentSessionTerminalReady,
        lease: AgentSessionTerminalPtyLease,
        platform: AgentSessionTerminalPlatform
    ) {
        openTasks.removeValue(forKey: requestID)
        openingIdentities.removeValue(forKey: requestID)
        openingPlatforms.removeValue(forKey: requestID)
        nextHandoffTimeoutIdentity &+= 1
        let timeoutIdentity = nextHandoffTimeoutIdentity
        handoffs[requestID] = Handoff(
            ready: ready,
            platform: platform,
            timeoutIdentity: timeoutIdentity,
            lease: lease
        )

        scheduleHandoffTimeout(
            requestID: requestID,
            timeoutIdentity: timeoutIdentity
        )
    }

    private func scheduleHandoffTimeout(
        requestID: String,
        timeoutIdentity: UInt64
    ) {
        let waitForHandoffTimeout = waitForHandoffTimeout
        let timeoutTask = Task { [weak self] in
            do {
                try await waitForHandoffTimeout()
                try Task.checkCancellation()
                await self?.expireHandoff(timeoutIdentity: timeoutIdentity)
            } catch {
                // Acknowledgement and explicit close cancel the timeout.
            }
        }
        handoffs[requestID]?.timeoutTask = timeoutTask
    }

    private func expireHandoff(timeoutIdentity: UInt64) async {
        guard let entry = handoffs.first(where: {
            $0.value.timeoutIdentity == timeoutIdentity && !$0.value.acknowledged
        }) else {
            return
        }
        let requestID = entry.key
        let handoff = entry.value
        handoffs.removeValue(forKey: requestID)
        cancelledRequestIDs.insert(requestID)

        let name = handoff.ready.ptySessionName
        await nameGate.acquire(name)
        try? await handoff.lease?.detach()
        let hasAnotherHandoff = handoffs.values.contains {
            $0.ready.ptySessionName == name
        }
        let hasAnotherOpening = openingIdentities.contains {
            $0.key != requestID && $0.value.ptySessionName == name
        }
        if ownedSessionNames.contains(name), !hasAnotherHandoff, !hasAnotherOpening {
            try? await ptyClient.killSession(name: name)
            ownedSessionNames.remove(name)
        }
        await nameGate.release(name)
        onEvent(.handoffTimedOut(requestID: requestID, ready: handoff.ready))
    }

    private func cleanupFailedOpen(
        name: String,
        lease: AgentSessionTerminalPtyLease?,
        shouldKill: Bool
    ) async {
        try? await lease?.detach()
        if shouldKill {
            try? await ptyClient.killSession(name: name)
        }
    }

    private func hasOtherActivity(for name: String, excluding requestID: String) -> Bool {
        handoffs.contains {
            $0.key != requestID && $0.value.ready.ptySessionName == name
        } || openingIdentities.contains {
            $0.key != requestID && $0.value.ptySessionName == name
        }
    }
}
