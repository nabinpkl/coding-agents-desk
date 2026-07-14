import Foundation
import PtyClientSwift
import Testing

@testable import AgentDeskHost

struct AgentSessionTerminalCoordinatorTests {
    private let claudeSessionID = "a4cdd7b8-3f9a-4d80-bc72-5f4aab6f39e1"
    private let codexSessionID = "5315800f-fab6-42ed-a80f-a622f563b57a"

    @Test func concurrentPlatformOpensCreateOneLeasedProcess() async throws {
        let fixture = try Fixture()
        defer { fixture.removeTemporaryFiles() }
        let macRequest = fixture.request(
            id: "mac-open",
            source: "claude",
            sessionID: claudeSessionID,
            platform: .macOS
        )
        let phoneRequest = fixture.request(
            id: "phone-open",
            source: "claude",
            sessionID: claudeSessionID,
            platform: .iOS
        )

        async let macReady = fixture.coordinator.open(macRequest)
        async let phoneReady = fixture.coordinator.open(phoneRequest)
        let (mac, phone) = try await (macReady, phoneReady)

        #expect(mac.ptySessionName == "agent-resume-claude-\(claudeSessionID)")
        #expect(phone.ptySessionName == mac.ptySessionName)
        #expect(phone.pid == mac.pid)
        #expect(await fixture.pty.createdSessionCount == 1)
        let calls = await fixture.pty.openCalls
        #expect(calls.count == 2)
        #expect(calls.filter(\.createIfMissing).count == 1)
        #expect(calls.allSatisfy { $0.lifetime == .leased })
    }

