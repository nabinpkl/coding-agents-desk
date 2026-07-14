import Foundation
import PtyClientSwift

actor AgentSessionTerminalCoordinator {
    private static let bootstrapColumns: UInt32 = 80
    private static let bootstrapRows: UInt32 = 24

    private struct Handoff {
        let ready: AgentSessionTerminalReady
        let platform: AgentSessionTerminalPlatform
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
    private let nameGate = AgentSessionTerminalNameGate()

    private var openTasks: [String: Task<AgentSessionTerminalReady, Error>] = [:]
    private var openingIdentities: [String: AgentResumeTerminalIdentity] = [:]
    private var openingPlatforms: [String: AgentSessionTerminalPlatform] = [:]
    private var handoffs: [String: Handoff] = [:]
    private var cancelledRequestIDs: Set<String> = []
    private var ownedSessionNames: Set<String> = []
    private var closingNames: Set<String> = []

    init(
        ptyClient: any AgentSessionTerminalPtyClient,
        livenessChecker: any AgentSessionTerminalLivenessChecking,
        homeDirectory: URL,
        executables: AgentResumeLaunch.Executables,
        waitForHandoffTimeout: @escaping @Sendable () async throws -> Void,
        onEvent: @escaping @Sendable (AgentSessionTerminalCoordinatorEvent) -> Void = { _ in }
    ) {
        self.ptyClient = ptyClient
        self.livenessChecker = livenessChecker
        self.homeDirectory = homeDirectory
        self.executables = executables
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
                guard existing.state == .running, existing.lifetime == .leased else {
                    throw AgentSessionTerminalCoordinatorError.launchFailed(
                        "deterministic PTY exists with incompatible state or lifetime"
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
                lifetime: .leased,
                columns: Self.bootstrapColumns,
                rows: Self.bootstrapRows,
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
        handoffs[requestID] = Handoff(
            ready: ready,
            platform: platform,
            lease: lease
        )

        let waitForHandoffTimeout = waitForHandoffTimeout
        let timeoutTask = Task { [weak self] in
            do {
                try await waitForHandoffTimeout()
                try Task.checkCancellation()
                await self?.expireHandoff(requestID: requestID)
            } catch {
                // Acknowledgement and explicit close cancel the timeout.
            }
        }
        handoffs[requestID]?.timeoutTask = timeoutTask
    }

    private func expireHandoff(requestID: String) async {
        guard let handoff = handoffs[requestID], !handoff.acknowledged else { return }
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

private actor AgentSessionTerminalNameGate {
    private var activeNames: Set<String> = []
    private var waiters: [String: [CheckedContinuation<Void, Never>]] = [:]

    func acquire(_ name: String) async {
        guard activeNames.contains(name) else {
            activeNames.insert(name)
            return
        }
        await withCheckedContinuation { continuation in
            waiters[name, default: []].append(continuation)
        }
    }

    func release(_ name: String) {
        guard var queued = waiters[name], !queued.isEmpty else {
            activeNames.remove(name)
            waiters.removeValue(forKey: name)
            return
        }
        let next = queued.removeFirst()
        if queued.isEmpty {
            waiters.removeValue(forKey: name)
        } else {
            waiters[name] = queued
        }
        next.resume()
    }
}
