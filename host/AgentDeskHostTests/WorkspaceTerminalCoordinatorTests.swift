import Foundation
import PtyClientSwift
import Testing

@testable import AgentDeskHost

struct WorkspaceTerminalCoordinatorTests {
    @Test func workspaceIdentityIsStableAndRejectsOtherNamespaces() {
        let workspaceID = UUID(uuidString: "62193559-6f63-4b24-a53e-ea2f23c39d4a")!
        let identity = WorkspaceTerminalIdentity(workspaceID: workspaceID)
        let sessionName = identity.makeSessionName(
            id: UUID(uuidString: "a1b2c3d4-e5f6-47a8-9000-000000000000")!
        )

        #expect(sessionName == "workspace-62193559-6f63-4b24-a53e-ea2f23c39d4a-a1b2c3d4e5f6")
        #expect(identity.owns(sessionName: sessionName))
        #expect(!identity.owns(sessionName: "alpha-a1b2c3d4e5f6"))
        #expect(!identity.owns(sessionName: "workspace-62193559-6f63-4b24-a53e-ea2f23c39d4a-not-hex"))
    }

    @Test func preferredWinsThenFallbackSelectsNewestEligibleWorkspaceSession() async throws {
        let harness = try await Harness.make()
        defer { harness.cleanup() }
        let identity = WorkspaceTerminalIdentity(workspaceID: harness.workspaceID)
        let preferred = identity.makeSessionName(id: UUID(uuidString: "11111111-1111-4111-8111-111111111111")!)
        let newest = identity.makeSessionName(id: UUID(uuidString: "22222222-2222-4222-8222-222222222222")!)
        let wrongRoot = identity.makeSessionName(id: UUID(uuidString: "33333333-3333-4333-8333-333333333333")!)
        await harness.pty.seed(name: preferred, cwd: harness.root.path, startedAt: 10)
        await harness.pty.seed(name: newest, cwd: harness.root.path, startedAt: 20)
        await harness.pty.seed(name: wrongRoot, cwd: harness.root.appendingPathComponent("other").path, startedAt: 30)

        let preferredReady = try await harness.coordinator.open(harness.request(
            id: "preferred",
            preferredSessionName: preferred
        ))
        #expect(preferredReady.ptySessionName == preferred)
        await harness.coordinator.acknowledgeAttachment(
            requestID: "preferred",
            workspaceID: harness.workspaceID.uuidString,
            ptySessionName: preferred
        )

        let newestReady = try await harness.coordinator.open(harness.request(id: "latest"))
        #expect(newestReady.ptySessionName == newest)
        let calls = await harness.pty.openCalls
        #expect(calls.map(\.createIfMissing) == [false, false])
    }

