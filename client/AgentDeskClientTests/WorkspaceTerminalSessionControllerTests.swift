import AgentDeskWire
import Foundation
import PtyClientSwift
import Testing
import UIKit

@testable import AgentDeskClient

@MainActor
struct WorkspaceTerminalSessionControllerTests {
    @Test func rememberedSessionAttachesAndPersistsAfterAcknowledgement() async throws {
        let harness = makeHarness(
            states: ["w1": WorkspaceWorkbenchState(
                preferredTerminalSessionName: "workspace-w1-000000000001"
            )],
            connections: [FakeWorkspaceTerminalConnection(
                sessionName: "workspace-w1-000000000001"
            )]
        )

        harness.controller.selectWorkspace(id: "w1", name: "Alpha")
        let open = try await firstOpen(in: harness.coordinator)
        #expect(open.preferredSessionName == "workspace-w1-000000000001")
        #expect(open.columns >= 80)
        #expect(open.rows >= 24)

        harness.coordinator.yield(.ready(WorkspaceTerminalReady(
            requestID: open.requestID,
            workspaceID: open.workspaceID,
            ptySessionName: "workspace-w1-000000000001"
        )))
        try await waitUntil { harness.coordinator.attachedMessages.count == 1 }

        #expect(harness.opener.requests.map(\.sessionName) == ["workspace-w1-000000000001"])
        #expect(harness.controller.terminalViewForTesting(workspaceID: "w1")?.isAttached == true)
        #expect(harness.stateStore.states["w1"]?.preferredTerminalSessionName
            == "workspace-w1-000000000001")
    }

    @Test func staleReadyAfterWorkspaceSwitchIsCancelledAndCannotAttach() async throws {
        let harness = makeHarness(connections: [FakeWorkspaceTerminalConnection(
            sessionName: "workspace-w2-000000000002"
        )])
        harness.controller.selectWorkspace(id: "w1", name: "Alpha")
        let first = try await firstOpen(in: harness.coordinator)

        harness.controller.selectWorkspace(id: "w2", name: "Beta")
        try await waitUntil { harness.coordinator.openMessages.count == 2 }
        let second = try #require(harness.coordinator.openMessages.last)

        harness.coordinator.yield(.ready(WorkspaceTerminalReady(
            requestID: first.requestID,
            workspaceID: first.workspaceID,
            ptySessionName: "workspace-w1-000000000001"
        )))
        try await waitUntil {
            harness.coordinator.cancelMessages.contains {
                $0.requestID == first.requestID && $0.ptySessionName != nil
            }
        }
        #expect(harness.opener.requests.isEmpty)

        harness.coordinator.yield(.ready(WorkspaceTerminalReady(
            requestID: second.requestID,
            workspaceID: second.workspaceID,
            ptySessionName: "workspace-w2-000000000002"
        )))
        try await waitUntil { harness.coordinator.attachedMessages.count == 1 }

        #expect(harness.controller.selectedWorkspaceIDForTesting == "w2")
        #expect(harness.controller.cachedTerminalCountForTesting == 2)
        #expect(harness.coordinator.attachedMessages.first?.requestID == second.requestID)
    }

    @Test func switchingWorkspacesDetachesButReusesEachWorkspaceView() async throws {
        let firstConnection = FakeWorkspaceTerminalConnection(
            sessionName: "workspace-w1-000000000001"
        )
        let secondConnection = FakeWorkspaceTerminalConnection(
            sessionName: "workspace-w2-000000000002"
        )
        let harness = makeHarness(connections: [firstConnection, secondConnection])

        harness.controller.selectWorkspace(id: "w1", name: "Alpha")
        let firstOpen = try await firstOpen(in: harness.coordinator)
        harness.coordinator.yield(.ready(WorkspaceTerminalReady(
            requestID: firstOpen.requestID,
            workspaceID: "w1",
            ptySessionName: firstConnection.sessionName
        )))
        try await waitUntil { harness.coordinator.attachedMessages.count == 1 }
        let firstView = try #require(harness.controller.terminalViewForTesting(workspaceID: "w1"))

        harness.controller.selectWorkspace(id: "w2", name: "Beta")
        try await waitUntil { firstConnection.detachCount == 1 }
        let secondOpen = try #require(harness.coordinator.openMessages.last)
        harness.coordinator.yield(.ready(WorkspaceTerminalReady(
            requestID: secondOpen.requestID,
            workspaceID: "w2",
            ptySessionName: secondConnection.sessionName
        )))
        try await waitUntil { harness.coordinator.attachedMessages.count == 2 }

        harness.controller.selectWorkspace(id: "w1", name: "Alpha renamed")
        try await waitUntil { secondConnection.detachCount == 1 }

        #expect(harness.controller.terminalViewForTesting(workspaceID: "w1") === firstView)
        #expect(harness.controller.cachedTerminalCountForTesting == 2)
        #expect(harness.coordinator.openMessages.last?.preferredSessionName == firstConnection.sessionName)
    }

    @Test func managerDetachClearsRememberedSessionAndLeavesRetryVisible() async throws {
        let connection = FakeWorkspaceTerminalConnection(
            sessionName: "workspace-w1-000000000001"
        )
        let harness = makeHarness(connections: [connection])
        harness.controller.selectWorkspace(id: "w1", name: "Alpha")
        let open = try await firstOpen(in: harness.coordinator)
        harness.coordinator.yield(.ready(WorkspaceTerminalReady(
            requestID: open.requestID,
            workspaceID: "w1",
            ptySessionName: connection.sessionName
        )))
        try await waitUntil { harness.coordinator.attachedMessages.count == 1 }

        connection.yield(.detachedByManager(7))
        try await waitUntil("manager detach clears remembered session") {
            harness.stateStore.states["w1"]?.preferredTerminalSessionName == nil
        }
        let view = try #require(harness.controller.terminalViewForTesting(workspaceID: "w1"))
        let retry = try #require(view.control(identifier: "workspace-terminal-retry"))

        #expect(!retry.isHidden)
        #expect(!view.isAttached)

        harness.controller.workspaceTerminalViewRequestedRetry(view)
        try await waitUntil("retry sends a second open") {
            harness.coordinator.openMessages.count == 2
        }

        #expect(harness.coordinator.openMessages.last?.preferredSessionName == nil)
    }

    @Test func hidingTerminalResignsPresentationWithoutDetachingSession() async throws {
        let connection = FakeWorkspaceTerminalConnection(
            sessionName: "workspace-w1-000000000001"
        )
        let harness = makeHarness(connections: [connection])
        harness.controller.selectWorkspace(id: "w1", name: "Alpha")
        let open = try await firstOpen(in: harness.coordinator)
        harness.coordinator.yield(.ready(WorkspaceTerminalReady(
            requestID: open.requestID,
            workspaceID: "w1",
            ptySessionName: connection.sessionName
        )))
        try await waitUntil { harness.coordinator.attachedMessages.count == 1 }

        harness.controller.setPresented(false)
        await drainTasks()

        #expect(connection.detachCount == 0)
        #expect(harness.controller.terminalViewForTesting(workspaceID: "w1")?.isAttached == true)
    }

    @Test func hostSessionEndDetachesRendererClearsPreferenceAndOffersRetry() async throws {
        let connection = FakeWorkspaceTerminalConnection(
            sessionName: "workspace-w1-000000000001"
        )
        let harness = makeHarness(connections: [connection])
        harness.controller.selectWorkspace(id: "w1", name: "Alpha")
        let open = try await firstOpen(in: harness.coordinator)
        harness.coordinator.yield(.ready(WorkspaceTerminalReady(
            requestID: open.requestID,
            workspaceID: "w1",
            ptySessionName: connection.sessionName
        )))
        try await waitUntil { harness.coordinator.attachedMessages.count == 1 }

        harness.coordinator.yield(.error(WorkspaceTerminalError(
            requestID: open.requestID,
            workspaceID: "w1",
            ptySessionName: connection.sessionName,
            code: .sessionEnded
        )))
        try await waitUntil { connection.detachCount == 1 }

        let view = try #require(harness.controller.terminalViewForTesting(workspaceID: "w1"))
        let retry = try #require(view.control(identifier: "workspace-terminal-retry"))
        #expect(harness.stateStore.states["w1"]?.preferredTerminalSessionName == nil)
        #expect(!view.isAttached)
        #expect(!retry.isHidden)
    }

    @Test func teardownDetachesTheActiveClientAndIgnoresLaterReady() async throws {
        let connection = FakeWorkspaceTerminalConnection(
            sessionName: "workspace-w1-000000000001"
        )
        let harness = makeHarness(connections: [connection])
        harness.controller.selectWorkspace(id: "w1", name: "Alpha")
        let open = try await firstOpen(in: harness.coordinator)
        harness.coordinator.yield(.ready(WorkspaceTerminalReady(
            requestID: open.requestID,
            workspaceID: "w1",
            ptySessionName: connection.sessionName
        )))
        try await waitUntil { harness.coordinator.attachedMessages.count == 1 }

        harness.controller.teardown()
        try await waitUntil { connection.detachCount == 1 }
        let attachedCount = harness.coordinator.attachedMessages.count
        harness.coordinator.yield(.ready(WorkspaceTerminalReady(
            requestID: open.requestID,
            workspaceID: "w1",
            ptySessionName: connection.sessionName
        )))
        await drainTasks()

        #expect(harness.coordinator.attachedMessages.count == attachedCount)
        #expect(harness.controller.selectedWorkspaceIDForTesting == nil)
    }

    private func makeHarness(
        states: [String: WorkspaceWorkbenchState] = [:],
        connections: [FakeWorkspaceTerminalConnection]
    ) -> WorkspaceTerminalHarness {
        let container = UIView()
        let coordinator = FakeWorkspaceTerminalCoordinator()
        let opener = FakeWorkspaceTerminalOpener(connections: connections)
        let stateStore = FakeWorkspaceWorkbenchStateStore(states: states)
        let controller = WorkspaceTerminalSessionController(
            container: container,
            coordinator: coordinator,
            sessionOpener: opener,
            stateStore: stateStore,
            makeRequestID: RequestIDSequence().next
        )
        return WorkspaceTerminalHarness(
            container: container,
            controller: controller,
            coordinator: coordinator,
            opener: opener,
            stateStore: stateStore
        )
    }

    private func firstOpen(
        in coordinator: FakeWorkspaceTerminalCoordinator
    ) async throws -> WorkspaceTerminalOpen {
        try await waitUntil { !coordinator.openMessages.isEmpty }
        return try #require(coordinator.openMessages.first)
    }

    private func waitUntil(
        _ description: String = "condition",
        attempts: Int = 500,
        _ condition: @MainActor () -> Bool
    ) async throws {
        for _ in 0..<attempts {
            if condition() { return }
            await Task.yield()
        }
        Issue.record("\(description) did not become true")
    }

    private func drainTasks() async {
        for _ in 0..<30 { await Task.yield() }
    }
}