    @Test func handoffTimeoutReleasesBootstrapAndKillsNewSession() async throws {
        let events = EventRecorder()
        let fixture = try Fixture(onEvent: { event in
            Task { await events.append(event) }
        })
        defer { fixture.removeTemporaryFiles() }
        let request = fixture.request(
            id: "timeout",
            source: "claude",
            sessionID: claudeSessionID,
            platform: .macOS
        )

        let ready = try await fixture.coordinator.open(request)
        try await waitUntil { await fixture.timeout.waiterCount == 1 }
        await fixture.timeout.fireAll()
        try await waitUntil { await fixture.pty.killCount == 1 }

        #expect(await fixture.pty.session(named: ready.ptySessionName) == nil)
        #expect(await fixture.pty.detachCount == 1)
        try await waitUntil { await events.values.count == 1 }
        #expect(await events.values == [
            .handoffTimedOut(requestID: request.requestID, ready: ready),
        ])
    }

    @Test func acknowledgedFirstPlatformThenSecondPlatformReusesPID() async throws {
        let fixture = try Fixture()
        defer { fixture.removeTemporaryFiles() }
        let macRequest = fixture.request(
            id: "mac",
            source: "claude",
            sessionID: claudeSessionID,
            platform: .macOS
        )
        let phoneRequest = fixture.request(
            id: "phone",
            source: "claude",
            sessionID: claudeSessionID,
            platform: .iOS
        )

        let mac = try await fixture.coordinator.open(macRequest)
        _ = try await fixture.pty.attachNative(to: mac.ptySessionName, title: "native-mac")
        await fixture.coordinator.acknowledgeAttachment(
            requestID: macRequest.requestID,
            ptySessionName: mac.ptySessionName
        )
        let phone = try await fixture.coordinator.open(phoneRequest)

        #expect(phone.pid == mac.pid)
        #expect(await fixture.pty.createdSessionCount == 1)
        let calls = await fixture.pty.openCalls
        #expect(calls.map(\.createIfMissing) == [true, false])
        #expect(await fixture.pty.detachCount == 1)
    }

    @Test func partialLaunchFailureReturnsTypedErrorAndLeavesNoPTY() async throws {
        let fixture = try Fixture()
        defer { fixture.removeTemporaryFiles() }
        await fixture.pty.setFailureMode(.afterCreate)
        let request = fixture.request(
            id: "fails",
            source: "claude",
            sessionID: claudeSessionID,
            platform: .macOS
        )

        do {
            _ = try await fixture.coordinator.open(request)
            Issue.record("Expected a typed launch failure")
        } catch let error as AgentSessionTerminalCoordinatorError {
            guard case .launchFailed = error else {
                Issue.record("Unexpected coordinator error: \(error)")
                return
            }
        }

        #expect(await fixture.pty.sessionCount == 0)
        #expect(await fixture.pty.killCount == 1)
        #expect(await fixture.timeout.waiterCount == 0)
    }

    @Test func externallyLiveSessionIsRejectedUnlessPanelPTYAlreadyExists() async throws {
        let fixture = try Fixture(isLive: true)
        defer { fixture.removeTemporaryFiles() }
        let request = fixture.request(
            id: "external",
            source: "claude",
            sessionID: claudeSessionID,
            platform: .macOS
        )

        await #expect(throws: AgentSessionTerminalCoordinatorError.activeElsewhere) {
            try await fixture.coordinator.open(request)
        }
        #expect(await fixture.pty.openCalls.isEmpty)

        let identity = try fixture.identity(source: "claude", sessionID: claudeSessionID)
        await fixture.pty.seedSession(
            name: identity.ptySessionName,
            pid: 991,
            lifetime: .leased
        )
        let existing = try await fixture.coordinator.open(fixture.request(
            id: "existing",
            source: "claude",
            sessionID: claudeSessionID,
            platform: .iOS
        ))

        #expect(existing.pid == 991)
        #expect(await fixture.pty.openCalls.last?.createIfMissing == false)
    }

    @Test func sidecarLivenessMatchesCanonicalProjectSourceAndSession() async throws {
        let fixture = try Fixture()
        defer { fixture.removeTemporaryFiles() }
        let identity = try fixture.identity(source: "claude", sessionID: claudeSessionID)
        let liveSession = EngineSessionDigest(
            sessionId: claudeSessionID.uppercased(),
            source: "claude",
            bin: "live",
            lastEventAt: nil,
            title: nil,
            firstPrompt: nil,
            lastUserPrompt: nil
        )
        let client = DigestSidecarClient(projects: [
            EngineProjectDigest(
                project: fixture.project.path,
                projectName: "project",
                source: "claude",
                sources: ["claude"],
                observed: true,
                lastEventAt: nil,
                bin: "live",
                primary: liveSession,
                sessions: [],
                otherSessions: []
            ),
        ])
        let checker = SidecarAgentSessionTerminalLivenessChecker(client: client)

        #expect(try await checker.isLive(identity))
        let codexIdentity = try fixture.identity(source: "codex", sessionID: claudeSessionID)
        #expect(try await checker.isLive(codexIdentity) == false)
    }

    @Test func coordinatorBuildsExactPositionalArgvFromInjectedConfigOnly() async throws {
        let executables = AgentResumeLaunch.Executables(
            claude: "/custom/claude; $(touch never)",
            codex: "/custom/codex && false"
        )
        let fixture = try Fixture(executables: executables)
        defer { fixture.removeTemporaryFiles() }

        _ = try await fixture.coordinator.open(fixture.request(
            id: "claude",
            source: "claude",
            sessionID: claudeSessionID,
            platform: .macOS
        ))
        _ = try await fixture.coordinator.open(fixture.request(
            id: "codex",
            source: "codex",
            sessionID: codexSessionID,
            platform: .iOS
        ))

        let calls = await fixture.pty.openCalls
        #expect(calls.count == 2)
        #expect(calls[0].launch == .command(
            cwd: fixture.project.path,
            executable: "/bin/zsh",
            arguments: [
                "-l",
                "-c",
                AgentResumeLaunch.positionalForwardingScript,
                executables.claude,
                "--resume",
                claudeSessionID,
            ]
        ))
        #expect(calls[1].launch == .command(
            cwd: fixture.project.path,
            executable: "/bin/zsh",
            arguments: [
                "-l",
                "-c",
                AgentResumeLaunch.positionalForwardingScript,
                executables.codex,
                "resume",
                codexSessionID,
            ]
        ))
        #expect(calls.allSatisfy {
            guard case .command(_, _, let arguments) = $0.launch else { return false }
            return arguments[2] == #"exec "$0" "$@""#
                && !arguments[2].contains("custom")
                && !arguments[2].contains(claudeSessionID)
                && !arguments[2].contains(codexSessionID)
        })
    }

    @Test func duplicateRequestSharesOneBootstrapAndDuplicateAckIsHarmless() async throws {
        let fixture = try Fixture()
        defer { fixture.removeTemporaryFiles() }
        let request = fixture.request(
            id: "duplicate",
            source: "claude",
            sessionID: claudeSessionID,
            platform: .macOS
        )

        async let firstOpen = fixture.coordinator.open(request)
        async let duplicateOpen = fixture.coordinator.open(request)
        let (first, duplicate) = try await (firstOpen, duplicateOpen)
        #expect(first == duplicate)
        #expect(await fixture.pty.openCalls.count == 1)

        _ = try await fixture.pty.attachNative(to: first.ptySessionName, title: "native")
        await fixture.coordinator.acknowledgeAttachment(
            requestID: request.requestID,
            ptySessionName: first.ptySessionName
        )
        await fixture.coordinator.acknowledgeAttachment(
            requestID: request.requestID,
            ptySessionName: first.ptySessionName
        )
        #expect(await fixture.pty.detachCount == 1)
    }

    @Test func duplicateRequestIDWithDifferentContextIsRejected() async throws {
        let fixture = try Fixture()
        defer { fixture.removeTemporaryFiles() }
        let original = fixture.request(
            id: "collision",
            source: "claude",
            sessionID: claudeSessionID,
            platform: .macOS
        )
        _ = try await fixture.coordinator.open(original)
        let conflicting = fixture.request(
            id: original.requestID,
            source: "codex",
            sessionID: codexSessionID,
            platform: .iOS
        )

        await #expect(throws: AgentSessionTerminalCoordinatorError.sessionEnded) {
            try await fixture.coordinator.open(conflicting)
        }
        #expect(await fixture.pty.openCalls.count == 1)
    }

    @Test func staleAckAndDuplicateCloseCannotAffectReplacementProcess() async throws {
        let fixture = try Fixture()
        defer { fixture.removeTemporaryFiles() }
        let oldRequest = fixture.request(
            id: "old",
            source: "claude",
            sessionID: claudeSessionID,
            platform: .macOS
        )
        let old = try await fixture.coordinator.open(oldRequest)
        _ = try await fixture.pty.attachNative(to: old.ptySessionName, title: "old-native")
        await fixture.coordinator.acknowledgeAttachment(
            requestID: oldRequest.requestID,
            ptySessionName: old.ptySessionName
        )
        await fixture.coordinator.close(
            requestID: oldRequest.requestID,
            ptySessionName: old.ptySessionName
        )

        let newRequest = fixture.request(
            id: "new",
            source: "claude",
            sessionID: claudeSessionID,
            platform: .iOS
        )
        let replacement = try await fixture.coordinator.open(newRequest)
        #expect(replacement.pid != old.pid)
        let detachesBeforeStaleMessages = await fixture.pty.detachCount

        await fixture.coordinator.acknowledgeAttachment(
            requestID: oldRequest.requestID,
            ptySessionName: old.ptySessionName
        )
        await fixture.coordinator.close(
            requestID: oldRequest.requestID,
            ptySessionName: old.ptySessionName
        )

        #expect(await fixture.pty.detachCount == detachesBeforeStaleMessages)
        #expect(await fixture.pty.killCount == 1)
        #expect(await fixture.pty.session(named: replacement.ptySessionName)?.pid == replacement.pid)
    }

    @Test func creatorTimeoutDoesNotKillSessionAdoptedByAnotherHandoff() async throws {
        let fixture = try Fixture()
        defer { fixture.removeTemporaryFiles() }
        let creatorRequest = fixture.request(
            id: "creator",
            source: "claude",
            sessionID: claudeSessionID,
            platform: .macOS
        )
        let adopterRequest = fixture.request(
            id: "adopter",
            source: "claude",
            sessionID: claudeSessionID,
            platform: .iOS
        )
        let creator = try await fixture.coordinator.open(creatorRequest)
        let adopter = try await fixture.coordinator.open(adopterRequest)
        _ = try await fixture.pty.attachNative(to: adopter.ptySessionName, title: "adopter-native")
        await fixture.coordinator.acknowledgeAttachment(
            requestID: adopterRequest.requestID,
            ptySessionName: adopter.ptySessionName
        )
        try await waitUntil { await fixture.timeout.waiterCount == 1 }

        await fixture.timeout.fireAll()
        try await waitUntil { await fixture.pty.detachCount == 2 }

        #expect(await fixture.pty.killCount == 0)
        #expect(await fixture.pty.session(named: creator.ptySessionName)?.pid == creator.pid)
    }

    private func waitUntil(
        _ condition: @escaping @Sendable () async -> Bool
    ) async throws {
        for _ in 0..<200 {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        Issue.record("Timed out waiting for asynchronous test condition")
    }
}