    @Test func clientCannotEscapeItsWorkspaceTerminalNamespace() async throws {
        let harness = try await Harness.make()
        defer { harness.cleanup() }

        await #expect(throws: WorkspaceTerminalCoordinatorError.invalidSession) {
            try await harness.coordinator.open(harness.request(
                id: "invalid",
                preferredSessionName: "general-terminal-a1b2c3d4e5f6"
            ))
        }
        #expect(await harness.pty.openCalls.isEmpty)
    }

    @Test func incompatibleSessionsAreSkippedAndFreshShellUsesHostWorkspaceRoot() async throws {
        let harness = try await Harness.make()
        defer { harness.cleanup() }
        let identity = WorkspaceTerminalIdentity(workspaceID: harness.workspaceID)
        await harness.pty.seed(
            name: identity.makeSessionName(id: UUID(uuidString: "44444444-4444-4444-8444-444444444444")!),
            cwd: harness.root.path,
            lifetime: .leased,
            startedAt: 100
        )

        let ready = try await harness.coordinator.open(harness.request(id: "fresh"))
        #expect(identity.owns(sessionName: ready.ptySessionName))
        let call = try #require(await harness.pty.openCalls.first)
        #expect(call.createIfMissing)
        #expect(call.lifetime == .persistent)
        #expect(call.launch == .shell(cwd: harness.root.path, shell: "/bin/zsh"))
    }

    @Test func timeoutKillsOnlyAStillUnownedSessionCreatedForTheHandoff() async throws {
        let harness = try await Harness.make()
        defer { harness.cleanup() }
        let ready = try await harness.coordinator.open(harness.request(id: "timeout"))

        await harness.waiter.fireAll()
        try await waitUntil { await harness.pty.killCount == 1 }

        #expect(await harness.pty.session(named: ready.ptySessionName) == nil)
        #expect(await harness.pty.detachCount == 1)
    }

    @Test func timeoutNeverKillsAPreexistingWorkspaceSession() async throws {
        let harness = try await Harness.make()
        defer { harness.cleanup() }
        let identity = WorkspaceTerminalIdentity(workspaceID: harness.workspaceID)
        let existing = identity.makeSessionName(id: UUID(uuidString: "55555555-5555-4555-8555-555555555555")!)
        await harness.pty.seed(name: existing, cwd: harness.root.path, startedAt: 1)
        _ = try await harness.coordinator.open(harness.request(id: "timeout-existing"))

        await harness.waiter.fireAll()
        try await waitUntil { await harness.pty.detachCount == 1 }

        #expect(await harness.pty.killCount == 0)
        #expect(await harness.pty.session(named: existing) != nil)
    }

    private func waitUntil(
        timeout: Duration = .seconds(2),
        condition: @escaping @Sendable () async -> Bool
    ) async throws {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while !(await condition()) {
            if clock.now >= deadline { throw TestTimeout() }
            try await Task.sleep(for: .milliseconds(10))
        }
    }
}

private struct TestTimeout: Error {}

private final class Harness: @unchecked Sendable {
    let directory: URL
    let root: URL
    let workspaceID: UUID
    let pty: FakeWorkspaceTerminalPtyClient
    let waiter: WorkspaceTerminalWaiter
    let coordinator: WorkspaceTerminalCoordinator

    private init(
        directory: URL,
        root: URL,
        workspaceID: UUID,
        pty: FakeWorkspaceTerminalPtyClient,
        waiter: WorkspaceTerminalWaiter,
        coordinator: WorkspaceTerminalCoordinator
    ) {
        self.directory = directory
        self.root = root
        self.workspaceID = workspaceID
        self.pty = pty
        self.waiter = waiter
        self.coordinator = coordinator
    }

