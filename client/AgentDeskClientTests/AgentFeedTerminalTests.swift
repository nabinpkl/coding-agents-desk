import AgentDeskWire
import AgentPanel
import Foundation
import PtyClientSwift
import PtyTerminalSession
import Testing
import UIKit

@testable import AgentDeskClient

@MainActor
struct AgentFeedTerminalTests {
    private let panelContext = AgentPanelTerminalContext(
        projectPath: "/Users/dev/projects/alpha",
        source: .claude,
        sessionID: "a4cdd7b8-3f9a-4d80-bc72-5f4aab6f39e1"
    )

    @Test func routesExactOpenContextAndUsesDedicatedAttachOnlyTerminalClient() async throws {
        let harness = makeHarness()
        let surface = harness.surface

        surface.sendAgentPanelRequest(.terminal(.open(
            requestID: "request-1",
            context: panelContext
        )))
        surface.sendAgentPanelRequest(.terminal(.open(
            requestID: "request-1",
            context: panelContext
        )))

        try await waitUntil { harness.coordinator.sent.count == 1 }
        let wireContext = AgentResumeTerminalContext(
            projectPath: panelContext.projectPath,
            source: panelContext.source.rawValue,
            harnessSessionID: panelContext.sessionID
        )
        #expect(harness.coordinator.sent == [
            .open(AgentTerminalOpen(requestID: "request-1", context: wireContext)),
        ])

        harness.coordinator.yield(.ready(AgentTerminalReady(
            requestID: "request-1",
            context: wireContext,
            ptySessionName: "agent-resume-claude-a4cdd7b8-3f9a-4d80-bc72-5f4aab6f39e1"
        )))

        try await waitUntil { harness.opener.requests.count == 1 }
        let request = try #require(harness.opener.requests.first)
        #expect(request.role == .terminal)
        #expect(request.sessionName == "agent-resume-claude-a4cdd7b8-3f9a-4d80-bc72-5f4aab6f39e1")
        #expect(request.launch == .shell(cwd: "", shell: ""))
        #expect(request.lifetime == .leased)
        #expect(!request.createIfMissing)
    }

    @Test func closedLayoutHasNoTerminalFootprintAndOpenUsesDefaultClampedFraction() async throws {
        let harness = makeHarness()
        let surface = harness.surface
        layout(surface)

        #expect(!surface.isTerminalPresented)
        #expect(surface.resizeHandle.isHidden)
        #expect(surface.terminalContent.isHidden)
        #expect(surface.resizeHandle.frame.height == 0)
        #expect(surface.terminalContent.frame.height == 0)
        #expect(abs(surface.panelContentView.frame.height - surface.bounds.height) < 0.5)

        try await openAndAttach(harness)
        layout(surface)

        #expect(surface.isTerminalPresented)
        #expect(abs(surface.terminalHeightFraction - 0.38) < 0.001)
        #expect(surface.panelContentView.frame.maxY <= surface.resizeHandle.frame.minY + 0.5)
        #expect(surface.panelContentView.frame.height < surface.bounds.height)

        surface.setTerminalHeightFraction(0.02)
        #expect(abs(surface.terminalHeightFraction - 0.25) < 0.001)
        surface.setTerminalHeightFraction(0.91)
        #expect(abs(surface.terminalHeightFraction - 0.65) < 0.001)
    }

    @Test func terminalBottomUsesKeyboardLayoutGuideAndFractionConstraintStaysRelative() async throws {
        let harness = makeHarness()
        try await openAndAttach(harness)

        let surface = harness.surface
        #expect(surface.terminalBottomConstraint.secondItem === surface.keyboardLayoutGuide)
        #expect(surface.terminalHeightConstraint?.secondItem === surface.terminalAvailableLayoutGuide)
        #expect(abs((surface.terminalHeightConstraint?.multiplier ?? 0) - 0.38) < 0.001)

        surface.setTerminalHeightFraction(0.5)
        #expect(surface.terminalHeightConstraint?.secondItem === surface.terminalAvailableLayoutGuide)
        #expect(abs((surface.terminalHeightConstraint?.multiplier ?? 0) - 0.5) < 0.001)
    }

    @Test func bindsThenAcknowledgesThenReportsReadyToWebview() async throws {
        let harness = makeHarness()
        var delivered: [NSDictionary] = []
        harness.surface.deliverForTesting = { rawJSON in
            if let object = jsonObject(rawJSON) { delivered.append(object) }
        }
        harness.coordinator.onSend = { message in
            guard case .attached = message else { return }
            #expect(harness.surface.terminalContent.isBound)
            #expect(delivered.isEmpty)
        }

        try await openAndAttach(harness)

        #expect(harness.coordinator.sent.count == 2)
        guard case .attached(let ack) = harness.coordinator.sent[1] else {
            Issue.record("expected attached acknowledgement")
            return
        }
        #expect(ack.requestID == "request-1")
        #expect(ack.context.harnessSessionID == panelContext.sessionID)
        #expect(delivered == [expectedTerminalJSON(
            tag: "agent-terminal-ready",
            requestID: ack.requestID,
            context: ack.context,
            ptySessionName: ack.ptySessionName
        )])
    }

    @Test func attachedUserCloseReportsNonNaturalEndedWithoutExitStatus() async throws {
        let harness = makeHarness()
        var delivered: [NSDictionary] = []
        harness.surface.deliverForTesting = { rawJSON in
            if let object = jsonObject(rawJSON) { delivered.append(object) }
        }
        try await openAndAttach(harness)
        try await waitUntil { delivered.count == 1 }
        delivered.removeAll()

        harness.surface.sendAgentPanelRequest(.terminal(.close(
            requestID: "request-1",
            context: panelContext
        )))
        try await waitUntil { harness.coordinator.sent.count == 3 && delivered.count == 1 }

        let ready = readyPayload()
        #expect(harness.coordinator.sent[2] == .close(AgentTerminalClose(
            requestID: ready.requestID,
            context: ready.context,
            ptySessionName: ready.ptySessionName,
            reason: "user-close"
        )))
        #expect(delivered == [expectedTerminalJSON(
            tag: "agent-terminal-ended",
            requestID: ready.requestID,
            context: ready.context,
            ptySessionName: ready.ptySessionName
        )])
        #expect(delivered.first?["xs"] == nil)
        #expect(!harness.surface.terminalContent.isBound)
        #expect(!harness.surface.isTerminalPresented)
    }

    @Test func replacingSettledTransportDetachesOldTerminalAndResumesExactOpen() async throws {
        let harness = makeHarness()
        var delivered: [NSDictionary] = []
        harness.surface.deliverForTesting = { rawJSON in
            if let object = jsonObject(rawJSON) { delivered.append(object) }
        }
        try await openAndAttach(harness)
        try await waitUntil { delivered.count == 1 }

        let replacementCoordinator = FakeAgentTerminalCoordinator()
        let replacementConnection = FakeTerminalConnection()
        let replacementOpener = FakeAgentTerminalSessionOpener(connection: replacementConnection)
        harness.surface.bindTerminalDependencies(
            coordinator: replacementCoordinator,
            sessionOpener: replacementOpener
        )

        try await waitUntil { harness.connection.detachCount == 1 }
        #expect(!harness.surface.terminalContent.isBound)
        #expect(!harness.surface.isTerminalPresented)
        #expect(delivered.count == 1)
        #expect(harness.coordinator.sent.count == 2)

        try await waitUntil { replacementCoordinator.sent.count == 1 }
        #expect(replacementCoordinator.sent[0] == .open(AgentTerminalOpen(
            requestID: "request-1",
            context: readyPayload().context
        )))
        replacementCoordinator.yield(.ready(readyPayload()))
        try await waitUntil {
            replacementCoordinator.sent.count == 2 && delivered.count == 2
        }

        #expect(replacementOpener.requests.count == 1)
        #expect(harness.surface.terminalContent.isBound)
        #expect(harness.surface.isTerminalPresented)
    }

    @Test func teardownDuringAttachedAckDetachesAndDoesNotRetainSurfaceOrConnection() async throws {
        var harness: Harness? = makeHarness()
        harness?.coordinator.shouldDelayAttached = true
        var delivered: [String] = []
        harness?.surface.deliverForTesting = { delivered.append($0) }
        weak let weakSurface = harness?.surface
        weak let weakConnection = harness?.connection

        harness?.surface.sendAgentPanelRequest(.terminal(.open(
            requestID: "request-1",
            context: panelContext
        )))
        try await waitUntil { harness?.coordinator.sent.count == 1 }
        harness?.coordinator.yield(.ready(readyPayload()))
        try await waitUntil {
            harness?.coordinator.sent.count == 2 && harness?.surface.terminalContent.isBound == true
        }

        harness?.surface.teardown()
        try await waitUntil { harness?.connection.detachCount == 1 }
        #expect(harness?.surface.terminalContent.isBound == false)
        #expect(harness?.surface.isTerminalPresented == false)
        #expect(delivered.isEmpty)

        harness = nil
        try await waitUntil { weakSurface == nil && weakConnection == nil }
        #expect(weakSurface == nil)
        #expect(weakConnection == nil)
        #expect(delivered.isEmpty)
    }

    @Test func staleCoordinatorReadyAfterUserCloseCannotAttachOrReportReady() async throws {
        let harness = makeHarness()
        var delivered: [String] = []
        harness.surface.deliverForTesting = { delivered.append($0) }
        harness.surface.sendAgentPanelRequest(.terminal(.open(
            requestID: "request-1",
            context: panelContext
        )))
        try await waitUntil { harness.coordinator.sent.count == 1 }

        harness.surface.sendAgentPanelRequest(.terminal(.close(
            requestID: "request-1",
            context: panelContext
        )))
        try await waitUntil { harness.coordinator.sent.count == 2 }
        harness.coordinator.yield(.ready(readyPayload()))
        await drainTasks()

        #expect(harness.opener.requests.isEmpty)
        #expect(delivered.isEmpty)
        #expect(!harness.surface.isTerminalPresented)
    }

    @Test func staleAttachCompletionFromReplacedTransportDetachesWithoutReady() async throws {
        let harness = makeHarness(delayedOpen: true)
        var delivered: [String] = []
        harness.surface.deliverForTesting = { delivered.append($0) }
        harness.surface.sendAgentPanelRequest(.terminal(.open(
            requestID: "request-1",
            context: panelContext
        )))
        try await waitUntil { harness.coordinator.sent.count == 1 }
        harness.coordinator.yield(.ready(readyPayload()))
        try await waitUntil { harness.opener.requests.count == 1 }

        let replacementCoordinator = FakeAgentTerminalCoordinator()
        let replacementOpener = FakeAgentTerminalSessionOpener(connection: FakeTerminalConnection())
        harness.surface.bindTerminalDependencies(
            coordinator: replacementCoordinator,
            sessionOpener: replacementOpener
        )
        harness.opener.releaseDelayedOpen()

        try await waitUntil { harness.connection.detachCount == 1 }
        #expect(!harness.surface.terminalContent.isBound)
        #expect(!harness.surface.isTerminalPresented)
        #expect(delivered.isEmpty)
        #expect(harness.coordinator.sent.count == 1)
    }

    @Test func transportReplacementWhileAttachedAckIsPendingClearsStaleBinding() async throws {
        let harness = makeHarness()
        harness.coordinator.shouldDelayAttached = true
        var delivered: [String] = []
        harness.surface.deliverForTesting = { delivered.append($0) }
        harness.surface.sendAgentPanelRequest(.terminal(.open(
            requestID: "request-1",
            context: panelContext
        )))
        try await waitUntil { harness.coordinator.sent.count == 1 }
        harness.coordinator.yield(.ready(readyPayload()))
        try await waitUntil {
            harness.coordinator.sent.count == 2 && harness.surface.terminalContent.isBound
        }

        let replacementCoordinator = FakeAgentTerminalCoordinator()
        let replacementOpener = FakeAgentTerminalSessionOpener(connection: FakeTerminalConnection())
        harness.surface.bindTerminalDependencies(
            coordinator: replacementCoordinator,
            sessionOpener: replacementOpener
        )
        await drainTasks()

        #expect(!harness.surface.terminalContent.isBound)
        #expect(!harness.surface.isTerminalPresented)
        #expect(delivered.isEmpty)
    }

    @Test func typedCoordinatorErrorAndNaturalExitReachWebviewWithoutStatusParsing() async throws {
        let errorHarness = makeHarness()
        var errorMessages: [NSDictionary] = []
        errorHarness.surface.deliverForTesting = { rawJSON in
            if let object = jsonObject(rawJSON) { errorMessages.append(object) }
        }
        errorHarness.surface.sendAgentPanelRequest(.terminal(.open(
            requestID: "request-1",
            context: panelContext
        )))
        try await waitUntil { errorHarness.coordinator.sent.count == 1 }
        let wireContext = readyPayload().context
        let error = AgentTerminalHostMessage.error(AgentTerminalError(
            requestID: "request-1",
            context: wireContext,
            code: .activeElsewhere
        ))
        errorHarness.coordinator.yield(error)
        try await waitUntil { errorMessages.count == 1 }
        #expect(errorMessages == [expectedTerminalJSON(
            tag: "agent-terminal-error",
            requestID: "request-1",
            context: wireContext,
            code: "activeElsewhere"
        )])

        let exitHarness = makeHarness()
        var exitMessages: [NSDictionary] = []
        exitHarness.surface.deliverForTesting = { rawJSON in
            if let object = jsonObject(rawJSON) { exitMessages.append(object) }
        }
        try await openAndAttach(exitHarness)
        exitMessages.removeAll()

        exitHarness.connection.yield(.exited(23))
        try await waitUntil { exitMessages.count == 1 }
        #expect(exitMessages == [expectedTerminalJSON(
            tag: "agent-terminal-ended",
            requestID: "request-1",
            context: wireContext,
            ptySessionName: readyPayload().ptySessionName,
            exitStatus: 23
        )])
        #expect(!exitHarness.surface.isTerminalPresented)
    }

    @Test func attachedAcknowledgementFailureDetachesAndEmitsNoReady() async throws {
        var harness: Harness? = makeHarness()
        harness?.coordinator.attachedSendError = TestTerminalError.sendFailed
        var delivered: [NSDictionary] = []
        harness?.surface.deliverForTesting = { rawJSON in
            if let object = jsonObject(rawJSON) { delivered.append(object) }
        }
        weak let weakConnection = harness?.connection

        harness?.surface.sendAgentPanelRequest(.terminal(.open(
            requestID: "request-1",
            context: panelContext
        )))
        try await waitUntil { harness?.coordinator.sent.count == 1 }
        harness?.coordinator.yield(.ready(readyPayload()))
        try await waitUntil {
            harness?.coordinator.failedSendCount == 1 && harness?.connection.detachCount == 1
        }

        #expect(harness?.surface.terminalContent.isBound == false)
        #expect(harness?.surface.isTerminalPresented == false)
        #expect(!delivered.contains { $0["t"] as? String == "agent-terminal-ready" })

        harness = nil
        try await waitUntil { weakConnection == nil }
        #expect(weakConnection == nil)
    }

    @Test func closeSendFailureReleasesConnectionAndEmitsNoEnded() async throws {
        var harness: Harness? = makeHarness()
        var delivered: [NSDictionary] = []
        harness?.surface.deliverForTesting = { rawJSON in
            if let object = jsonObject(rawJSON) { delivered.append(object) }
        }
        weak let weakConnection = harness?.connection
        try await openAndAttach(try #require(harness))
        try await waitUntil { delivered.count == 1 }
        delivered.removeAll()
        harness?.coordinator.closeSendError = TestTerminalError.sendFailed

        harness?.surface.sendAgentPanelRequest(.terminal(.close(
            requestID: "request-1",
            context: panelContext
        )))
        try await waitUntil {
            harness?.coordinator.failedSendCount == 1 && harness?.connection.detachCount == 1
        }

        #expect(delivered.isEmpty)
        #expect(harness?.surface.terminalContent.isBound == false)
        #expect(harness?.surface.isTerminalPresented == false)

        harness = nil
        try await waitUntil { weakConnection == nil }
        #expect(weakConnection == nil)
    }

    @Test func closeCompletionAfterTransportReplacementEmitsNoEnded() async throws {
        let harness = makeHarness()
        var delivered: [NSDictionary] = []
        harness.surface.deliverForTesting = { rawJSON in
            if let object = jsonObject(rawJSON) { delivered.append(object) }
        }
        try await openAndAttach(harness)
        try await waitUntil { delivered.count == 1 }
        delivered.removeAll()
        harness.coordinator.shouldDelayClose = true

        harness.surface.sendAgentPanelRequest(.terminal(.close(
            requestID: "request-1",
            context: panelContext
        )))
        try await waitUntil { harness.coordinator.sent.count == 3 }

        let replacementCoordinator = FakeAgentTerminalCoordinator()
        let replacementOpener = FakeAgentTerminalSessionOpener(connection: FakeTerminalConnection())
        harness.surface.bindTerminalDependencies(
            coordinator: replacementCoordinator,
            sessionOpener: replacementOpener
        )
        harness.coordinator.releaseDelayedClose()
        await drainTasks()

        #expect(delivered.isEmpty)
        #expect(!harness.surface.terminalContent.isBound)
        #expect(!harness.surface.isTerminalPresented)
    }

    @Test func attachFailureReportsTypedLaunchErrorWithoutReady() async throws {
        let harness = makeHarness(openError: TestTerminalError.attachFailed)
        var messages: [AgentTerminalHostMessage] = []
        harness.surface.deliverForTesting = { rawJSON in
            guard let data = rawJSON.data(using: .utf8),
                  let message = try? JSONDecoder().decode(AgentTerminalHostMessage.self, from: data)
            else { return }
            messages.append(message)
        }

        harness.surface.sendAgentPanelRequest(.terminal(.open(
            requestID: "request-1",
            context: panelContext
        )))
        try await waitUntil { harness.coordinator.sent.count == 1 }
        harness.coordinator.yield(.ready(readyPayload()))
        try await waitUntil { messages.count == 1 }

        guard case .error(let error) = messages[0] else {
            Issue.record("expected typed attach error")
            return
        }
        #expect(error.code == .launchFailed)
        #expect(error.requestID == "request-1")
        #expect(!harness.surface.isTerminalPresented)
        #expect(harness.coordinator.sent.count == 1)
    }

    @Test func everyExplicitAbandonmentSendsOneExactCloseAndPreventsResurrection() async throws {
        let cases: [(AgentFeedTerminalAbandonmentReason, String)] = [
            (.contextEnded, "context-ended"),
            (.surfaceSwitched, "surface-switched"),
            (.surfaceTeardown, "surface-teardown"),
            (.pairingDisconnected, "pairing-disconnected"),
            (.pairingRevoked, "pairing-revoked"),
        ]

        for (reason, wireReason) in cases {
            let harness = makeHarness()
            var delivered: [NSDictionary] = []
            harness.surface.deliverForTesting = { rawJSON in
                if let object = jsonObject(rawJSON) { delivered.append(object) }
            }
            try await openAndAttach(harness)
            delivered.removeAll()

            harness.surface.abandonTerminal(reason)
            harness.surface.abandonTerminal(reason)
            try await waitUntil { harness.coordinator.sent.count == 3 }

            let ready = readyPayload()
            #expect(harness.coordinator.sent[2] == .close(AgentTerminalClose(
                requestID: ready.requestID,
                context: ready.context,
                ptySessionName: ready.ptySessionName,
                reason: wireReason
            )))
            harness.coordinator.yield(.ready(ready))
            try await waitUntil { delivered.count == 1 }

            #expect(harness.coordinator.sent.count == 3)
            #expect(harness.connection.detachCount == 1)
            #expect(!harness.surface.terminalContent.isBound)
            #expect(!harness.surface.isTerminalPresented)
            #expect(delivered == [expectedTerminalJSON(
                tag: "agent-terminal-ended",
                requestID: ready.requestID,
                context: ready.context,
                ptySessionName: ready.ptySessionName
            )])
        }
    }

    @Test func contextEndedAndUserCloseUseExplicitLifecycleWithoutDuplicateKill() async throws {
        let contextHarness = makeHarness()
        try await openAndAttach(contextHarness)
        contextHarness.surface.sendAgentPanelRequest(.terminal(.contextEnded(
            requestID: "request-1",
            context: panelContext
        )))
        contextHarness.surface.sendAgentPanelRequest(.terminal(.close(
            requestID: "request-1",
            context: panelContext
        )))
        try await waitUntil { contextHarness.coordinator.sent.count == 3 }
        #expect(contextHarness.coordinator.sent[2] == .close(AgentTerminalClose(
            requestID: "request-1",
            context: readyPayload().context,
            ptySessionName: readyPayload().ptySessionName,
            reason: "context-ended"
        )))

        let closeHarness = makeHarness()
        var delivered: [NSDictionary] = []
        closeHarness.surface.deliverForTesting = { rawJSON in
            if let object = jsonObject(rawJSON) { delivered.append(object) }
        }
        try await openAndAttach(closeHarness)
        delivered.removeAll()
        closeHarness.surface.sendAgentPanelRequest(.terminal(.close(
            requestID: "request-1",
            context: panelContext
        )))
        closeHarness.surface.abandonTerminal(.surfaceTeardown)
        try await waitUntil { closeHarness.coordinator.sent.count == 3 && delivered.count == 1 }
        #expect(closeHarness.coordinator.sent[2] == .close(AgentTerminalClose(
            requestID: "request-1",
            context: readyPayload().context,
            ptySessionName: readyPayload().ptySessionName,
            reason: "user-close"
        )))
        #expect(delivered.first?["t"] as? String == "agent-terminal-ended")
        #expect(delivered.first?["xs"] == nil)
    }

    @Test func backgroundAndTransportLossDetachWithoutCloseAndHideTerminal() async throws {
        for interruption in [
            AgentFeedTerminalInterruption.background,
            AgentFeedTerminalInterruption.transportLoss,
        ] {
            let harness = makeHarness()
            try await openAndAttach(harness)

            harness.surface.interruptTerminal(interruption)
            try await waitUntil { harness.connection.detachCount == 1 }

            #expect(harness.coordinator.sent.count == 2)
            #expect(!harness.coordinator.sent.contains { message in
                if case .close = message { return true }
                return false
            })
            #expect(!harness.surface.terminalContent.isBound)
            #expect(!harness.surface.isTerminalPresented)
        }
    }

    @Test func activeDedicatedStreamFailureReattachesWithSameAuthenticatedTransport() async throws {
        let surface = AgentFeedSurface(panelViewForTesting: UIView())
        let coordinator = FakeAgentTerminalCoordinator()
        let originalConnection = FakeTerminalConnection(pid: 4202)
        let replacementConnection = FakeTerminalConnection(pid: 4202)
        let opener = FakeAgentTerminalSessionOpener(
            connections: [originalConnection, replacementConnection]
        )
        let harness = Harness(
            surface: surface,
            coordinator: coordinator,
            opener: opener,
            connection: originalConnection
        )
        surface.bindTerminalDependencies(coordinator: coordinator, sessionOpener: opener)
        try await openAndAttach(harness)

        originalConnection.fail(TestTerminalError.streamFailed)
        try await waitUntil { coordinator.sent.count == 3 }

        #expect(coordinator.sent[2] == .open(AgentTerminalOpen(
            requestID: "request-1",
            context: readyPayload().context
        )))
        coordinator.yield(.ready(readyPayload()))
        try await waitUntil { coordinator.sent.count == 4 && surface.terminalContent.isBound }

        #expect(opener.requests.count == 2)
        #expect(opener.requests.allSatisfy { !$0.createIfMissing })
        #expect(replacementConnection.identity.sessionName == readyPayload().ptySessionName)
        #expect(replacementConnection.identity.pid == 4202)
        guard case .attached = coordinator.sent[3] else {
            Issue.record("expected same-transport attached acknowledgement")
            return
        }
    }

    @Test func explicitAbandonmentWithoutDependenciesFlushesExactCloseOnReplacement() async throws {
        let harness = makeHarness()
        try await openAndAttach(harness)
        harness.surface.interruptTerminal(.transportLoss)

        harness.surface.abandonTerminal(.contextEnded)
        let replacementCoordinator = FakeAgentTerminalCoordinator()
        let replacementOpener = FakeAgentTerminalSessionOpener(connection: FakeTerminalConnection())
        harness.surface.bindTerminalDependencies(
            coordinator: replacementCoordinator,
            sessionOpener: replacementOpener
        )
        try await waitUntil { replacementCoordinator.sent.count == 1 }

        #expect(replacementCoordinator.sent == [.close(AgentTerminalClose(
            requestID: "request-1",
            context: readyPayload().context,
            ptySessionName: readyPayload().ptySessionName,
            reason: "context-ended"
        ))])
        #expect(replacementOpener.requests.isEmpty)
        #expect(!harness.surface.terminalContent.isBound)
        #expect(!harness.surface.isTerminalPresented)
    }

    @Test func pendingAbandonmentOutlivesReleasedSurfaceAndFlushesOnReplacement() async throws {
        let router = AgentFeedTerminalLifecycleRouter()
        var surface: AgentFeedSurface? = AgentFeedSurface(
            panelViewForTesting: UIView(),
            closeDelivery: router.closeDelivery
        )
        let coordinator = FakeAgentTerminalCoordinator()
        let connection = FakeTerminalConnection()
        let opener = FakeAgentTerminalSessionOpener(connection: connection)
        surface?.bindTerminalDependencies(coordinator: coordinator, sessionOpener: opener)
        surface?.sendAgentPanelRequest(.terminal(.open(
            requestID: "request-1",
            context: panelContext
        )))
        try await waitUntil { coordinator.sent.count == 1 }
        coordinator.yield(.ready(readyPayload()))
        try await waitUntil { coordinator.sent.count == 2 && surface?.isTerminalPresented == true }

        surface?.interruptTerminal(.transportLoss)
        surface?.abandonTerminal(.pairingDisconnected)
        weak let releasedSurface = surface
        surface = nil
        #expect(releasedSurface == nil)

        let replacementCoordinator = FakeAgentTerminalCoordinator()
        router.bind(replacementCoordinator)
        try await waitUntil { replacementCoordinator.sent.count == 1 }

        #expect(replacementCoordinator.sent == [.close(AgentTerminalClose(
            requestID: "request-1",
            context: readyPayload().context,
            ptySessionName: readyPayload().ptySessionName,
            reason: "pairing-disconnected"
        ))])
    }

    @Test func failedExplicitCloseFlushesOnceOnReplacementWithoutResuming() async throws {
        let harness = makeHarness()
        try await openAndAttach(harness)
        harness.coordinator.closeSendError = TestTerminalError.sendFailed

        harness.surface.abandonTerminal(.surfaceSwitched)
        try await waitUntil { harness.coordinator.failedSendCount == 1 }

        let replacementCoordinator = FakeAgentTerminalCoordinator()
        let replacementOpener = FakeAgentTerminalSessionOpener(connection: FakeTerminalConnection())
        harness.surface.bindTerminalDependencies(
            coordinator: replacementCoordinator,
            sessionOpener: replacementOpener
        )
        try await waitUntil { replacementCoordinator.sent.count == 1 }

        #expect(replacementCoordinator.sent == [.close(AgentTerminalClose(
            requestID: "request-1",
            context: readyPayload().context,
            ptySessionName: readyPayload().ptySessionName,
            reason: "surface-switched"
        ))])
        #expect(replacementOpener.requests.isEmpty)
    }

    @Test func switchAwayResignsTerminalFocusBeforeDetaching() async throws {
        let harness = makeHarness()
        let window = hostInWindow(harness.surface)
        defer { window.isHidden = true }
        try await openAndAttach(harness)

        harness.surface.terminalContent.focus()
        try await waitUntil { firstResponder(in: harness.surface.terminalContent) != nil }

        harness.surface.abandonTerminal(.surfaceSwitched)

        try await waitUntil {
            !harness.surface.terminalContent.isBound
                && !harness.surface.isTerminalPresented
                && firstResponder(in: harness.surface.terminalContent) == nil
        }
    }

    @Test func explicitCloseTaskCompletesOnlyAfterTypedCloseSendSettles() async throws {
        let harness = makeHarness()
        try await openAndAttach(harness)
        harness.coordinator.shouldDelayClose = true

        let closeTask = try #require(harness.surface.abandonTerminal(.pairingDisconnected))
        try await waitUntil { harness.coordinator.sent.count == 3 }

        #expect(harness.coordinator.closeSendCompletionCount == 0)
        #expect(!harness.surface.terminalContent.isBound)
        #expect(!harness.surface.isTerminalPresented)

        harness.coordinator.releaseDelayedClose()
        await closeTask.value
        #expect(harness.coordinator.closeSendCompletionCount == 1)
    }

    @Test func managerDetachReportsSessionEndedAndNextOpenIsFresh() async throws {
        let harness = makeHarness()
        var delivered: [NSDictionary] = []
        harness.surface.deliverForTesting = { rawJSON in
            if let object = jsonObject(rawJSON) { delivered.append(object) }
        }
        try await openAndAttach(harness)
        delivered.removeAll()

        harness.surface.terminalContent.closeAfterManagerDetach()
        try await waitUntil { delivered.count == 1 }

        #expect(delivered == [expectedTerminalJSON(
            tag: "agent-terminal-error",
            requestID: "request-1",
            context: readyPayload().context,
            ptySessionName: readyPayload().ptySessionName,
            code: "sessionEnded"
        )])

        harness.surface.sendAgentPanelRequest(.terminal(.open(
            requestID: "request-2",
            context: panelContext
        )))
        try await waitUntil { harness.coordinator.sent.count == 3 }
        #expect(harness.coordinator.sent[2] == .open(AgentTerminalOpen(
            requestID: "request-2",
            context: readyPayload().context
        )))
    }

    @Test func reconnectWithinGraceReusesExactOpenNameAndPIDThenAcknowledgesReady() async throws {
        let harness = makeHarness(pid: 4101)
        try await openAndAttach(harness)
        // The manager's 30-second leased-PTY grace bounds this reattach; the QUIC auth resume TTL is separate.
        harness.surface.interruptTerminal(.background)
        try await waitUntil { harness.connection.detachCount == 1 }

        let replacementCoordinator = FakeAgentTerminalCoordinator()
        let replacementConnection = FakeTerminalConnection(
            sessionName: readyPayload().ptySessionName,
            pid: 4101
        )
        let replacementOpener = FakeAgentTerminalSessionOpener(connection: replacementConnection)
        var delivered: [NSDictionary] = []
        harness.surface.deliverForTesting = { rawJSON in
            if let object = jsonObject(rawJSON) { delivered.append(object) }
        }

        harness.surface.bindTerminalDependencies(
            coordinator: replacementCoordinator,
            sessionOpener: replacementOpener
        )
        try await waitUntil { replacementCoordinator.sent.count == 1 }
        #expect(replacementCoordinator.sent[0] == .open(AgentTerminalOpen(
            requestID: "request-1",
            context: readyPayload().context
        )))

        replacementCoordinator.yield(.ready(readyPayload()))
        try await waitUntil {
            replacementCoordinator.sent.count == 2 && delivered.count == 1
        }

        #expect(replacementOpener.requests.map(\.sessionName) == [readyPayload().ptySessionName])
        #expect(replacementOpener.requests.allSatisfy { !$0.createIfMissing })
        #expect(replacementConnection.identity.pid == 4101)
        guard case .attached = replacementCoordinator.sent[1] else {
            Issue.record("expected reconnect attached acknowledgement")
            return
        }
        #expect(delivered.first?["t"] as? String == "agent-terminal-ready")
        #expect(harness.surface.terminalContent.isBound)
        #expect(harness.surface.isTerminalPresented)
    }

    @Test func reconnectWithDifferentPIDCannotBindOrReportReady() async throws {
        let harness = makeHarness(pid: 4301)
        var delivered: [NSDictionary] = []
        harness.surface.deliverForTesting = { rawJSON in
            if let object = jsonObject(rawJSON) { delivered.append(object) }
        }
        try await openAndAttach(harness)
        delivered.removeAll()
        harness.surface.interruptTerminal(.transportLoss)

        let replacementCoordinator = FakeAgentTerminalCoordinator()
        let replacementConnection = FakeTerminalConnection(
            sessionName: readyPayload().ptySessionName,
            pid: 4302
        )
        let replacementOpener = FakeAgentTerminalSessionOpener(connection: replacementConnection)
        harness.surface.bindTerminalDependencies(
            coordinator: replacementCoordinator,
            sessionOpener: replacementOpener
        )
        try await waitUntil { replacementCoordinator.sent.count == 1 }
        replacementCoordinator.yield(.ready(readyPayload()))
        try await waitUntil { delivered.count == 1 && replacementConnection.detachCount == 1 }

        #expect(delivered == [expectedTerminalJSON(
            tag: "agent-terminal-error",
            requestID: "request-1",
            context: readyPayload().context,
            ptySessionName: readyPayload().ptySessionName,
            code: "sessionEnded"
        )])
        #expect(replacementCoordinator.sent.count == 1)
        #expect(!harness.surface.terminalContent.isBound)
        #expect(!harness.surface.isTerminalPresented)
    }

    @Test func reconnectSessionEndedClearsDescriptorAndNextOpenIsFresh() async throws {
        let harness = makeHarness(pid: 4102)
        try await openAndAttach(harness)
        harness.surface.interruptTerminal(.transportLoss)

        let replacementCoordinator = FakeAgentTerminalCoordinator()
        let replacementConnection = FakeTerminalConnection(
            sessionName: readyPayload().ptySessionName,
            pid: 4102
        )
        let replacementOpener = FakeAgentTerminalSessionOpener(connection: replacementConnection)
        harness.surface.bindTerminalDependencies(
            coordinator: replacementCoordinator,
            sessionOpener: replacementOpener
        )
        try await waitUntil { replacementCoordinator.sent.count == 1 }
        replacementCoordinator.yield(.error(AgentTerminalError(
            requestID: "request-1",
            context: readyPayload().context,
            ptySessionName: readyPayload().ptySessionName,
            code: .sessionEnded
        )))
        await drainTasks()

        harness.surface.sendAgentPanelRequest(.terminal(.open(
            requestID: "request-2",
            context: panelContext
        )))
        try await waitUntil { replacementCoordinator.sent.count == 2 }
        #expect(replacementCoordinator.sent[1] == .open(AgentTerminalOpen(
            requestID: "request-2",
            context: readyPayload().context
        )))
        #expect(replacementOpener.requests.isEmpty)
    }

    @Test func staleReconnectAttachCannotBindOrReportReadyAfterNewerSession() async throws {
        let harness = makeHarness(pid: 4103)
        try await openAndAttach(harness)
        harness.surface.interruptTerminal(.transportLoss)

        let staleCoordinator = FakeAgentTerminalCoordinator()
        let staleConnection = FakeTerminalConnection(
            sessionName: readyPayload().ptySessionName,
            pid: 4103
        )
        let staleOpener = FakeAgentTerminalSessionOpener(
            connection: staleConnection,
            delayedOpen: true
        )
        var delivered: [NSDictionary] = []
        harness.surface.deliverForTesting = { rawJSON in
            if let object = jsonObject(rawJSON) { delivered.append(object) }
        }
        harness.surface.bindTerminalDependencies(
            coordinator: staleCoordinator,
            sessionOpener: staleOpener
        )
        try await waitUntil { staleCoordinator.sent.count == 1 }
        staleCoordinator.yield(.ready(readyPayload()))
        try await waitUntil { staleOpener.requests.count == 1 }

        let closeTask = try #require(harness.surface.abandonTerminal(.contextEnded))
        await closeTask.value
        let replacementCoordinator = FakeAgentTerminalCoordinator()
        let replacementConnection = FakeTerminalConnection(
            sessionName: "agent-resume-codex-new-session",
            pid: 5100
        )
        let replacementOpener = FakeAgentTerminalSessionOpener(connection: replacementConnection)
        harness.surface.bindTerminalDependencies(
            coordinator: replacementCoordinator,
            sessionOpener: replacementOpener
        )
        let newerContext = AgentPanelTerminalContext(
            projectPath: "/Users/dev/projects/beta",
            source: .codex,
            sessionID: "9b8ec323-e59a-4ff5-a0b8-86632ab41d54"
        )
        harness.surface.sendAgentPanelRequest(.terminal(.open(
            requestID: "request-2",
            context: newerContext
        )))
        try await waitUntil { replacementCoordinator.sent.count == 1 }

        staleOpener.releaseDelayedOpen()
        try await waitUntil { staleConnection.detachCount == 1 }
        await drainTasks()

        #expect(!harness.surface.terminalContent.isBound)
        #expect(!harness.surface.isTerminalPresented)
        #expect(delivered.isEmpty)
        let replacementOpen = try #require(replacementCoordinator.sent.first)
        #expect(replacementOpen == .open(AgentTerminalOpen(
            requestID: "request-2",
            context: AgentResumeTerminalContext(
                projectPath: newerContext.projectPath,
                source: newerContext.source.rawValue,
                harnessSessionID: newerContext.sessionID
            )
        )))
    }

    @Test func staleMismatchedPIDAttachCannotClearNewerSameContextBinding() async throws {
        let harness = makeHarness(pid: 4401)
        var delivered: [NSDictionary] = []
        harness.surface.deliverForTesting = { rawJSON in
            if let object = jsonObject(rawJSON) { delivered.append(object) }
        }
        try await openAndAttach(harness)
        delivered.removeAll()
        harness.surface.interruptTerminal(.transportLoss)

        let staleCoordinator = FakeAgentTerminalCoordinator()
        let staleConnection = FakeTerminalConnection(pid: 9999)
        let staleOpener = FakeAgentTerminalSessionOpener(
            connection: staleConnection,
            delayedOpen: true
        )
        harness.surface.bindTerminalDependencies(
            coordinator: staleCoordinator,
            sessionOpener: staleOpener
        )
        try await waitUntil { staleCoordinator.sent.count == 1 }
        staleCoordinator.yield(.ready(readyPayload()))
        try await waitUntil { staleOpener.requests.count == 1 }

        let currentCoordinator = FakeAgentTerminalCoordinator()
        let currentConnection = FakeTerminalConnection(pid: 4401)
        let currentOpener = FakeAgentTerminalSessionOpener(connection: currentConnection)
        harness.surface.bindTerminalDependencies(
            coordinator: currentCoordinator,
            sessionOpener: currentOpener
        )
        try await waitUntil { currentCoordinator.sent.count == 1 }
        currentCoordinator.yield(.ready(readyPayload()))
        try await waitUntil {
            currentCoordinator.sent.count == 2 && harness.surface.terminalContent.isBound
        }

        staleOpener.releaseDelayedOpen()
        try await waitUntil { staleConnection.detachCount == 1 }
        await drainTasks()

        #expect(harness.surface.terminalContent.isBound)
        #expect(harness.surface.isTerminalPresented)
        #expect(delivered.count == 1)
        #expect(delivered.first?["t"] as? String == "agent-terminal-ready")
    }

    @Test func lifecycleRouterClassifiesPairingTransitionsAndOrdersTeardownBeforeRelease() async {
        let router = AgentFeedTerminalLifecycleRouter()

        let classifications: [(AgentFeedTerminalLifecycleEvent, String)] = [
            (.switchAway, "abandon:surface-switched"),
            (.rejection(.revoked), "abandon:pairing-revoked"),
            (.rejection(.expiredResume), "abandon:surface-teardown"),
            (.forget, "abandon:pairing-revoked"),
            (.disconnect, "abandon:pairing-disconnected"),
            (.background, "interrupt:background"),
            (.transportFailure, "interrupt:transport-loss"),
        ]
        for (event, expected) in classifications {
            let target = FakeTerminalLifecycleTarget()
            _ = router.route(event, to: target)
            #expect(target.events == [expected])
        }

        let teardownTarget = FakeTerminalLifecycleTarget()
        _ = router.teardown(teardownTarget) {
            teardownTarget.events.append("release")
        }
        #expect(teardownTarget.events == ["teardown", "release"])
    }

    @Test func nilMediaFailureClassificationPreservesDescriptorForReconnectWithoutClose() async throws {
        let router = AgentFeedTerminalLifecycleRouter()
        let harness = makeHarness(pid: 4501)
        try await openAndAttach(harness)

        _ = router.route(.transportFailure, to: harness.surface)
        try await waitUntil { harness.connection.detachCount == 1 }
        #expect(harness.coordinator.sent.count == 2)

        let replacementCoordinator = FakeAgentTerminalCoordinator()
        let replacementConnection = FakeTerminalConnection(pid: 4501)
        let replacementOpener = FakeAgentTerminalSessionOpener(connection: replacementConnection)
        harness.surface.bindTerminalDependencies(
            coordinator: replacementCoordinator,
            sessionOpener: replacementOpener
        )
        try await waitUntil { replacementCoordinator.sent.count == 1 }

        #expect(replacementCoordinator.sent == [.open(AgentTerminalOpen(
            requestID: "request-1",
            context: readyPayload().context
        ))])
        #expect(!replacementCoordinator.sent.contains { message in
            if case .close = message { return true }
            return false
        })
    }

    private func makeHarness(
        pid: UInt32 = 4100,
        delayedOpen: Bool = false,
        openError: Error? = nil
    ) -> Harness {
        let surface = AgentFeedSurface(panelViewForTesting: UIView())
        let coordinator = FakeAgentTerminalCoordinator()
        let connection = FakeTerminalConnection(
            sessionName: readyPayload().ptySessionName,
            pid: pid
        )
        let opener = FakeAgentTerminalSessionOpener(
            connection: connection,
            delayedOpen: delayedOpen,
            openError: openError
        )
        surface.bindTerminalDependencies(coordinator: coordinator, sessionOpener: opener)
        return Harness(
            surface: surface,
            coordinator: coordinator,
            opener: opener,
            connection: connection
        )
    }

    private func openAndAttach(_ harness: Harness) async throws {
        harness.surface.sendAgentPanelRequest(.terminal(.open(
            requestID: "request-1",
            context: panelContext
        )))
        try await waitUntil { harness.coordinator.sent.count == 1 }
        harness.coordinator.yield(.ready(readyPayload()))
        try await waitUntil {
            harness.coordinator.sent.count == 2 && harness.surface.isTerminalPresented
        }
    }

    private func readyPayload(requestID: String = "request-1") -> AgentTerminalReady {
        AgentTerminalReady(
            requestID: requestID,
            context: AgentResumeTerminalContext(
                projectPath: panelContext.projectPath,
                source: panelContext.source.rawValue,
                harnessSessionID: panelContext.sessionID
            ),
            ptySessionName: "agent-resume-claude-a4cdd7b8-3f9a-4d80-bc72-5f4aab6f39e1"
        )
    }

    private func jsonObject(_ rawJSON: String) -> NSDictionary? {
        guard let data = rawJSON.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? NSDictionary else {
            Issue.record("expected valid AgentPanel JSON object")
            return nil
        }
        return dictionary
    }

    private func expectedTerminalJSON(
        tag: String,
        requestID: String,
        context: AgentResumeTerminalContext,
        ptySessionName: String? = nil,
        code: String? = nil,
        exitStatus: Int32? = nil
    ) -> NSDictionary {
        var object: [String: Any] = [
            "t": tag,
            "rid": requestID,
            "ctx": [
                "pp": context.projectPath,
                "src": context.source,
                "sid": context.harnessSessionID,
            ],
        ]
        if let ptySessionName { object["psn"] = ptySessionName }
        if let code { object["c"] = code }
        if let exitStatus { object["xs"] = exitStatus }
        return object as NSDictionary
    }

    private func layout(_ surface: AgentFeedSurface) {
        surface.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        surface.setNeedsLayout()
        surface.layoutIfNeeded()
    }

    private func hostInWindow(_ surface: AgentFeedSurface) -> UIWindow {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let controller = UIViewController()
        window.rootViewController = controller
        window.makeKeyAndVisible()

        surface.translatesAutoresizingMaskIntoConstraints = false
        controller.view.addSubview(surface)
        NSLayoutConstraint.activate([
            surface.leadingAnchor.constraint(equalTo: controller.view.leadingAnchor),
            surface.trailingAnchor.constraint(equalTo: controller.view.trailingAnchor),
            surface.topAnchor.constraint(equalTo: controller.view.topAnchor),
            surface.bottomAnchor.constraint(equalTo: controller.view.bottomAnchor),
        ])
        controller.view.setNeedsLayout()
        controller.view.layoutIfNeeded()
        surface.layoutIfNeeded()
        return window
    }

    private func firstResponder(in view: UIView) -> UIView? {
        if view.isFirstResponder {
            return view
        }
        for subview in view.subviews {
            if let responder = firstResponder(in: subview) {
                return responder
            }
        }
        return nil
    }

    private func waitUntil(
        attempts: Int = 500,
        _ condition: @MainActor () -> Bool
    ) async throws {
        for _ in 0..<attempts {
            if condition() { return }
            await Task.yield()
        }
        Issue.record("condition did not become true")
    }

    private func drainTasks() async {
        for _ in 0..<20 { await Task.yield() }
    }
}

