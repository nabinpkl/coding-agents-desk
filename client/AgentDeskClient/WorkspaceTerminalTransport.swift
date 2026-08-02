import AgentDeskWire
import PtyClientSwift
import PtyTerminalSession

struct WorkspaceTerminalAttachmentRequest: Equatable, Sendable {
    let sessionName: String
    let columns: UInt32
    let rows: UInt32
}

protocol WorkspaceTerminalConnection: PtyTerminalConnection, Sendable {
    var sessionName: String { get }
}

extension PtySessionConnection: WorkspaceTerminalConnection {}

@MainActor
protocol WorkspaceTerminalCoordinating: AnyObject {
    var workspaceTerminalUpdates: AsyncStream<WorkspaceTerminalHostMessage> { get }
    func sendWorkspaceTerminal(_ message: WorkspaceTerminalClientMessage) async throws
}

@MainActor
protocol WorkspaceTerminalSessionOpening: AnyObject {
    func openWorkspaceTerminal(
        _ request: WorkspaceTerminalAttachmentRequest
    ) async throws -> any WorkspaceTerminalConnection
}

@available(iOS 26.0, *)
extension QuicSessionClientTransport: WorkspaceTerminalCoordinating, WorkspaceTerminalSessionOpening {
    func openWorkspaceTerminal(
        _ request: WorkspaceTerminalAttachmentRequest
    ) async throws -> any WorkspaceTerminalConnection {
        let client = try await openTerminalPtyClient()
        return try await client.openSession(
            name: request.sessionName,
            launch: .shell(cwd: "", shell: ""),
            columns: request.columns,
            rows: request.rows,
            createIfMissing: false,
            clientTitle: "AgentDesk iPhone Workspace"
        )
    }
}
