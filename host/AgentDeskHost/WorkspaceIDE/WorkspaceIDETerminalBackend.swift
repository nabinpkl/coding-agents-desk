import AgentDeskWire
import Foundation
import PtyClientSwift
import PtyTerminalWebView

enum WorkspaceIDETerminalError: Error {
    case noResponse
    case declined(WorkspaceTerminalErrorCode)
    case sessionUnavailable
    case foreignSession
}

/// Every Workspace IDE terminal pane - the first one, and each tab or split opened afterwards -
/// obtains its session through `WorkspaceTerminalEndpoint`. The coordinator stays the single owner
/// of naming, launch and the attachment handoff, so an IDE pane and the phone reach the same
/// workspace terminal by the same route; this type only performs the attach it is handed back and
/// keeps the session list scoped to its own workspace.
@MainActor
final class WorkspaceIDETerminalBackend: PtyTerminalWorkspaceBackend {
    let workspaceID: UUID

    private let endpoint: WorkspaceTerminalEndpoint
    private let ptyClient: PtyClient
    private let clientTitle: String
    private let identity: WorkspaceTerminalIdentity

    init(
        workspaceID: UUID,
        endpoint: WorkspaceTerminalEndpoint,
        ptyClient: PtyClient,
        clientTitle: String
    ) {
        self.workspaceID = workspaceID
        self.endpoint = endpoint
        self.ptyClient = ptyClient
        self.clientTitle = clientTitle
        identity = WorkspaceTerminalIdentity(workspaceID: workspaceID)
    }

    func makeFreshSessionName() -> String { identity.makeSessionName() }

    func openSession(_ request: PtyTerminalOpenRequest) async throws -> PtySessionConnection {
        let open = WorkspaceTerminalOpen(
            requestID: UUID().uuidString,
            workspaceID: workspaceID.uuidString,
            preferredSessionName: request.sessionName.isEmpty ? nil : request.sessionName,
            columns: max(request.dimensions.columns, 1),
            rows: max(request.dimensions.rows, 1)
        )
        guard let response = await endpoint.openLocal(open) else { throw WorkspaceIDETerminalError.noResponse }
        guard case .ready(let ready) = response else {
            if case .error(let error) = response { throw WorkspaceIDETerminalError.declined(error.code) }
            throw WorkspaceIDETerminalError.noResponse
        }
        do {
            let connection = try await attach(to: ready, request: request)
            await endpoint.handle(.attached(WorkspaceTerminalAttachedAck(
                requestID: ready.requestID,
                workspaceID: ready.workspaceID,
                ptySessionName: ready.ptySessionName
            )))
            return connection
        } catch {
            // Leaving the handoff open would let its timeout kill a session a later pane could use.
            await endpoint.handle(.cancel(WorkspaceTerminalCancel(
                requestID: ready.requestID,
                workspaceID: ready.workspaceID,
                ptySessionName: ready.ptySessionName
            )))
            throw error
        }
    }

    /// The coordinator has already launched the session; the pane joins it as an ordinary viewer.
    private func attach(
        to ready: WorkspaceTerminalReady,
        request: PtyTerminalOpenRequest
    ) async throws -> PtySessionConnection {
        let sessions = try await ptyClient.listSessions()
        guard identity.owns(sessionName: ready.ptySessionName),
              let session = sessions.first(where: { $0.name == ready.ptySessionName }),
              session.state == .running else {
            throw WorkspaceIDETerminalError.sessionUnavailable
        }
        let connection = try await ptyClient.openSession(
            name: session.name,
            launch: .shell(cwd: session.cwd, shell: session.shell),
            columns: max(request.dimensions.columns, 1),
            rows: max(request.dimensions.rows, 1),
            createIfMissing: false,
            clientTitle: clientTitle
        )
        guard connection.sessionName == ready.ptySessionName,
              connection.attachment.name == session.name,
              connection.attachment.pid == session.pid else {
            try? await connection.detach()
            throw WorkspaceIDETerminalError.sessionUnavailable
        }
        return connection
    }

    func listSessions() async throws -> [PtySessionSummary] {
        try await ptyClient.listSessions().filter { identity.owns(sessionName: $0.name) }
    }

    func sessionSnapshots() async throws -> AsyncThrowingStream<[PtySessionSummary], Error> {
        let upstream = ptyClient.sessionSnapshots()
        let identity = identity
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await sessions in upstream {
                        continuation.yield(sessions.filter { identity.owns(sessionName: $0.name) })
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func killSession(named name: String) async throws {
        guard identity.owns(sessionName: name) else { throw WorkspaceIDETerminalError.foreignSession }
        try await ptyClient.killSession(name: name)
    }

    func closeClient(sessionName: String, clientID: UInt64) async throws {
        guard identity.owns(sessionName: sessionName) else { throw WorkspaceIDETerminalError.foreignSession }
        try await ptyClient.closeClient(sessionName: sessionName, clientID: clientID)
    }
}