@MainActor
private struct Harness {
    let surface: AgentFeedSurface
    let coordinator: FakeAgentTerminalCoordinator
    let opener: FakeAgentTerminalSessionOpener
    let connection: FakeTerminalConnection
}

@MainActor
private final class FakeAgentTerminalCoordinator: AgentFeedTerminalCoordinating {
    private let continuation: AsyncStream<AgentTerminalHostMessage>.Continuation
    let agentTerminalUpdates: AsyncStream<AgentTerminalHostMessage>
    var sent: [AgentTerminalClientMessage] = []
    var onSend: ((AgentTerminalClientMessage) -> Void)?
    var shouldDelayAttached = false
    var shouldDelayClose = false
    var attachedSendError: Error?
    var closeSendError: Error?
    private(set) var failedSendCount = 0
    private(set) var closeSendCompletionCount = 0
    private var isDelayedCloseReleased = false

    init() {
        var continuation: AsyncStream<AgentTerminalHostMessage>.Continuation!
        agentTerminalUpdates = AsyncStream { continuation = $0 }
        self.continuation = continuation
    }

    func sendAgentTerminal(_ message: AgentTerminalClientMessage) async throws {
        sent.append(message)
        onSend?(message)
        if case .attached = message, let attachedSendError {
            failedSendCount += 1
            throw attachedSendError
        }
        if case .close = message, let closeSendError {
            failedSendCount += 1
            throw closeSendError
        }
        if case .attached = message, shouldDelayAttached {
            while !Task.isCancelled {
                await Task.yield()
            }
            try Task.checkCancellation()
        }
        if case .close = message, shouldDelayClose {
            while !isDelayedCloseReleased {
                await Task.yield()
            }
        }
        if case .close = message {
            closeSendCompletionCount += 1
        }
    }

