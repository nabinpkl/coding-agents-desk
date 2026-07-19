import Darwin
import Foundation
import PtyClientSwift

@testable import AgentDeskHost

struct AgentTerminalFixtureInvocation: Equatable {
    let executable: String
    let cwd: String
    let pid: UInt32
    let arguments: [String]
}

final class RealAgentTerminalIntegrationFixture: @unchecked Sendable {
    private static let leaseGraceSeconds = 1
    private static let claudeSessionID = "11111111-1111-4111-8111-111111111111"
    private static let codexSessionID = "22222222-2222-4222-8222-222222222222"

    let sandbox: URL
    let home: URL
    let project: URL

    private let socketURL: URL
    private let outputDirectory: URL
    private let managerBinaryURL: URL
    private let executables: AgentResumeLaunch.Executables
    private let client: PtyClient
    private let coordinator: AgentSessionTerminalCoordinator
    private let handoffEvents: AgentTerminalHandoffEventRecorder
    private let childLock = NSLock()
    private var knownChildPIDs: Set<UInt32> = []
    private var nextRequestNumber = 0
    private var managerProcess: Process?
    private var managerLogHandle: FileHandle?

    init(handoffTimeout: Duration = .seconds(5)) throws {
        sandbox = try Self.makeShortTemporaryDirectory()
        home = sandbox.appendingPathComponent("home", isDirectory: true)
        project = home.appendingPathComponent("project with spaces; literal", isDirectory: true)
        outputDirectory = sandbox.appendingPathComponent("invocations", isDirectory: true)
        socketURL = sandbox.appendingPathComponent("pty.sock", isDirectory: false)

        do {
            try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(
                at: outputDirectory,
                withIntermediateDirectories: true
            )

            let tools = sandbox.appendingPathComponent("fixture tools", isDirectory: true)
            try FileManager.default.createDirectory(at: tools, withIntermediateDirectories: true)
            let claude = tools.appendingPathComponent("claude fixture; literal", isDirectory: false)
            let codex = tools.appendingPathComponent("codex fixture [literal]", isDirectory: false)
            try Self.installCommandFixture(at: claude)
            try Self.installCommandFixture(at: codex)
            executables = AgentResumeLaunch.Executables(
                claude: claude.path,
                codex: codex.path
            )

            managerBinaryURL = try Self.resolveManagerBinary()
            let client = PtyClient(socketPath: socketURL.path)
            let handoffEvents = AgentTerminalHandoffEventRecorder()
            self.client = client
            self.handoffEvents = handoffEvents
            coordinator = AgentSessionTerminalCoordinator(
                ptyClient: PtyClientAgentSessionTerminalAdapter(client: client),
                livenessChecker: NeverLiveAgentSessionTerminalChecker(),
                homeDirectory: home,
                executables: executables,
                requestTombstoneLimit: 16,
                waitForHandoffTimeout: {
                    try await Task.sleep(for: handoffTimeout)
                },
                onEvent: { event in
                    handoffEvents.append(event)
                }
            )
        } catch {
            try? FileManager.default.removeItem(at: sandbox)
            throw error
        }
    }

    func startManager() async throws {
        precondition(managerProcess == nil)
        let logURL = sandbox.appendingPathComponent("pty-manager.log", isDirectory: false)
        _ = FileManager.default.createFile(atPath: logURL.path, contents: nil)
        let logHandle = try FileHandle(forWritingTo: logURL)
        managerLogHandle = logHandle

        let process = Process()
        process.executableURL = managerBinaryURL
        process.arguments = HostPtyManagerProcess.launchArguments(
            socketURL: socketURL,
            leasedSessionGraceSeconds: Self.leaseGraceSeconds
        )
        var environment = ProcessInfo.processInfo.environment
        environment["AGENTDESK_AGENT_TERMINAL_FIXTURE_OUTPUT_DIR"] = outputDirectory.path
        environment["RUST_LOG"] = "error"
        process.environment = environment
        process.standardOutput = logHandle
        process.standardError = logHandle

        do {
            try process.run()
            managerProcess = process
            try await waitUntil("real pty-manager socket did not become ready") {
                guard process.isRunning else { return false }
                return (try? await self.client.listSessions()) != nil
            }
        } catch {
            stopManagerSynchronously()
            throw error
        }
    }

    func open(source: String) async throws -> AgentSessionTerminalReady {
        nextRequestNumber += 1
        let request = AgentSessionTerminalOpenRequest(
            requestID: "r71-\(source)-\(nextRequestNumber)",
            context: AgentSessionTerminalContext(
                projectPath: project.path,
                source: source,
                harnessSessionID: sessionID(for: source)
            ),
            platform: .macOS
        )
        let ready = try await coordinator.open(request)
        _ = childLock.withLock { knownChildPIDs.insert(ready.pid) }
        return ready
    }

