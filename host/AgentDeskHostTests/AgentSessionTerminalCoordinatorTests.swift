import Foundation
import PtyClientSwift
import Testing
import AgentDeskWire

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
        let liveSession = AgentFeedSessionSummary(
            sessionId: claudeSessionID.uppercased(),
            source: "claude",
            title: "Live thread",
            lastEventAt: 1,
            activity: "live",
            capabilities: AgentFeedSessionCapabilities(modes: ["raw", "nice"], canSend: false, canSteer: false, canAbort: false, canFetchRaw: true, canOpenTerminal: true, supportsExtensionUi: false)
        )
        let client = SessionsSidecarClient(snapshot: AgentFeedSessionsSnapshot(
            projectPath: fixture.project.path,
            sessions: [liveSession]
        ))
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

    @Test func requestTransferMovesKillAuthorityWithoutReplacingThePTY() async throws {
        let fixture = try Fixture()
        defer { fixture.removeTemporaryFiles() }
        let oldRequest = fixture.request(
            id: "transfer-old",
            source: "claude",
            sessionID: claudeSessionID,
            platform: .macOS
        )
        let oldReady = try await fixture.coordinator.open(oldRequest)
        _ = try await fixture.pty.attachNative(to: oldReady.ptySessionName, title: "native")
        await fixture.coordinator.acknowledgeAttachment(
            requestID: oldRequest.requestID,
            ptySessionName: oldReady.ptySessionName
        )
        let newRequestID = "transfer-new"

        let transferred = await fixture.coordinator.transferRequest(
            from: oldRequest.requestID,
            to: newRequestID,
            ptySessionName: oldReady.ptySessionName
        )

        #expect(transferred)
        #expect(await fixture.pty.killCount == 0)
        await #expect(throws: AgentSessionTerminalCoordinatorError.sessionEnded) {
            try await fixture.coordinator.open(oldRequest)
        }

        let newRequest = fixture.request(
            id: newRequestID,
            source: "claude",
            sessionID: claudeSessionID,
            platform: .macOS
        )
        let transferredReady = try await fixture.coordinator.open(newRequest)
        #expect(transferredReady.requestID == newRequestID)
        #expect(transferredReady.pid == oldReady.pid)
        #expect(await fixture.pty.openCalls.count == 1)

        await fixture.coordinator.close(
            requestID: oldRequest.requestID,
            ptySessionName: oldReady.ptySessionName
        )
        #expect(await fixture.pty.killCount == 0)
        await fixture.coordinator.close(
            requestID: newRequestID,
            ptySessionName: oldReady.ptySessionName
        )
        await fixture.coordinator.close(
            requestID: newRequestID,
            ptySessionName: oldReady.ptySessionName
        )

        #expect(await fixture.pty.killCount == 1)
        #expect(await fixture.pty.sessionCount == 0)
    }

    @Test func requestTransferPreservesOriginalUnacknowledgedHandoffTimeout() async throws {
        let events = EventRecorder()
        let fixture = try Fixture(onEvent: { event in
            Task { await events.append(event) }
        })
        defer { fixture.removeTemporaryFiles() }
        let oldRequest = fixture.request(
            id: "timeout-transfer-old",
            source: "claude",
            sessionID: claudeSessionID,
            platform: .macOS
        )
        let oldReady = try await fixture.coordinator.open(oldRequest)
        try await waitUntil { await fixture.timeout.startedWaitCount == 1 }
        let newRequestID = "timeout-transfer-new"

        #expect(await fixture.coordinator.transferRequest(
            from: oldRequest.requestID,
            to: newRequestID,
            ptySessionName: oldReady.ptySessionName
        ))
        try await Task.sleep(for: .milliseconds(20))
        #expect(await fixture.timeout.startedWaitCount == 1)
        #expect(await fixture.timeout.waiterCount == 1)
        #expect(await fixture.pty.detachCount == 0)

        await fixture.timeout.fireAll()
        try await waitUntil { await fixture.pty.killCount == 1 }
        try await waitUntil { await events.values.count == 1 }

        let newReady = AgentSessionTerminalReady(
            requestID: newRequestID,
            identity: oldReady.identity,
            pid: oldReady.pid
        )
        #expect(await fixture.pty.detachCount == 1)
        #expect(await events.values == [
            .handoffTimedOut(requestID: newRequestID, ready: newReady),
        ])
        #expect(await fixture.timeout.startedWaitCount == 1)
        #expect(await fixture.timeout.waiterCount == 0)
        await #expect(throws: AgentSessionTerminalCoordinatorError.sessionEnded) {
            try await fixture.coordinator.open(oldRequest)
        }
        await #expect(throws: AgentSessionTerminalCoordinatorError.sessionEnded) {
            try await fixture.coordinator.open(fixture.request(
                id: newRequestID,
                source: "claude",
                sessionID: claudeSessionID,
                platform: .macOS
            ))
        }
    }

    @Test func repeatedRequestTransferCannotExtendOriginalHandoffTimeout() async throws {
        let events = EventRecorder()
        let fixture = try Fixture(onEvent: { event in
            Task { await events.append(event) }
        })
        defer { fixture.removeTemporaryFiles() }
        let oldRequest = fixture.request(
            id: "timeout-chain-old",
            source: "codex",
            sessionID: codexSessionID,
            platform: .macOS
        )
        let oldReady = try await fixture.coordinator.open(oldRequest)
        try await waitUntil { await fixture.timeout.startedWaitCount == 1 }
        let midRequestID = "timeout-chain-mid"
        let newRequestID = "timeout-chain-new"

        #expect(await fixture.coordinator.transferRequest(
            from: oldRequest.requestID,
            to: midRequestID,
            ptySessionName: oldReady.ptySessionName
        ))
        #expect(await fixture.coordinator.transferRequest(
            from: midRequestID,
            to: newRequestID,
            ptySessionName: oldReady.ptySessionName
        ))
        try await Task.sleep(for: .milliseconds(20))
        #expect(await fixture.timeout.startedWaitCount == 1)
        #expect(await fixture.timeout.waiterCount == 1)

        await fixture.timeout.fireAll()
        try await waitUntil { await fixture.pty.killCount == 1 }
        try await waitUntil { await events.values.count == 1 }

        let newReady = AgentSessionTerminalReady(
            requestID: newRequestID,
            identity: oldReady.identity,
            pid: oldReady.pid
        )
        #expect(await fixture.pty.detachCount == 1)
        #expect(await events.values == [
            .handoffTimedOut(requestID: newRequestID, ready: newReady),
        ])
        await fixture.timeout.fireAll()
        await Task.yield()
        #expect(await fixture.pty.detachCount == 1)
        #expect(await fixture.pty.killCount == 1)
        #expect(await events.values.count == 1)
        #expect(await fixture.timeout.startedWaitCount == 1)

        for requestID in [oldRequest.requestID, midRequestID, newRequestID] {
            await #expect(throws: AgentSessionTerminalCoordinatorError.sessionEnded) {
                try await fixture.coordinator.open(fixture.request(
                    id: requestID,
                    source: "codex",
                    sessionID: codexSessionID,
                    platform: .macOS
                ))
            }
        }
    }

    @Test func newRequestAcknowledgementRacingOriginalTimeoutHasOneOutcome() async throws {
        let events = EventRecorder()
        let fixture = try Fixture(onEvent: { event in
            Task { await events.append(event) }
        })
        defer { fixture.removeTemporaryFiles() }
        let oldRequest = fixture.request(
            id: "timeout-race-old",
            source: "claude",
            sessionID: claudeSessionID,
            platform: .macOS
        )
        let oldReady = try await fixture.coordinator.open(oldRequest)
        try await waitUntil { await fixture.timeout.startedWaitCount == 1 }
        let midRequestID = "timeout-race-mid"
        let newRequestID = "timeout-race-new"
        #expect(await fixture.coordinator.transferRequest(
            from: oldRequest.requestID,
            to: midRequestID,
            ptySessionName: oldReady.ptySessionName
        ))
        #expect(await fixture.coordinator.transferRequest(
            from: midRequestID,
            to: newRequestID,
            ptySessionName: oldReady.ptySessionName
        ))

        async let acknowledgement: Void = fixture.coordinator.acknowledgeAttachment(
            requestID: newRequestID,
            ptySessionName: oldReady.ptySessionName
        )
        async let timeout: Void = fixture.timeout.fireAll()
        _ = await (acknowledgement, timeout)
        try await waitUntil { await fixture.pty.detachCount == 1 }
        try await Task.sleep(for: .milliseconds(20))

        let killCount = await fixture.pty.killCount
        let recordedEvents = await events.values
        #expect(await fixture.timeout.startedWaitCount == 1)
        #expect(await fixture.timeout.waiterCount == 0)
        #expect(await fixture.pty.detachCount == 1)
        #expect(killCount == recordedEvents.count)
        #expect(killCount <= 1)
        if killCount == 1 {
            let newReady = AgentSessionTerminalReady(
                requestID: newRequestID,
                identity: oldReady.identity,
                pid: oldReady.pid
            )
            #expect(recordedEvents == [
                .handoffTimedOut(requestID: newRequestID, ready: newReady),
            ])
        } else {
            let newRequest = fixture.request(
                id: newRequestID,
                source: "claude",
                sessionID: claudeSessionID,
                platform: .macOS
            )
            #expect(try await fixture.coordinator.open(newRequest).requestID == newRequestID)
            await fixture.coordinator.close(
                requestID: newRequestID,
                ptySessionName: oldReady.ptySessionName
            )
        }

        for requestID in [oldRequest.requestID, midRequestID] {
            await #expect(throws: AgentSessionTerminalCoordinatorError.sessionEnded) {
                try await fixture.coordinator.open(fixture.request(
                    id: requestID,
                    source: "claude",
                    sessionID: claudeSessionID,
                    platform: .macOS
                ))
            }
        }
        #expect(await fixture.pty.detachCount == 1)
        #expect(await events.values.count <= 1)
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

    @MainActor
    @Test func replacementEndpointWaitsForPriorShutdownBeforeOpeningSamePTY() async throws {
        let fixture = try Fixture()
        defer { fixture.removeTemporaryFiles() }
        let blockingCoordinator = BlockingFirstCloseTerminalCoordinator(
            coordinator: fixture.coordinator
        )
        let registry = AgentSessionTerminalEndpointRegistry<String> { _, epoch in
            AgentSessionTerminalEndpoint(
                coordinator: blockingCoordinator,
                platform: .iOS,
                requestNamespace: "ios-device-\(epoch)",
                tombstoneLimit: 8
            )
        }
        let context = AgentResumeTerminalContext(
            projectPath: fixture.project.path,
            source: "claude",
            harnessSessionID: claudeSessionID
        )
        let sessions = SessionRegistry()
        let fingerprint = DeviceFingerprint("device")
        let oldSession = ActiveSession(
            sessionId: "session-old",
            deviceFingerprint: fingerprint,
            establishedAt: 1
        )
        _ = sessions.noteReady(oldSession, ready: sessionReady(id: oldSession.sessionId))

        let oldBinding = registry.beginBinding(for: "device")
        let oldEndpoint = try #require(await registry.endpoint(
            for: "device",
            binding: oldBinding
        ))
        let oldResponse = await oldEndpoint.openLocal(AgentTerminalOpen(
            requestID: "old",
            context: context
        ))
        guard case .ready(let oldReady) = oldResponse else {
            Issue.record("Expected the original endpoint to become ready")
            return
        }
        let oldPID = try #require(
            await fixture.pty.session(named: oldReady.ptySessionName)?.pid
        )

        let replacementSession = ActiveSession(
            sessionId: "session-replacement",
            deviceFingerprint: fingerprint,
            establishedAt: 2
        )
        let transition = sessions.noteReady(
            replacementSession,
            ready: sessionReady(id: replacementSession.sessionId)
        )
        if case .replaced = transition {
            registry.endBinding(for: "device")
        }
        #expect(transition == .replaced(previousSessionID: oldSession.sessionId))
        try await waitUntil { await blockingCoordinator.closeIsBlocked }

        let replacementBinding = registry.beginBinding(for: "device")
        let replacementTask = Task { @MainActor in
            guard let endpoint = await registry.endpoint(
                for: "device",
                binding: replacementBinding
            ) else {
                return Optional<(AgentSessionTerminalEndpoint, AgentTerminalHostMessage)>.none
            }
            let response = await endpoint.openLocal(AgentTerminalOpen(
                requestID: "replacement",
                context: context
            ))
            guard let response else { return nil }
            return (endpoint, response)
        }
        await Task.yield()
        #expect(await fixture.pty.openCalls.count == 1)

        await blockingCoordinator.releaseClose()
        let (replacementEndpoint, replacementResponse) = try #require(
            await replacementTask.value
        )
        guard case .ready(let replacementReady) = replacementResponse else {
            Issue.record("Expected the replacement endpoint to become ready")
            return
        }
        let replacementPID = try #require(
            await fixture.pty.session(named: replacementReady.ptySessionName)?.pid
        )

        #expect(replacementReady.ptySessionName == oldReady.ptySessionName)
        #expect(replacementPID != oldPID)
        #expect(await fixture.pty.killCount == 1)
        #expect(await fixture.pty.session(named: replacementReady.ptySessionName)?.pid == replacementPID)

        await replacementEndpoint.handle(.close(AgentTerminalClose(
            requestID: "replacement",
            context: context,
            ptySessionName: replacementReady.ptySessionName,
            reason: "current-explicit-close"
        )))

        #expect(await fixture.pty.killCount == 2)
        #expect(await fixture.pty.session(named: replacementReady.ptySessionName) == nil)
    }

    @MainActor
    @Test func sameSessionReadyKeepsEndpointAndPTYOwnership() async throws {
        let fixture = try Fixture()
        defer { fixture.removeTemporaryFiles() }
        let registry = AgentSessionTerminalEndpointRegistry<String> { _, epoch in
            AgentSessionTerminalEndpoint(
                coordinator: fixture.coordinator,
                platform: .iOS,
                requestNamespace: "ios-device-\(epoch)",
                tombstoneLimit: 8
            )
        }
        let sessions = SessionRegistry()
        let fingerprint = DeviceFingerprint("device")
        let session = ActiveSession(
            sessionId: "session-current",
            deviceFingerprint: fingerprint,
            establishedAt: 1
        )
        _ = sessions.noteReady(session, ready: sessionReady(id: session.sessionId))
        let binding = registry.beginBinding(for: "device")
        let endpoint = try #require(await registry.endpoint(for: "device", binding: binding))
        let context = AgentResumeTerminalContext(
            projectPath: fixture.project.path,
            source: "claude",
            harnessSessionID: claudeSessionID
        )
        guard case .ready(let firstReady) = await endpoint.openLocal(AgentTerminalOpen(
            requestID: "first",
            context: context
        )) else {
            Issue.record("Expected initial endpoint readiness")
            return
        }
        let firstPID = try #require(
            await fixture.pty.session(named: firstReady.ptySessionName)?.pid
        )

        let transition = sessions.noteReady(session, ready: sessionReady(id: session.sessionId))
        if case .replaced = transition {
            registry.endBinding(for: "device")
        }
        let resumedBinding = registry.beginBinding(for: "device")
        let resumedEndpoint = try #require(await registry.endpoint(
            for: "device",
            binding: resumedBinding
        ))
        guard case .ready(let resumedReady) = await resumedEndpoint.openLocal(AgentTerminalOpen(
            requestID: "resumed",
            context: context
        )) else {
            Issue.record("Expected same-session endpoint readiness")
            return
        }

        #expect(transition == .sameSession)
        #expect(resumedEndpoint === endpoint)
        #expect(await fixture.pty.session(named: resumedReady.ptySessionName)?.pid == firstPID)
        #expect(await fixture.pty.killCount == 0)
        #expect(await fixture.pty.createdSessionCount == 1)
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

    @Test func cancelledRequestTombstonesAreBoundedAndEvictOldestID() async throws {
        let fixture = try Fixture(requestTombstoneLimit: 2)
        defer { fixture.removeTemporaryFiles() }

        for requestID in ["request-1", "request-2", "request-3"] {
            let request = fixture.request(
                id: requestID,
                source: "claude",
                sessionID: claudeSessionID,
                platform: .iOS
            )
            let ready = try await fixture.coordinator.open(request)
            await fixture.coordinator.close(
                requestID: request.requestID,
                ptySessionName: ready.ptySessionName
            )
        }

        let evicted = fixture.request(
            id: "request-1",
            source: "claude",
            sessionID: claudeSessionID,
            platform: .iOS
        )
        #expect(try await fixture.coordinator.open(evicted).requestID == evicted.requestID)
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

    private func sessionReady(id: String) -> SessionReady {
        SessionReady(
            sessionId: id,
            resumeId: Data(repeating: 1, count: 32),
            resumeSecret: Data(repeating: 2, count: 32),
            resumeExpiresAt: 2_000_000_000,
            mediaKeySalt: Data(repeating: 3, count: 32),
            hostSignature: Data(repeating: 4, count: 64)
        )
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
        requestTombstoneLimit: Int = 8,
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
            requestTombstoneLimit: requestTombstoneLimit,
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

private actor BlockingFirstCloseTerminalCoordinator: AgentSessionTerminalCoordinating {
    private let coordinator: AgentSessionTerminalCoordinator
    private var closeContinuation: CheckedContinuation<Void, Never>?
    private var hasBlockedClose = false

    init(coordinator: AgentSessionTerminalCoordinator) {
        self.coordinator = coordinator
    }

    var closeIsBlocked: Bool {
        closeContinuation != nil
    }

    func open(_ request: AgentSessionTerminalOpenRequest) async throws -> AgentSessionTerminalReady {
        try await coordinator.open(request)
    }

    func acknowledgeAttachment(requestID: String, ptySessionName: String) async {
        await coordinator.acknowledgeAttachment(
            requestID: requestID,
            ptySessionName: ptySessionName
        )
    }

    func transferRequest(
        from oldRequestID: String,
        to newRequestID: String,
        ptySessionName: String
    ) async -> Bool {
        await coordinator.transferRequest(
            from: oldRequestID,
            to: newRequestID,
            ptySessionName: ptySessionName
        )
    }

    func close(requestID: String, ptySessionName: String?) async {
        if !hasBlockedClose {
            hasBlockedClose = true
            await withCheckedContinuation { continuation in
                closeContinuation = continuation
            }
        }
        await coordinator.close(requestID: requestID, ptySessionName: ptySessionName)
    }

    func releaseClose() {
        closeContinuation?.resume()
        closeContinuation = nil
    }
}

private struct SessionsSidecarClient: SidecarClient, @unchecked Sendable {
    let snapshot: AgentFeedSessionsSnapshot

    func fetchProjects() async throws -> AgentFeedProjectsSnapshot {
        AgentFeedProjectsSnapshot(projects: [])
    }

    func fetchSessions(projectPath: String) async throws -> AgentFeedSessionsSnapshot {
        snapshot
    }

    func fetchEventsPage(
        source: String,
        sessionId: String,
        offset: Int,
        limit: Int,
        mode: AgentFeedEventMode
    ) async throws -> AgentFeedEventsPage {
        AgentFeedEventsPage(events: [], total: 0)
    }

    func fetchRawEvent(
        source: String,
        sessionId: String,
        eventIndex: Int,
        mode: AgentFeedEventMode
    ) async throws -> String {
        ""
    }

    func openProjectsStream(
        onSnapshot: @escaping @Sendable (AgentFeedProjectsSnapshot) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> SidecarStreamHandle {
        SidecarStreamHandle(task: Task {})
    }

    func openSessionsStream(
        projectPath: String,
        onSnapshot: @escaping @Sendable (AgentFeedSessionsSnapshot) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> SidecarStreamHandle {
        SidecarStreamHandle(task: Task {})
    }

    func openEventStream(
        source: String,
        sessionId: String,
        afterSequence: Int,
        mode: AgentFeedEventMode,
        onEnvelope: @escaping @Sendable (AgentFeedTimelineEnvelope) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> SidecarStreamHandle {
        SidecarStreamHandle(task: Task {})
    }

    func openClaudeLiveStream(
        source: String,
        sessionId: String,
        afterSequence: Int,
        mode: AgentFeedEventMode,
        onEnvelope: @escaping @Sendable (AgentFeedTimelineEnvelope) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> SidecarStreamHandle {
        SidecarStreamHandle(task: Task {})
    }

    func fetchClaudeLiveEventsPage(source: String, sessionId: String, offset: Int, limit: Int, mode: AgentFeedEventMode) async throws -> AgentFeedEventsPage {
        AgentFeedEventsPage(events: [], total: 0)
    }

    func createSession(requestId: String, source: String, projectPath: String) async throws -> AgentFeedSessionSummary { throw SidecarClientError.server("unsupported") }
    func sendMessage(requestId: String, source: String, sessionId: String, text: String, delivery: String) async throws -> AgentFeedCommandReceipt { throw SidecarClientError.server("unsupported") }
    func abortSession(requestId: String, source: String, sessionId: String) async throws -> AgentFeedCommandReceipt { throw SidecarClientError.server("unsupported") }
    func openExtensionUIStream(source: String, sessionId: String, onEvent: @escaping @Sendable (AgentFeedExtensionUIEvent) -> Void, onError: @escaping @Sendable (Error) -> Void) -> SidecarStreamHandle { SidecarStreamHandle(task: Task {}) }
    func respondToExtensionUI(source: String, sessionId: String, requestId: String, value: AgentJSONValue) async throws -> AgentFeedCommandReceipt { throw SidecarClientError.server("unsupported") }
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
    private(set) var startedWaitCount = 0

    var waiterCount: Int { waiters.count }

    func wait() async throws {
        startedWaitCount += 1
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
        let createIfMissing: Bool
        let clientTitle: String
    }

    private struct Session: Sendable {
        let name: String
        let cwd: String
        let shell: String
        let pid: UInt32
        var clients: [PtySessionClientSummary]

        var summary: PtySessionSummary {
            PtySessionSummary(
                name: name,
                cwd: cwd,
                shell: shell,
                pid: pid,
                state: .running,
                startedAtUnixMilliseconds: 1_721_344_000_123,
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
        columns: UInt32,
        rows: UInt32,
        createIfMissing: Bool,
        clientTitle: String
    ) async throws -> AgentSessionTerminalPtyLease {
        await Task.yield()
        openCalls.append(OpenCall(
            name: name,
            launch: launch,
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

    func seedSession(name: String, pid: UInt32) {
        sessions[name] = Session(
            name: name,
            cwd: "/seed",
            shell: "/bin/zsh",
            pid: pid,
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