    func yield(_ message: AgentTerminalHostMessage) {
        continuation.yield(message)
    }

    func releaseDelayedClose() {
        isDelayedCloseReleased = true
    }
}

@MainActor
private final class FakeAgentTerminalSessionOpener: AgentFeedTerminalSessionOpening {
    private let connections: [FakeTerminalConnection]
    private let delayedOpen: Bool
    private let openError: Error?
    private var isReleased = false
    var requests: [AgentFeedTerminalAttachmentRequest] = []

    init(
        connection: FakeTerminalConnection,
        delayedOpen: Bool = false,
        openError: Error? = nil
    ) {
        self.connections = [connection]
        self.delayedOpen = delayedOpen
        self.openError = openError
    }

    init(connections: [FakeTerminalConnection]) {
        self.connections = connections
        self.delayedOpen = false
        self.openError = nil
    }

    func openAgentFeedTerminal(
        _ request: AgentFeedTerminalAttachmentRequest
    ) async throws -> any AgentFeedTerminalConnection {
        let connectionIndex = requests.count
        requests.append(request)
        while delayedOpen && !isReleased {
            await Task.yield()
        }
        if let openError { throw openError }
        return connections[min(connectionIndex, connections.count - 1)]
    }

    func releaseDelayedOpen() {
        isReleased = true
    }
}

