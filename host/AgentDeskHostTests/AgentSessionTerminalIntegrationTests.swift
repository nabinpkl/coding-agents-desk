import Foundation
import Testing

@testable import AgentDeskHost

struct AgentSessionTerminalIntegrationTests {
    @Test func unacknowledgedCoordinatorHandoffKillsBeforeManagerLeaseGrace() async throws {
        let fixture = try RealAgentTerminalIntegrationFixture(
            handoffTimeout: .milliseconds(200)
        )
        defer { fixture.cleanup() }
        try await fixture.startManager()

        let ready = try await fixture.open(source: "claude")
        #expect(fixture.processExists(ready.pid))
        let managerGraceDeadline = ContinuousClock.now.advanced(by: .seconds(1))

        try await fixture.waitForHandoffTimeout(ready)
        try await fixture.waitForSessionRemoval(ready.ptySessionName)
        try await fixture.waitForProcessExit(ready.pid)

        #expect(ContinuousClock.now < managerGraceDeadline)
        #expect(!fixture.processExists(ready.pid))
    }

    @Test func realCoordinatorPreservesSharedAndReconnectedPIDThenReapsFinalLease() async throws {
        let fixture = try RealAgentTerminalIntegrationFixture()
        defer { fixture.cleanup() }
        try await fixture.startManager()

        let ready = try await fixture.open(source: "claude")
        let first = try await fixture.attach(to: ready, title: "r71-first")
        let second = try await fixture.attach(to: ready, title: "r71-second")
        await fixture.acknowledge(ready)
        try await fixture.waitForClientCount(2, sessionName: ready.ptySessionName)

        try await first.detach()
        try await fixture.waitForClientCount(1, sessionName: ready.ptySessionName)
        try await fixture.waitBeyondGrace()
        try await fixture.expectRunning(sessionName: ready.ptySessionName, pid: ready.pid)

        try await second.detach()
        try await fixture.waitForClientCount(0, sessionName: ready.ptySessionName)
        try await fixture.waitInsideGrace()
        let reconnected = try await fixture.attach(to: ready, title: "r71-reconnected")
        #expect(reconnected.attachment.pid == ready.pid)
        try await fixture.waitBeyondGrace()
        try await fixture.expectRunning(sessionName: ready.ptySessionName, pid: ready.pid)

        try await reconnected.detach()
        try await fixture.waitForSessionRemoval(ready.ptySessionName)
        try await fixture.waitForProcessExit(ready.pid)
        #expect(!fixture.processExists(ready.pid))
    }

    @Test func realCoordinatorExecutesClaudeAndCodexFixturesWithExactArgv() async throws {
        let fixture = try RealAgentTerminalIntegrationFixture()
        defer { fixture.cleanup() }
        try await fixture.startManager()

        for source in ["claude", "codex"] {
            let ready = try await fixture.open(source: source)
            let connection = try await fixture.attach(to: ready, title: "r71-\(source)")
            await fixture.acknowledge(ready)

            let invocation = try await fixture.waitForInvocation(ready)
            #expect(invocation.executable == fixture.executablePath(for: source))
            let invokedDirectory = URL(fileURLWithPath: invocation.cwd, isDirectory: true)
                .resolvingSymlinksInPath()
                .standardizedFileURL
            let expectedDirectory = ready.identity.projectDirectory
                .resolvingSymlinksInPath()
                .standardizedFileURL
            #expect(invokedDirectory.path == expectedDirectory.path)
            #expect(invocation.pid == ready.pid)
            #expect(invocation.arguments == fixture.expectedArguments(for: source, ready: ready))

            try await connection.detach()
            await fixture.close(ready)
            try await fixture.waitForSessionRemoval(ready.ptySessionName)
            try await fixture.waitForProcessExit(ready.pid)
        }
    }

    @Test func realManagerRestartRecoversCoordinatorOwnedLeasedChild() async throws {
        let fixture = try RealAgentTerminalIntegrationFixture()
        defer { fixture.cleanup() }
        try await fixture.startManager()

        let ready = try await fixture.open(source: "codex")
        let connection = try await fixture.attach(to: ready, title: "r71-shutdown")
        await fixture.acknowledge(ready)
        try await fixture.expectRunning(sessionName: ready.ptySessionName, pid: ready.pid)
        #expect(fixture.processExists(ready.pid))

        try await fixture.stopManagerGracefully()
        #expect(fixture.processExists(ready.pid))

        try await fixture.startManager()
        try await fixture.expectRunning(sessionName: ready.ptySessionName, pid: ready.pid)
        let recovered = try await fixture.attach(to: ready, title: "r71-recovered")
        #expect(recovered.attachment.pid == ready.pid)

        try await recovered.detach()
        await fixture.close(ready)
        try await fixture.waitForSessionRemoval(ready.ptySessionName)
        try await fixture.waitForProcessExit(ready.pid)
        _ = connection
    }
}
