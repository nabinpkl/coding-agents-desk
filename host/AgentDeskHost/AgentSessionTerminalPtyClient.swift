import Foundation
import PtyClientSwift

struct AgentSessionTerminalPtyLease: Sendable {
    let attachment: PtySessionAttachment
    private let detachAction: @Sendable () async throws -> Void

    init(
        attachment: PtySessionAttachment,
        detach: @escaping @Sendable () async throws -> Void
    ) {
        self.attachment = attachment
        detachAction = detach
    }

    func detach() async throws {
        try await detachAction()
    }
}

protocol AgentSessionTerminalPtyClient: Sendable {
    func listSessions() async throws -> [PtySessionSummary]
    func openSession(
        name: String,
        launch: PtySessionLaunch,
        columns: UInt32,
        rows: UInt32,
        createIfMissing: Bool,
        clientTitle: String
    ) async throws -> AgentSessionTerminalPtyLease
    func killSession(name: String) async throws
}

struct PtyClientAgentSessionTerminalAdapter: AgentSessionTerminalPtyClient, @unchecked Sendable {
    let client: PtyClient

    func listSessions() async throws -> [PtySessionSummary] {
        try await client.listSessions()
    }

    func openSession(
        name: String,
        launch: PtySessionLaunch,
        columns: UInt32,
        rows: UInt32,
        createIfMissing: Bool,
        clientTitle: String
    ) async throws -> AgentSessionTerminalPtyLease {
        let connection = try await client.openSession(
            name: name,
            launch: launch,
            columns: columns,
            rows: rows,
            createIfMissing: createIfMissing,
            clientTitle: clientTitle
        )
        return AgentSessionTerminalPtyLease(attachment: connection.attachment) {
            try await connection.detach()
        }
    }

    func killSession(name: String) async throws {
        try await client.killSession(name: name)
    }
}
