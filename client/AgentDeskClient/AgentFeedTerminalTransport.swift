import AgentDeskWire
import PtyClientSwift
import PtyTerminalSession

struct AgentFeedTerminalAttachmentRequest: Equatable, Sendable {
    let role: QuicSessionStreamRole
    let sessionName: String
    let launch: PtySessionLaunch
    let lifetime: PtySessionLifetime
    let columns: UInt32
    let rows: UInt32
    let createIfMissing: Bool
    let clientTitle: String

    init(sessionName: String, columns: UInt32, rows: UInt32) {
        role = .terminal
        self.sessionName = sessionName
        launch = .shell(cwd: "", shell: "")
        lifetime = .leased
        self.columns = columns
        self.rows = rows
        createIfMissing = false
        clientTitle = "AgentDesk iPhone Agent Panel"
    }
}

struct AgentFeedTerminalConnectionIdentity: Equatable, Sendable {
    let sessionName: String
    let pid: UInt32
}

protocol AgentFeedTerminalConnection: PtyTerminalConnection, Sendable {
    var identity: AgentFeedTerminalConnectionIdentity { get }
}

extension PtySessionConnection: AgentFeedTerminalConnection {
    var identity: AgentFeedTerminalConnectionIdentity {
        AgentFeedTerminalConnectionIdentity(
            sessionName: sessionName,
            pid: attachment.pid
        )
    }
}

@MainActor
protocol AgentFeedTerminalCoordinating: AnyObject {
    var agentTerminalUpdates: AsyncStream<AgentTerminalHostMessage> { get }
    func sendAgentTerminal(_ message: AgentTerminalClientMessage) async throws
}

@MainActor
protocol AgentFeedTerminalSessionOpening: AnyObject {
    func openAgentFeedTerminal(
        _ request: AgentFeedTerminalAttachmentRequest
    ) async throws -> any AgentFeedTerminalConnection
}

@available(iOS 26.0, *)
extension QuicSessionClientTransport: AgentFeedTerminalCoordinating, AgentFeedTerminalSessionOpening {
    func openAgentFeedTerminal(
        _ request: AgentFeedTerminalAttachmentRequest
    ) async throws -> any AgentFeedTerminalConnection {
        precondition(request.role == .terminal)
        let client = try await openTerminalPtyClient()
        return try await client.openSession(
            name: request.sessionName,
            launch: request.launch,
            lifetime: request.lifetime,
            columns: request.columns,
            rows: request.rows,
            createIfMissing: request.createIfMissing,
            clientTitle: request.clientTitle
        )
    }
}
