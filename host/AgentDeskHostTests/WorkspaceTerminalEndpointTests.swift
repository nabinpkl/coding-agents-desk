import AgentDeskWire
import Foundation
import Testing

@testable import AgentDeskHost

struct WorkspaceTerminalEndpointTests {
    @Test func cancelledRequestIsTombstonedAndCannotResurrectAWorkspaceTerminal() async throws {
        let workspaceID = "62193559-6f63-4b24-a53e-ea2f23c39d4a"
        let sessionName = "workspace-62193559-6f63-4b24-a53e-ea2f23c39d4a-a1b2c3d4e5f6"
        let coordinator = FakeWorkspaceTerminalCoordinator(
            ready: WorkspaceTerminalCoordinatorReady(
                requestID: "test:request-1",
                workspaceID: UUID(uuidString: workspaceID)!,
                ptySessionName: sessionName,
                pid: 7_001
            )
        )
        let sink = WorkspaceTerminalPushSink()
        let endpoint = WorkspaceTerminalEndpoint(
            coordinator: coordinator,
            requestNamespace: "test",
            clientTitle: "test-bootstrap",
            tombstoneLimit: 8,
            push: { await sink.append($0) }
        )
        let open = WorkspaceTerminalOpen(
            requestID: "request-1",
            workspaceID: workspaceID,
            columns: 100,
            rows: 30
        )

        await endpoint.handle(.open(open))
        await endpoint.handle(.attached(WorkspaceTerminalAttachedAck(
            requestID: open.requestID,
            workspaceID: workspaceID,
            ptySessionName: sessionName
        )))
        await endpoint.handle(.cancel(WorkspaceTerminalCancel(
            requestID: open.requestID,
            workspaceID: workspaceID,
            ptySessionName: sessionName
        )))
        await endpoint.handle(.open(open))

        #expect(await coordinator.openCount == 1)
        #expect(await coordinator.acknowledgements.count == 1)
        #expect(await coordinator.cancellations.count == 1)
        #expect(await sink.messages == [
            .ready(WorkspaceTerminalReady(
                requestID: open.requestID,
                workspaceID: workspaceID,
                ptySessionName: sessionName
            )),
            .error(WorkspaceTerminalError(
                requestID: open.requestID,
                workspaceID: workspaceID,
                code: .sessionEnded
            )),
        ])
    }
}

private actor WorkspaceTerminalPushSink {
    private(set) var messages: [WorkspaceTerminalHostMessage] = []

    func append(_ message: WorkspaceTerminalHostMessage) {
        messages.append(message)
    }
}

private actor FakeWorkspaceTerminalCoordinator: WorkspaceTerminalCoordinating {
    let ready: WorkspaceTerminalCoordinatorReady
    private(set) var openCount = 0
    private(set) var acknowledgements: [(String, String, String)] = []
    private(set) var cancellations: [(String, String, String?)] = []

    init(ready: WorkspaceTerminalCoordinatorReady) {
        self.ready = ready
    }

    func open(_ request: WorkspaceTerminalOpenRequest) async throws -> WorkspaceTerminalCoordinatorReady {
        openCount += 1
        return ready
    }

    func acknowledgeAttachment(
        requestID: String,
        workspaceID: String,
        ptySessionName: String
    ) async {
        acknowledgements.append((requestID, workspaceID, ptySessionName))
    }

    func cancel(requestID: String, workspaceID: String, ptySessionName: String?) async {
        cancellations.append((requestID, workspaceID, ptySessionName))
    }
}