private struct Fixture: @unchecked Sendable {
    let sandbox: URL
    let home: URL
    let project: URL
    let pty: FakeAgentSessionTerminalPtyClient
    let liveness: FakeAgentSessionTerminalLivenessChecker
    let timeout: ManualHandoffTimeout
    let coordinator: AgentSessionTerminalCoordinator

    init(
        isLive: Bool = false,
        executables: AgentResumeLaunch.Executables = Config.agentResumeExecutables(environment: [:]),
        onEvent: @escaping @Sendable (AgentSessionTerminalCoordinatorEvent) -> Void = { _ in }
    ) throws {
        sandbox = FileManager.default.temporaryDirectory
            .appendingPathComponent("agent-session-terminal-tests-\(UUID().uuidString)", isDirectory: true)
        home = sandbox.appendingPathComponent("home", isDirectory: true)
        project = home.appendingPathComponent("project; $(not-shell)", isDirectory: true)
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        let pty = FakeAgentSessionTerminalPtyClient()
        let liveness = FakeAgentSessionTerminalLivenessChecker(isLive: isLive)
        let timeout = ManualHandoffTimeout()
        self.pty = pty
        self.liveness = liveness
        self.timeout = timeout
        coordinator = AgentSessionTerminalCoordinator(
            ptyClient: pty,
            livenessChecker: liveness,
            homeDirectory: home,
            executables: executables,
            waitForHandoffTimeout: { try await timeout.wait() },
            onEvent: onEvent
        )
    }