    func attach(
        to ready: AgentSessionTerminalReady,
        title: String
    ) async throws -> PtySessionConnection {
        let launch = try AgentResumeLaunch(identity: ready.identity, executables: executables)
        return try await client.openSession(
            name: ready.ptySessionName,
            launch: launch.ptyLaunch,
            lifetime: .leased,
            columns: 80,
            rows: 24,
            createIfMissing: false,
            clientTitle: title
        )
    }

    func acknowledge(_ ready: AgentSessionTerminalReady) async {
        await coordinator.acknowledgeAttachment(
            requestID: ready.requestID,
            ptySessionName: ready.ptySessionName
        )
    }

    func close(_ ready: AgentSessionTerminalReady) async {
        await coordinator.close(
            requestID: ready.requestID,
            ptySessionName: ready.ptySessionName
        )
    }

    func waitForClientCount(_ count: UInt32, sessionName: String) async throws {
        try await waitUntil("session \(sessionName) did not reach \(count) clients") {
            try await self.session(named: sessionName)?.clientCount == count
        }
    }

    func waitBeyondGrace() async throws {
        try await Task.sleep(for: .milliseconds((Self.leaseGraceSeconds * 1_000) + 250))
    }

    func waitInsideGrace() async throws {
        try await Task.sleep(for: .milliseconds(250))
    }

    func expectRunning(sessionName: String, pid: UInt32) async throws {
        guard let session = try await session(named: sessionName) else {
            throw IntegrationFixtureError("session \(sessionName) was reaped while leased")
        }
        guard session.pid == pid, session.state == .running, session.lifetime == .leased else {
            throw IntegrationFixtureError("session \(sessionName) changed identity or lifetime")
        }
        guard processExists(pid) else {
            throw IntegrationFixtureError("leased child \(pid) is not running")
        }
    }

    func waitForSessionRemoval(_ sessionName: String) async throws {
        try await waitUntil("session \(sessionName) remained after cleanup") {
            try await self.session(named: sessionName) == nil
        }
    }

    func waitForProcessExit(_ pid: UInt32) async throws {
        try await waitUntil("leased child \(pid) survived cleanup") {
            !self.processExists(pid)
        }
        _ = childLock.withLock { knownChildPIDs.remove(pid) }
    }

    func waitForInvocation(
        _ ready: AgentSessionTerminalReady
    ) async throws -> AgentTerminalFixtureInvocation {
        let url = invocationURL(sessionName: ready.ptySessionName)
        var invocation: AgentTerminalFixtureInvocation?
        try await waitUntil("fixture invocation was not recorded for \(ready.ptySessionName)") {
            invocation = try? Self.readInvocation(at: url)
            return invocation != nil
        }
        guard let invocation else {
            throw IntegrationFixtureError("fixture invocation disappeared")
        }
        return invocation
    }

    func waitForHandoffTimeout(_ ready: AgentSessionTerminalReady) async throws {
        let expected = AgentSessionTerminalCoordinatorEvent.handoffTimedOut(
            requestID: ready.requestID,
            ready: ready
        )
        try await waitUntil("coordinator handoff timeout was not observed") {
            self.handoffEvents.contains(expected)
        }
    }

    func executablePath(for source: String) -> String {
        switch source {
        case "claude": executables.claude
        case "codex": executables.codex
        default: preconditionFailure("unsupported fixture source \(source)")
        }
    }

    func expectedArguments(
        for source: String,
        ready: AgentSessionTerminalReady
    ) -> [String] {
        switch source {
        case "claude": ["--resume", ready.identity.harnessSessionID]
        case "codex": ["resume", ready.identity.harnessSessionID]
        default: preconditionFailure("unsupported fixture source \(source)")
        }
    }

    func processExists(_ pid: UInt32) -> Bool {
        Darwin.kill(pid_t(pid), 0) == 0 || errno != ESRCH
    }

    func stopManagerGracefully() async throws {
        guard let process = managerProcess else { return }
        if process.isRunning {
            guard Darwin.kill(process.processIdentifier, SIGINT) == 0 else {
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
            try await waitUntil("pty-manager did not stop after SIGINT") {
                !process.isRunning
            }
        }
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw IntegrationFixtureError(
                "pty-manager exited with status \(process.terminationStatus): \(managerLog())"
            )
        }
        managerProcess = nil
        try? managerLogHandle?.close()
        managerLogHandle = nil
    }