@MainActor
private final class FakeTerminalLifecycleTarget: AgentFeedTerminalLifecycleHandling {
    var events: [String] = []

    func abandonTerminal(_ reason: AgentFeedTerminalAbandonmentReason) -> Task<Void, Never>? {
        events.append("abandon:\(reason.rawValue)")
        return nil
    }

    func interruptTerminal(_ interruption: AgentFeedTerminalInterruption) {
        switch interruption {
        case .background:
            events.append("interrupt:background")
        case .transportLoss:
            events.append("interrupt:transport-loss")
        }
    }

    func teardown() -> Task<Void, Never>? {
        events.append("teardown")
        return nil
    }
}

private enum TestTerminalError: Error {
    case attachFailed
    case sendFailed
    case streamFailed
}

private final class FakeTerminalConnection: AgentFeedTerminalConnection, @unchecked Sendable {
    private let lock = NSLock()
    private let continuation: AsyncThrowingStream<PtySessionEvent, Error>.Continuation
    private let stream: AsyncThrowingStream<PtySessionEvent, Error>
    private var detachCountStorage = 0

    let identity: AgentFeedTerminalConnectionIdentity

    init(sessionName: String = "agent-resume-claude-a4cdd7b8-3f9a-4d80-bc72-5f4aab6f39e1", pid: UInt32 = 4100) {
        identity = AgentFeedTerminalConnectionIdentity(sessionName: sessionName, pid: pid)
        var continuation: AsyncThrowingStream<PtySessionEvent, Error>.Continuation!
        stream = AsyncThrowingStream { continuation = $0 }
        self.continuation = continuation
    }

    var detachCount: Int {
        lock.withLock { detachCountStorage }
    }

    func events() -> AsyncThrowingStream<PtySessionEvent, Error> {
        stream
    }

    func sendInput(_ data: Data) async throws {}
    func resize(columns: UInt32, rows: UInt32) async throws {}

    func detach() async throws {
        lock.withLock { detachCountStorage += 1 }
        continuation.finish()
    }

    func yield(_ event: PtySessionEvent) {
        continuation.yield(event)
    }

    func fail(_ error: Error) {
        continuation.finish(throwing: error)
    }
}