    static func make() async throws -> Harness {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("workspace-terminal-\(UUID().uuidString)", isDirectory: true)
        let root = directory.appendingPathComponent("workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let workspaceID = UUID()
        let repository = WorkspaceRepository(
            donorURL: directory.appendingPathComponent("absent-donor.json"),
            destinationURL: directory.appendingPathComponent("workspaces.json")
        )
        _ = try await repository.register(id: workspaceID, root: root, name: "Workspace")
        let pty = FakeWorkspaceTerminalPtyClient()
        let waiter = WorkspaceTerminalWaiter()
        let coordinator = WorkspaceTerminalCoordinator(
            repository: repository,
            ptyClient: pty,
            shell: "/bin/zsh",
            requestTombstoneLimit: 32,
            waitForHandoffTimeout: { try await waiter.wait() },
            onEvent: { _ in }
        )
        return Harness(
            directory: directory,
            root: root,
            workspaceID: workspaceID,
            pty: pty,
            waiter: waiter,
            coordinator: coordinator
        )
    }

    func request(id: String, preferredSessionName: String? = nil) -> WorkspaceTerminalOpenRequest {
        WorkspaceTerminalOpenRequest(
            requestID: id,
            workspaceID: workspaceID.uuidString,
            preferredSessionName: preferredSessionName,
            columns: 100,
            rows: 30,
            clientTitle: "test-bootstrap"
        )
    }

    func cleanup() {
        try? FileManager.default.removeItem(at: directory)
    }
}

private actor WorkspaceTerminalWaiter {
    private var waiters: [CheckedContinuation<Void, Error>] = []

    func wait() async throws {
        try await withCheckedThrowingContinuation { waiters.append($0) }
    }

    func fireAll() {
        let active = waiters
        waiters.removeAll()
        active.forEach { $0.resume() }
    }
}

private actor FakeWorkspaceTerminalPtyClient: AgentSessionTerminalPtyClient {
    struct OpenCall: Equatable, Sendable {
        let name: String
        let launch: PtySessionLaunch
        let lifetime: PtySessionLifetime
        let createIfMissing: Bool
    }

    private struct Session: Sendable {
        let name: String
        let cwd: String
        let shell: String
        let pid: UInt32
        let lifetime: PtySessionLifetime
        let startedAt: UInt64
        var clients: [PtySessionClientSummary]

        var summary: PtySessionSummary {
            PtySessionSummary(
                name: name,
                cwd: cwd,
                shell: shell,
                pid: pid,
                state: .running,
                lifetime: lifetime,
                startedAtUnixMilliseconds: startedAt,
                clients: clients
            )
        }
    }

    private var sessions: [String: Session] = [:]
    private var nextPID: UInt32 = 7_000
    private var nextClientID: UInt64 = 1
    private(set) var openCalls: [OpenCall] = []
    private(set) var detachCount = 0
    private(set) var killCount = 0

    func seed(
        name: String,
        cwd: String,
        lifetime: PtySessionLifetime = .persistent,
        startedAt: UInt64
    ) {
        sessions[name] = Session(
            name: name,
            cwd: cwd,
            shell: "/bin/zsh",
            pid: nextPID,
            lifetime: lifetime,
            startedAt: startedAt,
            clients: []
        )
        nextPID += 1
    }

    func listSessions() async throws -> [PtySessionSummary] {
        sessions.values.map(\.summary)
    }

    func openSession(
        name: String,
        launch: PtySessionLaunch,
        lifetime: PtySessionLifetime,
        columns: UInt32,
        rows: UInt32,
        createIfMissing: Bool,
        clientTitle: String
    ) async throws -> AgentSessionTerminalPtyLease {
        openCalls.append(OpenCall(
            name: name,
            launch: launch,
            lifetime: lifetime,
            createIfMissing: createIfMissing
        ))
        if sessions[name] == nil {
            guard createIfMissing else { throw FakeError.missingSession }
            guard case .shell(let cwd, let shell) = launch else { throw FakeError.invalidLaunch }
            sessions[name] = Session(
                name: name,
                cwd: cwd,
                shell: shell,
                pid: nextPID,
                lifetime: lifetime,
                startedAt: 1_000,
                clients: []
            )
            nextPID += 1
        }
        guard var session = sessions[name] else { throw FakeError.missingSession }
        let clientID = nextClientID
        nextClientID += 1
        session.clients.append(PtySessionClientSummary(id: clientID, title: clientTitle))
        sessions[name] = session
        let attachment = PtySessionAttachment(
            name: name,
            pid: session.pid,
            cwd: session.cwd,
            shell: session.shell,
            clientCount: UInt32(session.clients.count),
            clientID: clientID
        )
        return AgentSessionTerminalPtyLease(attachment: attachment) {
            await self.detach(name: name, clientID: clientID)
        }
    }

    func killSession(name: String) async throws {
        killCount += 1
        sessions.removeValue(forKey: name)
    }

    func session(named name: String) -> PtySessionSummary? {
        sessions[name]?.summary
    }

    private func detach(name: String, clientID: UInt64) {
        guard var session = sessions[name] else { return }
        session.clients.removeAll { $0.id == clientID }
        sessions[name] = session
        detachCount += 1
    }

    private enum FakeError: Error {
        case missingSession
        case invalidLaunch
    }
}
