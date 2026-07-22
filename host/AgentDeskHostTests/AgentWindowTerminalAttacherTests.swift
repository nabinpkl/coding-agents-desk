import Foundation
import PtyClientSwift
import PtyTerminalSession
import Testing

@testable import AgentDeskHost

@MainActor
struct AgentWindowTerminalAttacherTests {
    private let sessionName = "agent-resume-codex-session-1"

    @Test func opensExactRunningLeasedSessionWithoutCreating() async throws {
        let client = FakeAgentWindowPtyClient()
        let connection = FakeProductionAttacherConnection()
        let summary = session(
            name: sessionName,
            pid: 4_321,
            state: .running,
            lifetime: .leased
        )
        client.sessions = [summary]
        client.openedConnection = AgentWindowOpenedPtyConnection(
            connection: connection,
            sessionName: sessionName,
            attachment: attachment(name: sessionName, pid: summary.pid)
        )
        let attacher = PtyClientAgentWindowTerminalAttacher(clientRouter: client)

        _ = try await attacher.attach(
            sessionName: sessionName,
            columns: 101,
            rows: 37
        )

        #expect(client.listCount == 1)
        #expect(client.openRequests == [FakeAgentWindowPtyClient.OpenRequest(
            name: sessionName,
            launch: .shell(cwd: summary.cwd, shell: summary.shell),
            lifetime: .leased,
            columns: 101,
            rows: 37,
            createIfMissing: false,
            clientTitle: "Agent Panel macOS"
        )])
        #expect(connection.detachCount == 0)
    }

    @Test func rejectsWrongNameExitedOrPersistentSessionBeforeOpening() async {
        let unavailableCases: [[PtySessionSummary]] = [
            [session(name: "other-session", state: .running, lifetime: .leased)],
            [session(name: sessionName, state: .exited, lifetime: .leased)],
            [session(name: sessionName, state: .running, lifetime: .persistent)],
        ]

        for sessions in unavailableCases {
            let client = FakeAgentWindowPtyClient()
            client.sessions = sessions
            let attacher = PtyClientAgentWindowTerminalAttacher(clientRouter: client)

            do {
                _ = try await attacher.attach(sessionName: sessionName, columns: 80, rows: 24)
                Issue.record("Expected unavailable session rejection")
            } catch {
                #expect(error as? AgentWindowTerminalAttachError == .sessionUnavailable)
            }
            #expect(client.openRequests.isEmpty)
        }
    }

    @Test func mismatchedReturnedNameAttachmentOrPIDIsDetachedAndRejected() async {
        let expectedPID: UInt32 = 7_654
        let mismatchCases: [(String, String, UInt32)] = [
            ("wrong-connection", sessionName, expectedPID),
            (sessionName, "wrong-attachment", expectedPID),
            (sessionName, sessionName, expectedPID + 1),
        ]

        for (connectionName, attachmentName, attachmentPID) in mismatchCases {
            let client = FakeAgentWindowPtyClient()
            let connection = FakeProductionAttacherConnection()
            client.sessions = [session(
                name: sessionName,
                pid: expectedPID,
                state: .running,
                lifetime: .leased
            )]
            client.openedConnection = AgentWindowOpenedPtyConnection(
                connection: connection,
                sessionName: connectionName,
                attachment: attachment(name: attachmentName, pid: attachmentPID)
            )
            let attacher = PtyClientAgentWindowTerminalAttacher(clientRouter: client)

            do {
                _ = try await attacher.attach(sessionName: sessionName, columns: 80, rows: 24)
                Issue.record("Expected returned session identity rejection")
            } catch {
                #expect(error as? AgentWindowTerminalAttachError == .sessionIdentityMismatch)
            }
            #expect(connection.detachCount == 1)
        }
    }

    private func session(
        name: String,
        pid: UInt32 = 1_234,
        state: PtySessionSummary.State,
        lifetime: PtySessionLifetime
    ) -> PtySessionSummary {
        PtySessionSummary(
            name: name,
            cwd: "/Users/dev/project",
            shell: "/bin/zsh",
            pid: pid,
            state: state,
            lifetime: lifetime,
            startedAtUnixMilliseconds: 1_721_344_000_123,
            clients: []
        )
    }

    private func attachment(name: String, pid: UInt32) -> PtySessionAttachment {
        PtySessionAttachment(
            name: name,
            pid: pid,
            cwd: "/Users/dev/project",
            shell: "/bin/zsh",
            clientCount: 1,
            clientID: 88
        )
    }
}

@MainActor
private final class FakeAgentWindowPtyClient: AgentWindowPtyClientRouting {
    struct OpenRequest: Equatable {
        let name: String
        let launch: PtySessionLaunch
        let lifetime: PtySessionLifetime
        let columns: UInt32
        let rows: UInt32
        let createIfMissing: Bool
        let clientTitle: String
    }

    var sessions: [PtySessionSummary] = []
    var openedConnection: AgentWindowOpenedPtyConnection?
    var listCount = 0
    var openRequests: [OpenRequest] = []

    func listSessions() async throws -> [PtySessionSummary] {
        listCount += 1
        return sessions
    }

    func openSession(
        name: String,
        launch: PtySessionLaunch,
        lifetime: PtySessionLifetime,
        columns: UInt32,
        rows: UInt32,
        createIfMissing: Bool,
        clientTitle: String
    ) async throws -> AgentWindowOpenedPtyConnection {
        openRequests.append(OpenRequest(
            name: name,
            launch: launch,
            lifetime: lifetime,
            columns: columns,
            rows: rows,
            createIfMissing: createIfMissing,
            clientTitle: clientTitle
        ))
        guard let openedConnection else {
            throw AgentWindowTerminalAttachError.sessionUnavailable
        }
        return openedConnection
    }
}

private final class FakeProductionAttacherConnection: PtyTerminalConnection, @unchecked Sendable {
    private(set) var detachCount = 0

    func events() -> AsyncThrowingStream<PtySessionEvent, Error> {
        AsyncThrowingStream { $0.finish() }
    }

    func sendInput(_ data: Data) async throws {}
    func updateViewerState(
        sequence: UInt64,
        active: Bool,
        claim: Bool,
        columns: UInt32,
        rows: UInt32
    ) async throws {}
    func detach() async throws { detachCount += 1 }
}