@MainActor
private struct WorkspaceTerminalHarness {
    let container: UIView
    let controller: WorkspaceTerminalSessionController
    let coordinator: FakeWorkspaceTerminalCoordinator
    let opener: FakeWorkspaceTerminalOpener
    let stateStore: FakeWorkspaceWorkbenchStateStore
}

@MainActor
private final class FakeWorkspaceTerminalCoordinator: WorkspaceTerminalCoordinating {
    private let continuation: AsyncStream<WorkspaceTerminalHostMessage>.Continuation
    let workspaceTerminalUpdates: AsyncStream<WorkspaceTerminalHostMessage>
    private(set) var sent: [WorkspaceTerminalClientMessage] = []

    var openMessages: [WorkspaceTerminalOpen] {
        sent.compactMap { if case .open(let message) = $0 { message } else { nil } }
    }

    var attachedMessages: [WorkspaceTerminalAttachedAck] {
        sent.compactMap { if case .attached(let message) = $0 { message } else { nil } }
    }

    var cancelMessages: [WorkspaceTerminalCancel] {
        sent.compactMap { if case .cancel(let message) = $0 { message } else { nil } }
    }

    init() {
        var continuation: AsyncStream<WorkspaceTerminalHostMessage>.Continuation!
        workspaceTerminalUpdates = AsyncStream { continuation = $0 }
        self.continuation = continuation
    }