    func cleanup() {
        stopManagerSynchronously()
        let childPIDs = childLock.withLock { Array(knownChildPIDs) }
        for pid in childPIDs where processExists(pid) {
            _ = Darwin.kill(pid_t(pid), SIGKILL)
        }
        for pid in childPIDs {
            for _ in 0..<100 where processExists(pid) {
                Thread.sleep(forTimeInterval: 0.01)
            }
        }
        try? managerLogHandle?.close()
        managerLogHandle = nil
        try? FileManager.default.removeItem(at: sandbox)
    }

    private func session(named name: String) async throws -> PtySessionSummary? {
        try await client.listSessions().first { $0.name == name }
    }

    private func sessionID(for source: String) -> String {
        switch source {
        case "claude": Self.claudeSessionID
        case "codex": Self.codexSessionID
        default: preconditionFailure("unsupported fixture source \(source)")
        }
    }

    private func invocationURL(sessionName: String) -> URL {
        outputDirectory.appendingPathComponent("\(sessionName).invocation", isDirectory: false)
    }

    private func waitUntil(
        _ failure: String,
        condition: @escaping () async throws -> Bool
    ) async throws {
        for _ in 0..<500 {
            if try await condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        throw IntegrationFixtureError("\(failure): \(managerLog())")
    }

    private func stopManagerSynchronously() {
        guard let process = managerProcess else { return }
        if process.isRunning {
            _ = Darwin.kill(process.processIdentifier, SIGINT)
            for _ in 0..<200 where process.isRunning {
                Thread.sleep(forTimeInterval: 0.01)
            }
            if process.isRunning {
                _ = Darwin.kill(process.processIdentifier, SIGKILL)
            }
        }
        process.waitUntilExit()
        managerProcess = nil
    }

    private func managerLog() -> String {
        let url = sandbox.appendingPathComponent("pty-manager.log", isDirectory: false)
        return (try? String(contentsOf: url, encoding: .utf8)) ?? "no manager log"
    }

    private static func resolveManagerBinary() throws -> URL {
        let repository = URL(fileURLWithPath: #filePath, isDirectory: false)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let url = repository
            .appendingPathComponent("terminal/pty-manager/target/debug", isDirectory: true)
            .appendingPathComponent("pty-manager", isDirectory: false)
        guard FileManager.default.isExecutableFile(atPath: url.path) else {
            throw IntegrationFixtureError(
                "pty-manager test binary is not executable at \(url.path); "
                    + "run just agent-terminal-integration-test"
            )
        }
        return url
    }

    private static func installCommandFixture(at destination: URL) throws {
        let source = URL(fileURLWithPath: #filePath, isDirectory: false)
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures", isDirectory: true)
            .appendingPathComponent("agent-resume-argv-fixture.sh", isDirectory: false)
        try FileManager.default.copyItem(at: source, to: destination)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o755],
            ofItemAtPath: destination.path
        )
    }

    private static func makeShortTemporaryDirectory() throws -> URL {
        var template = Array("/tmp/agd-r71.XXXXXX".utf8CString)
        guard mkdtemp(&template) != nil else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        let path = String(
            decoding: template.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) },
            as: UTF8.self
        )
        return URL(fileURLWithPath: path, isDirectory: true)
    }

    private static func readInvocation(at url: URL) throws -> AgentTerminalFixtureInvocation {
        let fields = try Data(contentsOf: url)
            .split(separator: 0, omittingEmptySubsequences: false)
            .dropLast()
            .map { String(decoding: $0, as: UTF8.self) }
        guard fields.count >= 4,
              let pid = UInt32(fields[2]),
              let argumentCount = Int(fields[3]),
              fields.count == 4 + argumentCount else {
            throw IntegrationFixtureError("invalid fixture invocation at \(url.path)")
        }
        return AgentTerminalFixtureInvocation(
            executable: fields[0],
            cwd: fields[1],
            pid: pid,
            arguments: Array(fields.dropFirst(4))
        )
    }
}

private struct NeverLiveAgentSessionTerminalChecker: AgentSessionTerminalLivenessChecking {
    func isLive(_ identity: AgentResumeTerminalIdentity) async throws -> Bool {
        false
    }
}

private final class AgentTerminalHandoffEventRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var events: [AgentSessionTerminalCoordinatorEvent] = []

    func append(_ event: AgentSessionTerminalCoordinatorEvent) {
        lock.withLock { events.append(event) }
    }

    func contains(_ event: AgentSessionTerminalCoordinatorEvent) -> Bool {
        lock.withLock { events.contains(event) }
    }
}

private struct IntegrationFixtureError: Error, CustomStringConvertible {
    let description: String

    init(_ description: String) {
        self.description = description
    }
}