    func request(
        id: String,
        source: String,
        sessionID: String,
        platform: AgentSessionTerminalPlatform
    ) -> AgentSessionTerminalOpenRequest {
        AgentSessionTerminalOpenRequest(
            requestID: id,
            context: AgentSessionTerminalContext(
                projectPath: project.path,
                source: source,
                harnessSessionID: sessionID
            ),
            platform: platform
        )
    }

    func identity(source: String, sessionID: String) throws -> AgentResumeTerminalIdentity {
        try AgentResumeTerminalIdentity(
            source: source,
            harnessSessionID: sessionID,
            projectDirectoryPath: project.path,
            homeDirectory: home
        )
    }

    func removeTemporaryFiles() {
        try? FileManager.default.removeItem(at: sandbox)
    }
}

private actor EventRecorder {
    private(set) var values: [AgentSessionTerminalCoordinatorEvent] = []

    func append(_ event: AgentSessionTerminalCoordinatorEvent) {
        values.append(event)
    }
}

private struct DigestSidecarClient: SidecarClient, @unchecked Sendable {
    let projects: [EngineProjectDigest]

    func fetchDigest() async throws -> [EngineProjectDigest] {
        projects
    }

    func fetchEventsPage(sessionId: String, offset: Int, limit: Int) async throws -> EngineEventsPage {
        EngineEventsPage(events: [], total: 0)
    }