    func sendWorkspaceTerminal(_ message: WorkspaceTerminalClientMessage) async throws {
        sent.append(message)
    }

    func yield(_ message: WorkspaceTerminalHostMessage) {
        continuation.yield(message)
    }
}

@MainActor
private final class FakeWorkspaceTerminalOpener: WorkspaceTerminalSessionOpening {
    private let connections: [FakeWorkspaceTerminalConnection]
    private(set) var requests: [WorkspaceTerminalAttachmentRequest] = []

    init(connections: [FakeWorkspaceTerminalConnection]) {
        self.connections = connections
    }

    func openWorkspaceTerminal(
        _ request: WorkspaceTerminalAttachmentRequest
    ) async throws -> any WorkspaceTerminalConnection {
        let index = requests.count
        requests.append(request)
        return connections[Swift.min(index, connections.count - 1)]
    }
}

@MainActor
private final class FakeWorkspaceWorkbenchStateStore: WorkspaceWorkbenchStateStoring {
    private(set) var states: [String: WorkspaceWorkbenchState]

    init(states: [String: WorkspaceWorkbenchState] = [:]) {
        self.states = states
    }

    func state(for workspaceID: String) -> WorkspaceWorkbenchState {
        states[workspaceID] ?? WorkspaceWorkbenchState()
    }

