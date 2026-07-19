import Foundation
import PtyClientSwift

actor WorkspaceTerminalCoordinator {
    private struct Handoff {
        let ready: WorkspaceTerminalCoordinatorReady
        let workspaceRoot: URL
        let createdSession: Bool
        let timeoutIdentity: UInt64
        var lease: AgentSessionTerminalPtyLease?
        var timeoutTask: Task<Void, Never>?
    }

    private let repository: WorkspaceRepository
    private let ptyClient: any AgentSessionTerminalPtyClient
    private let shell: String
    private let waitForHandoffTimeout: @Sendable () async throws -> Void
    private let onEvent: @Sendable (WorkspaceTerminalCoordinatorEvent) -> Void
    private let workspaceGate = AsyncKeyedGate<UUID>()

    private var openTasks: [String: Task<WorkspaceTerminalCoordinatorReady, Error>] = [:]
    private var openingRequests: [String: WorkspaceTerminalOpenRequest] = [:]
    private var handoffs: [String: Handoff] = [:]
    private var tombstones: AgentSessionTerminalRequestTombstones
    private var nextTimeoutIdentity: UInt64 = 0

    init(
        repository: WorkspaceRepository,
        ptyClient: any AgentSessionTerminalPtyClient,
        shell: String,
        requestTombstoneLimit: Int,
        waitForHandoffTimeout: @escaping @Sendable () async throws -> Void,
        onEvent: @escaping @Sendable (WorkspaceTerminalCoordinatorEvent) -> Void
    ) {
        self.repository = repository
        self.ptyClient = ptyClient
        self.shell = shell
        self.waitForHandoffTimeout = waitForHandoffTimeout
        self.onEvent = onEvent
        self.tombstones = AgentSessionTerminalRequestTombstones(limit: requestTombstoneLimit)
    }

    func open(_ request: WorkspaceTerminalOpenRequest) async throws -> WorkspaceTerminalCoordinatorReady {
        if let handoff = handoffs[request.requestID] {
            guard handoff.ready.workspaceID.uuidString.caseInsensitiveCompare(request.workspaceID) == .orderedSame else {
                throw WorkspaceTerminalCoordinatorError.sessionEnded
            }
            return handoff.ready
        }
        if let task = openTasks[request.requestID] {
            guard openingRequests[request.requestID] == request else {
                throw WorkspaceTerminalCoordinatorError.sessionEnded
            }
            return try await task.value
        }
        guard !tombstones.contains(request.requestID) else {
            throw WorkspaceTerminalCoordinatorError.sessionEnded
        }

        openingRequests[request.requestID] = request
        let task = Task { try await self.performOpen(request) }
        openTasks[request.requestID] = task
        return try await task.value
    }

    func acknowledgeAttachment(
        requestID: String,
        workspaceID: String,
        ptySessionName: String
    ) async {
        guard let handoff = handoffs[requestID],
              handoff.ready.workspaceID.uuidString.caseInsensitiveCompare(workspaceID) == .orderedSame,
              handoff.ready.ptySessionName == ptySessionName else {
            return
        }
        handoffs.removeValue(forKey: requestID)
        tombstones.insert(requestID)
        handoff.timeoutTask?.cancel()
        try? await handoff.lease?.detach()
    }

    func cancel(requestID: String, workspaceID: String, ptySessionName: String?) async {
        if let request = openingRequests[requestID] {
            guard request.workspaceID.caseInsensitiveCompare(workspaceID) == .orderedSame else { return }
            openTasks.removeValue(forKey: requestID)?.cancel()
            openingRequests.removeValue(forKey: requestID)
            tombstones.insert(requestID)
            return
        }
        guard let handoff = handoffs[requestID],
              handoff.ready.workspaceID.uuidString.caseInsensitiveCompare(workspaceID) == .orderedSame,
              ptySessionName == nil || ptySessionName == handoff.ready.ptySessionName else {
            return
        }
        handoffs.removeValue(forKey: requestID)
        tombstones.insert(requestID)
        handoff.timeoutTask?.cancel()
        await cleanup(handoff)
    }

    private func performOpen(
        _ request: WorkspaceTerminalOpenRequest
    ) async throws -> WorkspaceTerminalCoordinatorReady {
        let workspace: Workspace
        let workspaceID: UUID
        do {
            guard let parsedID = UUID(uuidString: request.workspaceID),
                  let resolved = try await repository.load().workspace(id: parsedID) else {
                throw WorkspaceTerminalCoordinatorError.workspaceUnavailable
            }
            workspaceID = parsedID
            workspace = resolved
        } catch let error as WorkspaceTerminalCoordinatorError {
            finishFailedOpen(request.requestID)
            throw error
        } catch {
            finishFailedOpen(request.requestID)
            throw WorkspaceTerminalCoordinatorError.workspaceUnavailable
        }

        let root = workspace.root.standardizedFileURL.resolvingSymlinksInPath().standardizedFileURL
        var isDirectory: ObjCBool = false
        guard root.isFileURL,
              FileManager.default.fileExists(atPath: root.path, isDirectory: &isDirectory),
              isDirectory.boolValue else {
            finishFailedOpen(request.requestID)
            throw WorkspaceTerminalCoordinatorError.workspaceUnavailable
        }

        let identity = WorkspaceTerminalIdentity(workspaceID: workspaceID)
        if let preferred = request.preferredSessionName, !identity.owns(sessionName: preferred) {
            finishFailedOpen(request.requestID)
            throw WorkspaceTerminalCoordinatorError.invalidSession
        }

        await workspaceGate.acquire(workspaceID)
        var gateHeld = true
        var lease: AgentSessionTerminalPtyLease?
        var createdSession = false
        var selectedName: String?
        var selectedPID: UInt32?

        do {
            try Task.checkCancellation()
            let sessions = try await ptyClient.listSessions()
            try Task.checkCancellation()
            let eligible = sessions.filter {
                isEligible($0, identity: identity, root: root)
            }
            let selected = request.preferredSessionName.flatMap { preferred in
                eligible.first { $0.name == preferred }
            } ?? eligible.max {
                ($0.startedAtUnixMilliseconds, $0.name) < ($1.startedAtUnixMilliseconds, $1.name)
            }
            let name = selected?.name ?? nextAvailableName(identity: identity, sessions: sessions)
            selectedName = name
            selectedPID = selected?.pid
            createdSession = selected == nil
            let launchShell = selected.flatMap { $0.shell.isEmpty ? nil : $0.shell } ?? shell

            lease = try await ptyClient.openSession(
                name: name,
                launch: .shell(cwd: root.path, shell: launchShell),
                lifetime: .persistent,
                columns: max(request.columns, 1),
                rows: max(request.rows, 1),
                createIfMissing: createdSession,
                clientTitle: request.clientTitle
            )
            try Task.checkCancellation()
            guard lease?.attachment.name == name,
                  let pid = lease?.attachment.pid,
                  pid > 0,
                  selectedPID == nil || selectedPID == pid else {
                throw WorkspaceTerminalCoordinatorError.launchFailed(
                    "PTY manager returned a mismatched workspace attachment"
                )
            }

            await workspaceGate.release(workspaceID)
            gateHeld = false
            guard openingRequests[request.requestID] == request,
                  !tombstones.contains(request.requestID),
                  let lease else {
                throw WorkspaceTerminalCoordinatorError.sessionEnded
            }
            let ready = WorkspaceTerminalCoordinatorReady(
                requestID: request.requestID,
                workspaceID: workspaceID,
                ptySessionName: name,
                pid: pid
            )
            installHandoff(
                requestID: request.requestID,
                ready: ready,
                workspaceRoot: root,
                lease: lease,
                createdSession: createdSession
            )
            return ready
        } catch {
            if gateHeld { await workspaceGate.release(workspaceID) }
            finishFailedOpen(request.requestID)
            if let selectedName {
                let failed = Handoff(
                    ready: WorkspaceTerminalCoordinatorReady(
                        requestID: request.requestID,
                        workspaceID: workspaceID,
                        ptySessionName: selectedName,
                        pid: lease?.attachment.pid ?? selectedPID ?? 0
                    ),
                    workspaceRoot: root,
                    createdSession: createdSession,
                    timeoutIdentity: 0,
                    lease: lease,
                    timeoutTask: nil
                )
                await cleanup(failed)
            }
            if let error = error as? WorkspaceTerminalCoordinatorError { throw error }
            if error is CancellationError { throw WorkspaceTerminalCoordinatorError.sessionEnded }
            throw WorkspaceTerminalCoordinatorError.launchFailed(String(describing: error))
        }
    }

    private func installHandoff(
        requestID: String,
        ready: WorkspaceTerminalCoordinatorReady,
        workspaceRoot: URL,
        lease: AgentSessionTerminalPtyLease,
        createdSession: Bool
    ) {
        openTasks.removeValue(forKey: requestID)
        openingRequests.removeValue(forKey: requestID)
        nextTimeoutIdentity &+= 1
        let timeoutIdentity = nextTimeoutIdentity
        handoffs[requestID] = Handoff(
            ready: ready,
            workspaceRoot: workspaceRoot,
            createdSession: createdSession,
            timeoutIdentity: timeoutIdentity,
            lease: lease,
            timeoutTask: nil
        )
        let waitForHandoffTimeout = waitForHandoffTimeout
        let timeoutTask = Task { [weak self] in
            do {
                try await waitForHandoffTimeout()
                try Task.checkCancellation()
                await self?.expireHandoff(timeoutIdentity: timeoutIdentity)
            } catch {
                // Attachment acknowledgement and cancellation retire the timer.
            }
        }
        handoffs[requestID]?.timeoutTask = timeoutTask
    }

    private func expireHandoff(timeoutIdentity: UInt64) async {
        guard let entry = handoffs.first(where: { $0.value.timeoutIdentity == timeoutIdentity }) else {
            return
        }
        handoffs.removeValue(forKey: entry.key)
        tombstones.insert(entry.key)
        await cleanup(entry.value)
        onEvent(.handoffTimedOut(requestID: entry.key, ready: entry.value.ready))
    }

    private func cleanup(_ handoff: Handoff) async {
        handoff.timeoutTask?.cancel()
        try? await handoff.lease?.detach()
        guard handoff.createdSession, handoff.ready.pid > 0 else { return }

        await workspaceGate.acquire(handoff.ready.workspaceID)
        let sessions = try? await ptyClient.listSessions()
        if let current = sessions?.first(where: { $0.name == handoff.ready.ptySessionName }),
           current.pid == handoff.ready.pid,
           current.state == .running,
           current.lifetime == .persistent,
           current.clients.isEmpty,
           canonicalPath(current.cwd) == handoff.workspaceRoot.path {
            try? await ptyClient.killSession(name: current.name)
        }
        await workspaceGate.release(handoff.ready.workspaceID)
    }

    private func isEligible(
        _ session: PtySessionSummary,
        identity: WorkspaceTerminalIdentity,
        root: URL
    ) -> Bool {
        identity.owns(sessionName: session.name)
            && session.state == .running
            && session.lifetime == .persistent
            && session.pid > 0
            && canonicalPath(session.cwd) == root.path
    }

    private func canonicalPath(_ path: String) -> String? {
        guard (path as NSString).isAbsolutePath else { return nil }
        return URL(fileURLWithPath: path, isDirectory: true)
            .standardizedFileURL
            .resolvingSymlinksInPath()
            .standardizedFileURL
            .path
    }

    private func nextAvailableName(
        identity: WorkspaceTerminalIdentity,
        sessions: [PtySessionSummary]
    ) -> String {
        let existingNames = Set(sessions.map(\.name))
        var name = identity.makeSessionName()
        while existingNames.contains(name) { name = identity.makeSessionName() }
        return name
    }

    private func finishFailedOpen(_ requestID: String) {
        openTasks.removeValue(forKey: requestID)
        openingRequests.removeValue(forKey: requestID)
    }
}