    func openEventStream(
        sessionId: String,
        after: Int,
        onEvent: @escaping @Sendable (EngineActivityEvent) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> SidecarStreamHandle {
        SidecarStreamHandle(task: Task {})
    }
}

private actor FakeAgentSessionTerminalLivenessChecker: AgentSessionTerminalLivenessChecking {
    private let isLiveValue: Bool
    private(set) var checkCount = 0

    init(isLive: Bool) {
        isLiveValue = isLive
    }

    func isLive(_ identity: AgentResumeTerminalIdentity) async throws -> Bool {
        checkCount += 1
        return isLiveValue
    }
}

private actor ManualHandoffTimeout {
    private var waiters: [UUID: CheckedContinuation<Void, Error>] = [:]

    var waiterCount: Int { waiters.count }

    func wait() async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                waiters[id] = continuation
            }
        } onCancel: {
            Task { await self.cancel(id: id) }
        }
    }

    func fireAll() {
        let continuations = Array(waiters.values)
        waiters.removeAll()
        for continuation in continuations {
            continuation.resume()
        }
    }

    private func cancel(id: UUID) {
        waiters.removeValue(forKey: id)?.resume(throwing: CancellationError())
    }
}

private actor FakeAgentSessionTerminalPtyClient: AgentSessionTerminalPtyClient {
    enum FailureMode: Sendable {
        case none
        case afterCreate
    }

    enum FakeError: Error {
        case launchFailed
        case missingSession
    }

    struct OpenCall: Equatable, Sendable {
        let name: String
        let launch: PtySessionLaunch
        let lifetime: PtySessionLifetime
        let createIfMissing: Bool
        let clientTitle: String
    }

    private struct Session: Sendable {
        let name: String
        let cwd: String
        let shell: String
        let pid: UInt32
        let lifetime: PtySessionLifetime
        var clients: [PtySessionClientSummary]

        var summary: PtySessionSummary {
            PtySessionSummary(
                name: name,
                cwd: cwd,
                shell: shell,
                pid: pid,
                state: .running,
                lifetime: lifetime,
                clients: clients
            )
        }
    }

    private var sessions: [String: Session] = [:]
    private var nextPID: UInt32 = 4000
    private var nextClientID: UInt64 = 1
    private var failureMode: FailureMode = .none
    private(set) var openCalls: [OpenCall] = []
    private(set) var createdSessionCount = 0
    private(set) var detachCount = 0
    private(set) var killCount = 0

    var sessionCount: Int { sessions.count }

    func setFailureMode(_ mode: FailureMode) {
        failureMode = mode
    }

    func listSessions() async throws -> [PtySessionSummary] {
        await Task.yield()
        return sessions.values.map(\.summary)
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
        await Task.yield()
        openCalls.append(OpenCall(
            name: name,
            launch: launch,
            lifetime: lifetime,
            createIfMissing: createIfMissing,
            clientTitle: clientTitle
        ))

        if sessions[name] == nil {
            guard createIfMissing else { throw FakeError.missingSession }
            let cwd: String
            let shell: String
            switch launch {
            case .shell(let launchCwd, let launchShell):
                cwd = launchCwd
                shell = launchShell
            case .command(let launchCwd, let executable, _):
                cwd = launchCwd
                shell = executable
            }
            sessions[name] = Session(
                name: name,
                cwd: cwd,
                shell: shell,
                pid: nextPID,
                lifetime: lifetime,
                clients: []
            )
            nextPID += 1
            createdSessionCount += 1
            if failureMode == .afterCreate {
                failureMode = .none
                throw FakeError.launchFailed
            }
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
            await self.detach(sessionName: name, clientID: clientID)
        }
    }

    func killSession(name: String) async throws {
        killCount += 1
        sessions.removeValue(forKey: name)
    }

    func seedSession(name: String, pid: UInt32, lifetime: PtySessionLifetime) {
        sessions[name] = Session(
            name: name,
            cwd: "/seed",
            shell: "/bin/zsh",
            pid: pid,
            lifetime: lifetime,
            clients: []
        )
    }

    func attachNative(to name: String, title: String) throws -> UInt32 {
        guard var session = sessions[name] else { throw FakeError.missingSession }
        let clientID = nextClientID
        nextClientID += 1
        session.clients.append(PtySessionClientSummary(id: clientID, title: title))
        sessions[name] = session
        return session.pid
    }

    func session(named name: String) -> PtySessionSummary? {
        sessions[name]?.summary
    }

    private func detach(sessionName: String, clientID: UInt64) {
        detachCount += 1
        guard var session = sessions[sessionName] else { return }
        session.clients.removeAll { $0.id == clientID }
        sessions[sessionName] = session
    }
}