    func setState(_ state: WorkspaceWorkbenchState, for workspaceID: String) {
        states = states.merging([workspaceID: state]) { _, replacement in replacement }
    }
}

private final class FakeWorkspaceTerminalConnection: WorkspaceTerminalConnection, @unchecked Sendable {
    private let lock = NSLock()
    private let continuation: AsyncThrowingStream<PtySessionEvent, Error>.Continuation
    private let stream: AsyncThrowingStream<PtySessionEvent, Error>
    private var detachCountStorage = 0

    let sessionName: String

    init(sessionName: String) {
        self.sessionName = sessionName
        var continuation: AsyncThrowingStream<PtySessionEvent, Error>.Continuation!
        stream = AsyncThrowingStream { continuation = $0 }
        self.continuation = continuation
    }

    var detachCount: Int { lock.withLock { detachCountStorage } }

    func events() -> AsyncThrowingStream<PtySessionEvent, Error> { stream }
    func sendInput(_ data: Data) async throws {}
    func updateViewerState(
        sequence: UInt64,
        active: Bool,
        claim: Bool,
        columns: UInt32,
        rows: UInt32
    ) async throws {}

    func detach() async throws {
        lock.withLock { detachCountStorage += 1 }
        continuation.finish()
    }

    func yield(_ event: PtySessionEvent) {
        continuation.yield(event)
    }
}

private final class RequestIDSequence: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0

    func next() -> String {
        lock.withLock {
            value += 1
            return "request-\(value)"
        }
    }
}

private extension UIView {
    func control(identifier: String) -> UIControl? {
        if accessibilityIdentifier == identifier { return self as? UIControl }
        return subviews.lazy.compactMap { $0.control(identifier: identifier) }.first
    }
}
