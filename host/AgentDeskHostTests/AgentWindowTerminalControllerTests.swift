import AgentDeskWire
import AgentPanel
import Foundation
import PtyClientSwift
import PtyTerminalSession
import Testing

@testable import AgentDeskHost

@MainActor
struct AgentWindowTerminalControllerTests {
    private let firstContext = AgentPanelTerminalContext(
        projectPath: "/Users/dev/project-a",
        source: .claude,
        sessionID: "a4cdd7b8-3f9a-4d80-bc72-5f4aab6f39e1"
    )
    private let secondContext = AgentPanelTerminalContext(
        projectPath: "/Users/dev/project-b",
        source: .codex,
        sessionID: "5315800f-fab6-42ed-a80f-a622f563b57a"
    )

    @Test func exactOpenAttachesBeforeAcknowledgementAndReportsReadyOnce() async throws {
        let endpoint = FakeAgentWindowTerminalEndpoint()
        let attacher = FakeAgentWindowTerminalAttacher()
        let status = AgentWindowTerminalStatusRecorder()
        let layout = AgentWindowTerminalLayoutRecorder()
        let controller = AgentWindowTerminalController(
            endpoint: endpoint,
            attacher: attacher,
            setTerminalOpen: { layout.values.append($0) },
            deliverStatus: { status.messages.append($0) }
        )
        endpoint.isContentBound = { controller.contentView.isBound }
        endpoint.completeOpen(
            requestID: "request-1",
            with: .ready(ready(requestID: "request-1", context: firstContext))
        )

        controller.handle(.open(requestID: "request-1", context: firstContext))
        controller.handle(.open(requestID: "request-1", context: firstContext))
        try await waitUntil { status.messages.count == 1 }

        #expect(endpoint.openRequests == [open(requestID: "request-1", context: firstContext)])
        #expect(attacher.requests.map(\.sessionName) == [ptyName(for: firstContext)])
        #expect(endpoint.acknowledgements == [AgentTerminalAttachedAck(
            requestID: "request-1",
            context: wireContext(firstContext),
            ptySessionName: ptyName(for: firstContext)
        )])
        #expect(endpoint.contentWasBoundAtAcknowledgement == [true])
        #expect(status.messages == [.ready(ready(requestID: "request-1", context: firstContext))])
        #expect(layout.values == [true])
        #expect(controller.stateForTesting == .ready(
            requestID: "request-1",
            context: wireContext(firstContext),
            ptySessionName: ptyName(for: firstContext)
        ))
    }

    @Test func staleOpenCompletionCannotAttachOrReportReadyAfterContextReplacement() async throws {
        let endpoint = FakeAgentWindowTerminalEndpoint()
        endpoint.suspendedRequestIDs = ["request-old", "request-new"]
        let attacher = FakeAgentWindowTerminalAttacher()
        let status = AgentWindowTerminalStatusRecorder()
        let controller = AgentWindowTerminalController(
            endpoint: endpoint,
            attacher: attacher,
            setTerminalOpen: { _ in },
            deliverStatus: { status.messages.append($0) }
        )

        controller.handle(.open(requestID: "request-old", context: firstContext))
        try await waitUntil { endpoint.openRequests.count == 1 }
        #expect(controller.stateForTesting == .loading(
            requestID: "request-old",
            context: wireContext(firstContext)
        ))
        controller.handle(.open(requestID: "request-new", context: secondContext))
        try await waitUntil { endpoint.openRequests.count == 2 }

        endpoint.resumeOpen(
            requestID: "request-new",
            with: .ready(ready(requestID: "request-new", context: secondContext))
        )
        try await waitUntil { status.messages.count == 1 }
        endpoint.resumeOpen(
            requestID: "request-old",
            with: .ready(ready(requestID: "request-old", context: firstContext))
        )
        try await Task.sleep(for: .milliseconds(30))

        #expect(attacher.requests.map(\.sessionName) == [ptyName(for: secondContext)])
        #expect(status.messages == [.ready(ready(requestID: "request-new", context: secondContext))])
        #expect(endpoint.closeMessages.contains(AgentTerminalClose(
            requestID: "request-old",
            context: wireContext(firstContext),
            ptySessionName: nil,
            reason: "context-replaced"
        )))
    }

    @Test func staleAttachCompletionDetachesWithoutBindingOrReportingReady() async throws {
        let endpoint = FakeAgentWindowTerminalEndpoint()
        let attacher = FakeAgentWindowTerminalAttacher()
        let status = AgentWindowTerminalStatusRecorder()
        let controller = AgentWindowTerminalController(
            endpoint: endpoint,
            attacher: attacher,
            setTerminalOpen: { _ in },
            deliverStatus: { status.messages.append($0) }
        )
        let oldPTYName = ptyName(for: firstContext)
        attacher.suspendedSessionNames = [oldPTYName]
        endpoint.completeOpen(
            requestID: "request-old",
            with: .ready(ready(requestID: "request-old", context: firstContext))
        )
        endpoint.completeOpen(
            requestID: "request-new",
            with: .ready(ready(requestID: "request-new", context: secondContext))
        )

        controller.handle(.open(requestID: "request-old", context: firstContext))
        try await waitUntil { attacher.requests.count == 1 }
        controller.handle(.open(requestID: "request-new", context: secondContext))
        try await waitUntil { status.messages.count == 1 }
        attacher.resumeAttach(sessionName: oldPTYName)
        try await waitUntil { attacher.connections[oldPTYName]?.detachCount == 1 }

        #expect(endpoint.acknowledgements == [AgentTerminalAttachedAck(
            requestID: "request-new",
            context: wireContext(secondContext),
            ptySessionName: ptyName(for: secondContext)
        )])
        #expect(status.messages == [.ready(ready(
            requestID: "request-new",
            context: secondContext
        ))])
        #expect(controller.stateForTesting == .ready(
            requestID: "request-new",
            context: wireContext(secondContext),
            ptySessionName: ptyName(for: secondContext)
        ))
    }

    @Test func contextReplacementWaitsForBlockedAcknowledgementBeforeClosingAndOpening() async throws {
        let endpoint = FakeAgentWindowTerminalEndpoint()
        let attacher = FakeAgentWindowTerminalAttacher()
        let status = AgentWindowTerminalStatusRecorder()
        let controller = AgentWindowTerminalController(
            endpoint: endpoint,
            attacher: attacher,
            acknowledgementCloseGrace: .seconds(5),
            setTerminalOpen: { _ in },
            deliverStatus: { status.messages.append($0) }
        )
        endpoint.suspendedAcknowledgementRequestIDs = ["request-old"]
        endpoint.completeOpen(
            requestID: "request-old",
            with: .ready(ready(requestID: "request-old", context: firstContext))
        )
        endpoint.completeOpen(
            requestID: "request-new",
            with: .ready(ready(requestID: "request-new", context: secondContext))
        )

        controller.handle(.open(requestID: "request-old", context: firstContext))
        try await waitUntil { endpoint.acknowledgementStarts.count == 1 }
        #expect(controller.stateForTesting == .acknowledging(
            requestID: "request-old",
            context: wireContext(firstContext),
            ptySessionName: ptyName(for: firstContext)
        ))

        controller.handle(.open(requestID: "request-new", context: secondContext))
        try await waitUntil { attacher.connections[ptyName(for: firstContext)]?.detachCount == 1 }
        try await Task.sleep(for: .milliseconds(30))

        #expect(endpoint.openRequests == [open(requestID: "request-old", context: firstContext)])
        #expect(endpoint.closeMessages.isEmpty)
        #expect(status.messages.isEmpty)
        #expect(controller.contentView.isBound == false)

        endpoint.resumeAcknowledgement(requestID: "request-old")
        try await waitUntil { status.messages.count == 1 }

        let oldClose = AgentTerminalClose(
            requestID: "request-old",
            context: wireContext(firstContext),
            ptySessionName: ptyName(for: firstContext),
            reason: "context-replaced"
        )
        #expect(endpoint.acknowledgements == [
            AgentTerminalAttachedAck(
                requestID: "request-old",
                context: wireContext(firstContext),
                ptySessionName: ptyName(for: firstContext)
            ),
            AgentTerminalAttachedAck(
                requestID: "request-new",
                context: wireContext(secondContext),
                ptySessionName: ptyName(for: secondContext)
            ),
        ])
        #expect(endpoint.closeMessages == [oldClose])
        #expect(endpoint.committedEvents == [
            "ack:request-old",
            "close:request-old",
            "ack:request-new",
        ])
        #expect(attacher.requests.map(\.sessionName) == [
            ptyName(for: firstContext),
            ptyName(for: secondContext),
        ])
        #expect(status.messages == [.ready(ready(
            requestID: "request-new",
            context: secondContext
        ))])
        #expect(controller.contentView.isBound)
        #expect(controller.stateForTesting == .ready(
            requestID: "request-new",
            context: wireContext(secondContext),
            ptySessionName: ptyName(for: secondContext)
        ))
    }

    @Test func closeThenOpenWaitsForDurableOldCloseBarrier() async throws {
        let endpoint = FakeAgentWindowTerminalEndpoint()
        let attacher = FakeAgentWindowTerminalAttacher()
        let status = AgentWindowTerminalStatusRecorder()
        let controller = AgentWindowTerminalController(
            endpoint: endpoint,
            attacher: attacher,
            acknowledgementCloseGrace: .seconds(5),
            setTerminalOpen: { _ in },
            deliverStatus: { status.messages.append($0) }
        )
        endpoint.suspendedAcknowledgementRequestIDs = ["request-old"]
        endpoint.completeOpen(
            requestID: "request-old",
            with: .ready(ready(requestID: "request-old", context: firstContext))
        )
        endpoint.completeOpen(
            requestID: "request-new",
            with: .ready(ready(requestID: "request-new", context: secondContext))
        )

        controller.handle(.open(requestID: "request-old", context: firstContext))
        try await waitUntil { endpoint.acknowledgementStarts.count == 1 }
        let oldConnection = attacher.connections[ptyName(for: firstContext)]

        controller.handle(.close(requestID: "request-old", context: firstContext))
        controller.handle(.open(requestID: "request-new", context: secondContext))
        try await waitUntil { oldConnection?.detachCount == 1 }
        try await Task.sleep(for: .milliseconds(30))

        #expect(endpoint.openRequests == [open(requestID: "request-old", context: firstContext)])
        #expect(endpoint.closeMessages.isEmpty)
        #expect(attacher.requests.map(\.sessionName) == [ptyName(for: firstContext)])
        #expect(status.messages.isEmpty)
        #expect(controller.contentView.isBound == false)

        endpoint.resumeAcknowledgement(requestID: "request-old")
        try await waitUntil { status.messages.count == 1 }

        #expect(endpoint.committedEvents == [
            "ack:request-old",
            "close:request-old",
            "ack:request-new",
        ])
        #expect(endpoint.closeMessages == [AgentTerminalClose(
            requestID: "request-old",
            context: wireContext(firstContext),
            ptySessionName: ptyName(for: firstContext),
            reason: "user-close"
        )])
        #expect(status.messages == [.ready(ready(
            requestID: "request-new",
            context: secondContext
        ))])
        #expect(attacher.connections[ptyName(for: secondContext)]?.detachCount == 0)
        #expect(controller.contentView.isBound)
        #expect(controller.stateForTesting == .ready(
            requestID: "request-new",
            context: wireContext(secondContext),
            ptySessionName: ptyName(for: secondContext)
        ))
    }

    @Test func closeForPendingOpenCannotBeOvertakenByOldCloseBarrier() async throws {
        let endpoint = FakeAgentWindowTerminalEndpoint()
        let attacher = FakeAgentWindowTerminalAttacher()
        let status = AgentWindowTerminalStatusRecorder()
        let controller = AgentWindowTerminalController(
            endpoint: endpoint,
            attacher: attacher,
            acknowledgementCloseGrace: .seconds(5),
            setTerminalOpen: { _ in },
            deliverStatus: { status.messages.append($0) }
        )
        endpoint.suspendedAcknowledgementRequestIDs = ["request-old"]
        endpoint.completeOpen(
            requestID: "request-old",
            with: .ready(ready(requestID: "request-old", context: firstContext))
        )
        endpoint.completeOpen(
            requestID: "request-new",
            with: .ready(ready(requestID: "request-new", context: secondContext))
        )

        controller.handle(.open(requestID: "request-old", context: firstContext))
        try await waitUntil { endpoint.acknowledgementStarts.count == 1 }
        controller.handle(.close(requestID: "request-old", context: firstContext))
        controller.handle(.open(requestID: "request-new", context: secondContext))
        controller.handle(.close(requestID: "request-new", context: secondContext))

        endpoint.resumeAcknowledgement(requestID: "request-old")
        try await waitUntil { endpoint.closeMessages.count == 1 }
        try await Task.sleep(for: .milliseconds(30))

        #expect(endpoint.openRequests == [open(requestID: "request-old", context: firstContext)])
        #expect(endpoint.committedEvents == ["ack:request-old", "close:request-old"])
        #expect(attacher.requests.map(\.sessionName) == [ptyName(for: firstContext)])
        #expect(status.messages.isEmpty)
        #expect(controller.contentView.isBound == false)
        #expect(controller.stateForTesting == .idle)
    }

    @Test func neverResolvingAcknowledgementIsSupersededByBoundedClose() async throws {
        let endpoint = FakeAgentWindowTerminalEndpoint()
        let attacher = FakeAgentWindowTerminalAttacher()
        let status = AgentWindowTerminalStatusRecorder()
        let controller = AgentWindowTerminalController(
            endpoint: endpoint,
            attacher: attacher,
            acknowledgementCloseGrace: .milliseconds(20),
            setTerminalOpen: { _ in },
            deliverStatus: { status.messages.append($0) }
        )
        endpoint.suspendedAcknowledgementRequestIDs = ["request-stalled"]
        endpoint.completeOpen(
            requestID: "request-stalled",
            with: .ready(ready(requestID: "request-stalled", context: firstContext))
        )

        controller.handle(.open(requestID: "request-stalled", context: firstContext))
        try await waitUntil { endpoint.acknowledgementStarts.count == 1 }
        let oldConnection = attacher.connections[ptyName(for: firstContext)]

        controller.handle(.close(requestID: "request-stalled", context: firstContext))
        try await waitUntil { endpoint.closeMessages.count == 1 }

        #expect(endpoint.acknowledgements.isEmpty)
        #expect(endpoint.closeMessages == [AgentTerminalClose(
            requestID: "request-stalled",
            context: wireContext(firstContext),
            ptySessionName: ptyName(for: firstContext),
            reason: "user-close"
        )])
        #expect(oldConnection?.detachCount == 1)
        #expect(controller.contentView.isBound == false)
        #expect(status.messages.isEmpty)
        #expect(controller.stateForTesting == .idle)

        endpoint.resumeAcknowledgement(requestID: "request-stalled")
        oldConnection?.yield(.exited(41))
        try await Task.sleep(for: .milliseconds(30))

        #expect(endpoint.acknowledgements.isEmpty)
        #expect(endpoint.terminalEnds.isEmpty)
        #expect(endpoint.committedEvents == ["close:request-stalled"])
        #expect(status.messages.isEmpty)
    }

    @Test func typedLaunchErrorIsReportedWithoutOpeningNativeTerminal() async throws {
        let endpoint = FakeAgentWindowTerminalEndpoint()
        let status = AgentWindowTerminalStatusRecorder()
        let layout = AgentWindowTerminalLayoutRecorder()
        let controller = AgentWindowTerminalController(
            endpoint: endpoint,
            attacher: FakeAgentWindowTerminalAttacher(),
            setTerminalOpen: { layout.values.append($0) },
            deliverStatus: { status.messages.append($0) }
        )
        let error = AgentTerminalError(
            requestID: "request-error",
            context: wireContext(firstContext),
            code: .activeElsewhere
        )
        endpoint.completeOpen(requestID: "request-error", with: .error(error))

        controller.handle(.open(requestID: "request-error", context: firstContext))
        try await waitUntil { status.messages.count == 1 }

        #expect(status.messages == [.error(error)])
        #expect(layout.values.isEmpty)
        #expect(controller.stateForTesting == .idle)
    }

    @Test func typedNaturalExitClosesContentAndReportsExactStatus() async throws {
        let endpoint = FakeAgentWindowTerminalEndpoint()
        let attacher = FakeAgentWindowTerminalAttacher()
        let status = AgentWindowTerminalStatusRecorder()
        let layout = AgentWindowTerminalLayoutRecorder()
        let controller = AgentWindowTerminalController(
            endpoint: endpoint,
            attacher: attacher,
            setTerminalOpen: { layout.values.append($0) },
            deliverStatus: { status.messages.append($0) }
        )
        endpoint.completeOpen(
            requestID: "request-exit",
            with: .ready(ready(requestID: "request-exit", context: firstContext))
        )
        controller.handle(.open(requestID: "request-exit", context: firstContext))
        try await waitUntil { status.messages.count == 1 }

        attacher.connections[ptyName(for: firstContext)]?.yield(.exited(17))
        try await waitUntil { status.messages.count == 2 }

        let ended = AgentTerminalEnded(
            requestID: "request-exit",
            context: wireContext(firstContext),
            ptySessionName: ptyName(for: firstContext),
            exitStatus: 17
        )
        #expect(endpoint.terminalEnds == [ended])
        #expect(status.messages == [
            .ready(ready(requestID: "request-exit", context: firstContext)),
            .ended(ended),
        ])
        #expect(layout.values == [true, false])
        #expect(controller.contentView.isBound == false)
        #expect(controller.stateForTesting == .idle)
    }

    @Test func staleNaturalExitAfterReplacementCannotEndCurrentBinding() async throws {
        let endpoint = FakeAgentWindowTerminalEndpoint()
        let attacher = FakeAgentWindowTerminalAttacher()
        let status = AgentWindowTerminalStatusRecorder()
        let controller = AgentWindowTerminalController(
            endpoint: endpoint,
            attacher: attacher,
            setTerminalOpen: { _ in },
            deliverStatus: { status.messages.append($0) }
        )
        endpoint.completeOpen(
            requestID: "request-old",
            with: .ready(ready(requestID: "request-old", context: firstContext))
        )
        endpoint.completeOpen(
            requestID: "request-new",
            with: .ready(ready(requestID: "request-new", context: secondContext))
        )

        controller.handle(.open(requestID: "request-old", context: firstContext))
        try await waitUntil { status.messages.count == 1 }
        let staleConnection = attacher.connections[ptyName(for: firstContext)]
        controller.handle(.open(requestID: "request-new", context: secondContext))
        try await waitUntil { status.messages.count == 2 }
        staleConnection?.yield(.exited(23))
        try await Task.sleep(for: .milliseconds(30))

        #expect(endpoint.terminalEnds.isEmpty)
        #expect(status.messages == [
            .ready(ready(requestID: "request-old", context: firstContext)),
            .ready(ready(requestID: "request-new", context: secondContext)),
        ])
        #expect(controller.stateForTesting == .ready(
            requestID: "request-new",
            context: wireContext(secondContext),
            ptySessionName: ptyName(for: secondContext)
        ))
    }

    @Test func explicitUserCloseWaitsForBlockedAckAndNeverSynthesizesEnded() async throws {
        let endpoint = FakeAgentWindowTerminalEndpoint()
        let attacher = FakeAgentWindowTerminalAttacher()
        let status = AgentWindowTerminalStatusRecorder()
        let layout = AgentWindowTerminalLayoutRecorder()
        let controller = AgentWindowTerminalController(
            endpoint: endpoint,
            attacher: attacher,
            acknowledgementCloseGrace: .seconds(5),
            setTerminalOpen: { layout.values.append($0) },
            deliverStatus: { status.messages.append($0) }
        )
        endpoint.completeOpen(
            requestID: "request-close",
            with: .ready(ready(requestID: "request-close", context: firstContext))
        )
        endpoint.suspendedAcknowledgementRequestIDs = ["request-close"]
        controller.handle(.open(requestID: "request-close", context: firstContext))
        try await waitUntil { endpoint.acknowledgementStarts.count == 1 }
        let oldConnection = attacher.connections[ptyName(for: firstContext)]

        controller.handle(.close(requestID: "request-close", context: firstContext))
        try await waitUntil { oldConnection?.detachCount == 1 }
        try await Task.sleep(for: .milliseconds(30))
        #expect(endpoint.closeMessages.isEmpty)

        endpoint.resumeAcknowledgement(requestID: "request-close")
        try await waitUntil { endpoint.closeMessages.count == 1 }
        oldConnection?.yield(.exited(31))
        try await Task.sleep(for: .milliseconds(30))

        let close = AgentTerminalClose(
            requestID: "request-close",
            context: wireContext(firstContext),
            ptySessionName: ptyName(for: firstContext),
            reason: "user-close"
        )
        #expect(endpoint.closeMessages == [close])
        #expect(endpoint.terminalEnds.isEmpty)
        #expect(status.messages.isEmpty)
        #expect(layout.values.isEmpty)
        #expect(controller.contentView.isBound == false)
        #expect(controller.stateForTesting == .idle)
    }

    @Test func contextEndedClosesExactBindingWithoutSyntheticEnded() async throws {
        let endpoint = FakeAgentWindowTerminalEndpoint()
        let attacher = FakeAgentWindowTerminalAttacher()
        let status = AgentWindowTerminalStatusRecorder()
        let layout = AgentWindowTerminalLayoutRecorder()
        let controller = AgentWindowTerminalController(
            endpoint: endpoint,
            attacher: attacher,
            setTerminalOpen: { layout.values.append($0) },
            deliverStatus: { status.messages.append($0) }
        )
        endpoint.completeOpen(
            requestID: "request-ended-context",
            with: .ready(ready(requestID: "request-ended-context", context: firstContext))
        )
        controller.handle(.open(requestID: "request-ended-context", context: firstContext))
        try await waitUntil { status.messages.count == 1 }

        controller.handle(.contextEnded(
            requestID: "request-ended-context",
            context: firstContext
        ))
        try await waitUntil { endpoint.closeMessages.count == 1 }

        #expect(endpoint.closeMessages == [AgentTerminalClose(
            requestID: "request-ended-context",
            context: wireContext(firstContext),
            ptySessionName: ptyName(for: firstContext),
            reason: "context-ended"
        )])
        #expect(endpoint.terminalEnds.isEmpty)
        #expect(status.messages == [.ready(ready(
            requestID: "request-ended-context",
            context: firstContext
        ))])
        #expect(layout.values == [true, false])
        #expect(controller.contentView.isBound == false)
        #expect(controller.stateForTesting == .idle)
    }

    @Test func lifecycleCloseKillsExactlyOnceAcrossRepeatedWindowTeardownSignals() async throws {
        let endpoint = FakeAgentWindowTerminalEndpoint()
        let attacher = FakeAgentWindowTerminalAttacher()
        let status = AgentWindowTerminalStatusRecorder()
        let layout = AgentWindowTerminalLayoutRecorder()
        let controller = AgentWindowTerminalController(
            endpoint: endpoint,
            attacher: attacher,
            setTerminalOpen: { layout.values.append($0) },
            deliverStatus: { status.messages.append($0) }
        )
        endpoint.completeOpen(
            requestID: "request-lifecycle",
            with: .ready(ready(requestID: "request-lifecycle", context: firstContext))
        )
        controller.handle(.open(requestID: "request-lifecycle", context: firstContext))
        try await waitUntil { status.messages.count == 1 }
        let connection = attacher.connections[ptyName(for: firstContext)]

        let hideClose = controller.beginExplicitClose(reason: .windowHidden)
        let titlebarClose = controller.beginExplicitClose(reason: .windowShouldClose)
        await hideClose?.value
        await titlebarClose?.value

        #expect(endpoint.closeMessages == [AgentTerminalClose(
            requestID: "request-lifecycle",
            context: wireContext(firstContext),
            ptySessionName: ptyName(for: firstContext),
            reason: "window-hidden"
        )])
        #expect(connection?.detachCount == 1)
        #expect(endpoint.terminalEnds.isEmpty)
        #expect(layout.values == [true, false])
        #expect(controller.contentView.isBound == false)
        #expect(controller.stateForTesting == .idle)
    }

    @Test func lifecycleCloseFencesSuspendedOpenCompletionFromBindingOrReady() async throws {
        let endpoint = FakeAgentWindowTerminalEndpoint()
        endpoint.suspendedRequestIDs = ["request-stale-lifecycle"]
        let attacher = FakeAgentWindowTerminalAttacher()
        let status = AgentWindowTerminalStatusRecorder()
        let controller = AgentWindowTerminalController(
            endpoint: endpoint,
            attacher: attacher,
            setTerminalOpen: { _ in },
            deliverStatus: { status.messages.append($0) }
        )

        controller.handle(.open(requestID: "request-stale-lifecycle", context: firstContext))
        try await waitUntil { endpoint.openRequests.count == 1 }
        let close = controller.beginExplicitClose(reason: .appTermination)
        await close?.value
        endpoint.resumeOpen(
            requestID: "request-stale-lifecycle",
            with: .ready(ready(requestID: "request-stale-lifecycle", context: firstContext))
        )
        try await Task.sleep(for: .milliseconds(30))

        #expect(endpoint.closeMessages == [AgentTerminalClose(
            requestID: "request-stale-lifecycle",
            context: wireContext(firstContext),
            ptySessionName: nil,
            reason: "app-termination"
        )])
        #expect(attacher.requests.isEmpty)
        #expect(status.messages.isEmpty)
        #expect(controller.contentView.isBound == false)
        #expect(controller.stateForTesting == .idle)
    }

    @Test func socketLossDetachesLocallyWithoutExplicitKill() async throws {
        let endpoint = FakeAgentWindowTerminalEndpoint()
        let attacher = FakeAgentWindowTerminalAttacher()
        let layout = AgentWindowTerminalLayoutRecorder()
        let controller = AgentWindowTerminalController(
            endpoint: endpoint,
            attacher: attacher,
            setTerminalOpen: { layout.values.append($0) },
            deliverStatus: { _ in }
        )
        endpoint.completeOpen(
            requestID: "request-socket-loss",
            with: .ready(ready(requestID: "request-socket-loss", context: firstContext))
        )
        controller.handle(.open(requestID: "request-socket-loss", context: firstContext))
        try await waitUntil {
            controller.stateForTesting == .ready(
                requestID: "request-socket-loss",
                context: wireContext(firstContext),
                ptySessionName: ptyName(for: firstContext)
            )
        }
        let connection = try #require(attacher.connections[ptyName(for: firstContext)])

        connection.fail(TestTerminalConnectionError.socketLost)
        try await waitUntil {
            controller.stateForTesting == .idle && connection.detachCount == 1
        }

        #expect(endpoint.closeMessages.isEmpty)
        #expect(endpoint.terminalEnds.isEmpty)
        #expect(connection.detachCount == 1)
        #expect(layout.values == [true, false])
        #expect(controller.contentView.isBound == false)
    }

    @Test func socketLossThenAppTerminationConsumesExactCloseOnce() async throws {
        let (controller, endpoint, connection) = try await socketLostTerminal(
            requestID: "request-loss-app"
        )

        let firstClose = controller.beginExplicitClose(reason: .appTermination)
        let repeatedClose = controller.beginExplicitClose(reason: .appTermination)
        await firstClose?.value
        await repeatedClose?.value

        #expect(endpoint.closeMessages == [AgentTerminalClose(
            requestID: "request-loss-app",
            context: wireContext(firstContext),
            ptySessionName: ptyName(for: firstContext),
            reason: "app-termination"
        )])
        #expect(endpoint.terminalEnds.isEmpty)
        #expect(connection.detachCount == 1)
        #expect(controller.contentView.isBound == false)
    }

    @Test func socketLossThenWindowHideConsumesExactCloseOnce() async throws {
        let (controller, endpoint, connection) = try await socketLostTerminal(
            requestID: "request-loss-hide"
        )

        let hideClose = controller.beginExplicitClose(reason: .windowHidden)
        let repeatedSignal = controller.beginExplicitClose(reason: .windowShouldClose)
        await hideClose?.value
        await repeatedSignal?.value

        #expect(endpoint.closeMessages == [AgentTerminalClose(
            requestID: "request-loss-hide",
            context: wireContext(firstContext),
            ptySessionName: ptyName(for: firstContext),
            reason: "window-hidden"
        )])
        #expect(endpoint.terminalEnds.isEmpty)
        #expect(connection.detachCount == 1)
        #expect(controller.contentView.isBound == false)
    }

    @Test func socketLossThenContextEndedConsumesExactCloseOnce() async throws {
        let (controller, endpoint, connection) = try await socketLostTerminal(
            requestID: "request-loss-context"
        )

        controller.handle(.contextEnded(
            requestID: "request-loss-context",
            context: firstContext
        ))
        controller.handle(.contextEnded(
            requestID: "request-loss-context",
            context: firstContext
        ))
        try await waitUntil { endpoint.closeMessages.count == 1 }

        #expect(endpoint.closeMessages == [AgentTerminalClose(
            requestID: "request-loss-context",
            context: wireContext(firstContext),
            ptySessionName: ptyName(for: firstContext),
            reason: "context-ended"
        )])
        #expect(endpoint.terminalEnds.isEmpty)
        #expect(connection.detachCount == 1)
        #expect(controller.contentView.isBound == false)
    }

    @Test func socketLossRecoveryTransfersDifferentRequestIDBeforeReadyAndClose() async throws {
        let endpoint = FakeAgentWindowTerminalEndpoint()
        let attacher = FakeAgentWindowTerminalAttacher()
        let status = AgentWindowTerminalStatusRecorder()
        let controller = AgentWindowTerminalController(
            endpoint: endpoint,
            attacher: attacher,
            setTerminalOpen: { _ in },
            deliverStatus: { status.messages.append($0) }
        )
        endpoint.completeOpen(
            requestID: "request-old",
            with: .ready(ready(requestID: "request-old", context: firstContext))
        )
        endpoint.completeOpen(
            requestID: "request-new",
            with: .ready(ready(requestID: "request-new", context: firstContext))
        )
        controller.handle(.open(requestID: "request-old", context: firstContext))
        try await waitUntil { status.messages.count == 1 }
        let oldConnection = try #require(attacher.connections[ptyName(for: firstContext)])

        oldConnection.fail(TestTerminalConnectionError.socketLost)
        try await waitUntil { !controller.contentView.isBound }
        controller.handle(.open(requestID: "request-new", context: firstContext))
        try await waitUntil { status.messages.count == 2 }

        #expect(endpoint.transferRequests == [FakeTerminalRequestTransfer(
            oldRequestID: "request-old",
            open: open(requestID: "request-new", context: firstContext)
        )])
        #expect(endpoint.openRequests == [open(requestID: "request-old", context: firstContext)])
        #expect(endpoint.acknowledgements.map(\.requestID) == ["request-old", "request-new"])
        #expect(status.messages == [
            .ready(ready(requestID: "request-old", context: firstContext)),
            .ready(ready(requestID: "request-new", context: firstContext)),
        ])

        await endpoint.sendPush(.ready(ready(requestID: "request-old", context: firstContext)))
        try await Task.sleep(for: .milliseconds(30))
        #expect(status.messages.count == 2)

        await controller.beginExplicitClose(reason: .windowHidden)?.value
        #expect(endpoint.closeMessages == [AgentTerminalClose(
            requestID: "request-new",
            context: wireContext(firstContext),
            ptySessionName: ptyName(for: firstContext),
            reason: "window-hidden"
        )])
        #expect(oldConnection.detachCount == 1)
        #expect(controller.contentView.isBound == false)
    }

    @Test func socketLossTransferLeavesOneKillAuthorityAndNoOldReady() async throws {
        let coordinator = WindowTransferCoordinator()
        let endpoint = AgentSessionTerminalEndpoint(
            coordinator: coordinator,
            platform: .macOS,
            requestNamespace: "macos-window",
            tombstoneLimit: 8
        )
        let attacher = FakeAgentWindowTerminalAttacher()
        let status = AgentWindowTerminalStatusRecorder()
        let controller = AgentWindowTerminalController(
            endpoint: LocalAgentSessionTerminalEndpointRouter(endpoint: endpoint),
            attacher: attacher,
            setTerminalOpen: { _ in },
            deliverStatus: { status.messages.append($0) }
        )
        controller.handle(.open(requestID: "request-old", context: firstContext))
        try await waitUntil { status.messages.count == 1 }
        let oldConnection = try #require(attacher.connections[ptyName(for: firstContext)])

        oldConnection.fail(TestTerminalConnectionError.socketLost)
        try await waitUntil { !controller.contentView.isBound }
        controller.handle(.open(requestID: "request-new", context: firstContext))
        try await waitUntil { status.messages.count == 2 }

        let oldResponse = await endpoint.openLocal(open(
            requestID: "request-old",
            context: firstContext
        ))
        #expect(oldResponse == .error(AgentTerminalError(
            requestID: "request-old",
            context: wireContext(firstContext),
            ptySessionName: nil,
            code: .sessionEnded
        )))
        await endpoint.handle(.open(open(
            requestID: "request-old",
            context: firstContext
        )))
        try await Task.sleep(for: .milliseconds(30))
        #expect(status.messages == [
            .ready(ready(requestID: "request-old", context: firstContext)),
            .ready(ready(requestID: "request-new", context: firstContext)),
        ])

        await controller.beginExplicitClose(reason: .appTermination)?.value

        #expect(await coordinator.killCount == 1)
        #expect(await coordinator.activeRequestIDs.isEmpty)
        #expect(await endpoint.stateSnapshot() == AgentSessionTerminalEndpointStateSnapshot(
            activeRequestCount: 0,
            tombstoneRequestIDs: ["request-old", "request-new"]
        ))
        #expect(oldConnection.detachCount == 1)
        #expect(controller.contentView.isBound == false)
    }

    @Test func socketLossRecoveryWithExactRequestIDUsesCachedOpenWithoutTransfer() async throws {
        let endpoint = FakeAgentWindowTerminalEndpoint()
        let attacher = FakeAgentWindowTerminalAttacher()
        let status = AgentWindowTerminalStatusRecorder()
        let controller = AgentWindowTerminalController(
            endpoint: endpoint,
            attacher: attacher,
            setTerminalOpen: { _ in },
            deliverStatus: { status.messages.append($0) }
        )
        endpoint.completeOpen(
            requestID: "request-exact",
            with: .ready(ready(requestID: "request-exact", context: firstContext))
        )
        controller.handle(.open(requestID: "request-exact", context: firstContext))
        try await waitUntil { status.messages.count == 1 }
        let firstConnection = try #require(attacher.connections[ptyName(for: firstContext)])

        firstConnection.fail(TestTerminalConnectionError.socketLost)
        try await waitUntil { !controller.contentView.isBound }
        controller.handle(.open(requestID: "request-exact", context: firstContext))
        try await waitUntil { status.messages.count == 2 }

        #expect(endpoint.transferRequests.isEmpty)
        #expect(endpoint.openRequests == [
            open(requestID: "request-exact", context: firstContext),
            open(requestID: "request-exact", context: firstContext),
        ])
        #expect(controller.stateForTesting == .ready(
            requestID: "request-exact",
            context: wireContext(firstContext),
            ptySessionName: ptyName(for: firstContext)
        ))
    }

    @Test func socketLossContextReplacementClosesOldBeforeOpeningNew() async throws {
        let endpoint = FakeAgentWindowTerminalEndpoint()
        let attacher = FakeAgentWindowTerminalAttacher()
        let status = AgentWindowTerminalStatusRecorder()
        let controller = AgentWindowTerminalController(
            endpoint: endpoint,
            attacher: attacher,
            setTerminalOpen: { _ in },
            deliverStatus: { status.messages.append($0) }
        )
        endpoint.completeOpen(
            requestID: "request-old",
            with: .ready(ready(requestID: "request-old", context: firstContext))
        )
        endpoint.completeOpen(
            requestID: "request-new",
            with: .ready(ready(requestID: "request-new", context: secondContext))
        )
        controller.handle(.open(requestID: "request-old", context: firstContext))
        try await waitUntil { status.messages.count == 1 }
        let oldConnection = try #require(attacher.connections[ptyName(for: firstContext)])

        oldConnection.fail(TestTerminalConnectionError.socketLost)
        try await waitUntil { !controller.contentView.isBound }
        controller.handle(.open(requestID: "request-new", context: secondContext))
        try await waitUntil { status.messages.count == 2 }

        #expect(endpoint.transferRequests.isEmpty)
        #expect(endpoint.committedEvents.suffix(2) == [
            "close:request-old",
            "ack:request-new",
        ])
        #expect(endpoint.closeMessages == [AgentTerminalClose(
            requestID: "request-old",
            context: wireContext(firstContext),
            ptySessionName: ptyName(for: firstContext),
            reason: "context-replaced"
        )])
        #expect(controller.stateForTesting == .ready(
            requestID: "request-new",
            context: wireContext(secondContext),
            ptySessionName: ptyName(for: secondContext)
        ))
    }

    @Test func managerDetachCollapsesWithoutSendingCloseOrDetachingAgain() async throws {
        let endpoint = FakeAgentWindowTerminalEndpoint()
        let attacher = FakeAgentWindowTerminalAttacher()
        let layout = AgentWindowTerminalLayoutRecorder()
        let controller = AgentWindowTerminalController(
            endpoint: endpoint,
            attacher: attacher,
            setTerminalOpen: { layout.values.append($0) },
            deliverStatus: { _ in }
        )
        endpoint.completeOpen(
            requestID: "request-manager-loss",
            with: .ready(ready(requestID: "request-manager-loss", context: firstContext))
        )
        controller.handle(.open(requestID: "request-manager-loss", context: firstContext))
        try await waitUntil { controller.contentView.isBound }
        let connection = try #require(attacher.connections[ptyName(for: firstContext)])

        connection.yield(.detachedByManager(7))
        try await waitUntil { controller.stateForTesting == .idle }

        #expect(endpoint.closeMessages.isEmpty)
        #expect(endpoint.terminalEnds.isEmpty)
        #expect(connection.detachCount == 0)
        #expect(layout.values == [true, false])
        #expect(controller.contentView.isBound == false)
    }

    private func socketLostTerminal(
        requestID: String
    ) async throws -> (
        AgentWindowTerminalController,
        FakeAgentWindowTerminalEndpoint,
        FakeAgentWindowTerminalConnection
    ) {
        let endpoint = FakeAgentWindowTerminalEndpoint()
        let attacher = FakeAgentWindowTerminalAttacher()
        let controller = AgentWindowTerminalController(
            endpoint: endpoint,
            attacher: attacher,
            setTerminalOpen: { _ in },
            deliverStatus: { _ in }
        )
        endpoint.completeOpen(
            requestID: requestID,
            with: .ready(ready(requestID: requestID, context: firstContext))
        )
        controller.handle(.open(requestID: requestID, context: firstContext))
        try await waitUntil { controller.contentView.isBound }
        let connection = try #require(attacher.connections[ptyName(for: firstContext)])

        connection.fail(TestTerminalConnectionError.socketLost)
        try await waitUntil {
            !controller.contentView.isBound && connection.detachCount == 1
        }
        #expect(endpoint.closeMessages.isEmpty)

        return (controller, endpoint, connection)
    }

    private func open(
        requestID: String,
        context: AgentPanelTerminalContext
    ) -> AgentTerminalOpen {
        AgentTerminalOpen(requestID: requestID, context: wireContext(context))
    }

    private func ready(
        requestID: String,
        context: AgentPanelTerminalContext
    ) -> AgentTerminalReady {
        AgentTerminalReady(
            requestID: requestID,
            context: wireContext(context),
            ptySessionName: ptyName(for: context)
        )
    }

    private func wireContext(_ context: AgentPanelTerminalContext) -> AgentResumeTerminalContext {
        AgentResumeTerminalContext(
            projectPath: context.projectPath,
            source: context.source.rawValue,
            harnessSessionID: context.sessionID
        )
    }

    private func ptyName(for context: AgentPanelTerminalContext) -> String {
        "agent-resume-\(context.source.rawValue)-\(context.sessionID)"
    }

    private func waitUntil(
        _ condition: @MainActor @escaping () -> Bool
    ) async throws {
        for _ in 0..<200 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        Issue.record("Timed out waiting for R67 terminal condition")
    }
}

@MainActor
private final class FakeAgentWindowTerminalEndpoint: AgentWindowTerminalEndpointRouting {
    var openRequests: [AgentTerminalOpen] = []
    var acknowledgements: [AgentTerminalAttachedAck] = []
    var closeMessages: [AgentTerminalClose] = []
    var terminalEnds: [AgentTerminalEnded] = []
    var contentWasBoundAtAcknowledgement: [Bool] = []
    var isContentBound: () -> Bool = { false }
    var suspendedRequestIDs: Set<String> = []
    var suspendedAcknowledgementRequestIDs: Set<String> = []
    var acknowledgementStarts: [AgentTerminalAttachedAck] = []
    var committedEvents: [String] = []
    var transferRequests: [FakeTerminalRequestTransfer] = []

    private var completedResponses: [String: AgentTerminalHostMessage] = [:]
    private var continuations: [String: CheckedContinuation<AgentTerminalHostMessage?, Never>] = [:]
    private var acknowledgementGates: [String: FakeAcknowledgementGate] = [:]
    private var push: (@Sendable (AgentTerminalHostMessage) async -> Void)?

    func setPush(_ push: (@Sendable (AgentTerminalHostMessage) async -> Void)?) async {
        self.push = push
    }

    func openLocal(_ open: AgentTerminalOpen) async -> AgentTerminalHostMessage? {
        openRequests.append(open)
        if suspendedRequestIDs.contains(open.requestID) {
            return await withCheckedContinuation { continuation in
                continuations[open.requestID] = continuation
            }
        }
        return completedResponses[open.requestID]
    }

    func transferLocal(
        from oldRequestID: String,
        to open: AgentTerminalOpen
    ) async -> AgentTerminalHostMessage? {
        transferRequests.append(FakeTerminalRequestTransfer(
            oldRequestID: oldRequestID,
            open: open
        ))
        return completedResponses[open.requestID]
    }

    func handle(_ message: AgentTerminalClientMessage) async {
        switch message {
        case .open:
            break
        case .attached(let acknowledgement):
            acknowledgementStarts.append(acknowledgement)
            contentWasBoundAtAcknowledgement.append(isContentBound())
            if suspendedAcknowledgementRequestIDs.contains(acknowledgement.requestID) {
                let gate = FakeAcknowledgementGate()
                acknowledgementGates[acknowledgement.requestID] = gate
                await gate.wait()
                acknowledgementGates.removeValue(forKey: acknowledgement.requestID)
            }
            guard !Task.isCancelled else { return }
            acknowledgements.append(acknowledgement)
            committedEvents.append("ack:\(acknowledgement.requestID)")
        case .close(let close):
            closeMessages.append(close)
            committedEvents.append("close:\(close.requestID)")
        }
    }

    func terminalEnded(
        requestID: String,
        context: AgentResumeTerminalContext,
        ptySessionName: String,
        exitStatus: Int32?
    ) async {
        let ended = AgentTerminalEnded(
            requestID: requestID,
            context: context,
            ptySessionName: ptySessionName,
            exitStatus: exitStatus
        )
        terminalEnds.append(ended)
        await push?(.ended(ended))
    }

    func completeOpen(requestID: String, with response: AgentTerminalHostMessage) {
        completedResponses[requestID] = response
    }

    func resumeOpen(requestID: String, with response: AgentTerminalHostMessage) {
        continuations.removeValue(forKey: requestID)?.resume(returning: response)
    }

    func resumeAcknowledgement(requestID: String) {
        acknowledgementGates.removeValue(forKey: requestID)?.finish()
    }

    func sendPush(_ message: AgentTerminalHostMessage) async {
        await push?(message)
    }
}

private struct FakeTerminalRequestTransfer: Equatable {
    let oldRequestID: String
    let open: AgentTerminalOpen
}

private actor WindowTransferCoordinator: AgentSessionTerminalCoordinating {
    private(set) var activeRequestIDs: Set<String> = []
    private(set) var killCount = 0

    func open(_ request: AgentSessionTerminalOpenRequest) async throws -> AgentSessionTerminalReady {
        activeRequestIDs.insert(request.requestID)
        let identity = try AgentResumeTerminalIdentity(
            source: request.context.source,
            harnessSessionID: request.context.harnessSessionID,
            projectDirectoryPath: request.context.projectPath,
            homeDirectory: URL(fileURLWithPath: "/Users/dev", isDirectory: true),
            fileManager: WindowPermissiveDirectoryFileManager()
        )
        return AgentSessionTerminalReady(
            requestID: request.requestID,
            identity: identity,
            pid: 7001
        )
    }

    func acknowledgeAttachment(requestID: String, ptySessionName: String) async {}

    func transferRequest(
        from oldRequestID: String,
        to newRequestID: String,
        ptySessionName: String
    ) async -> Bool {
        guard activeRequestIDs.remove(oldRequestID) != nil,
              !activeRequestIDs.contains(newRequestID) else {
            return false
        }
        activeRequestIDs.insert(newRequestID)
        return true
    }

    func close(requestID: String, ptySessionName: String?) async {
        guard activeRequestIDs.remove(requestID) != nil else { return }
        killCount += 1
    }
}

private final class WindowPermissiveDirectoryFileManager: FileManager, @unchecked Sendable {
    override func fileExists(
        atPath path: String,
        isDirectory: UnsafeMutablePointer<ObjCBool>?
    ) -> Bool {
        isDirectory?.pointee = true
        return true
    }
}

private final class FakeAcknowledgementGate: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Void, Never>?
    private var isFinished = false

    func wait() async {
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                lock.lock()
                if isFinished {
                    lock.unlock()
                    continuation.resume()
                } else {
                    self.continuation = continuation
                    lock.unlock()
                }
            }
        } onCancel: {
            finish()
        }
    }

    func finish() {
        lock.lock()
        guard !isFinished else {
            lock.unlock()
            return
        }
        isFinished = true
        let continuation = continuation
        self.continuation = nil
        lock.unlock()
        continuation?.resume()
    }
}

@MainActor
private final class FakeAgentWindowTerminalAttacher: AgentWindowTerminalAttaching {
    struct Request: Equatable {
        let sessionName: String
        let columns: UInt32
        let rows: UInt32
    }

    var requests: [Request] = []
    var connections: [String: FakeAgentWindowTerminalConnection] = [:]
    var suspendedSessionNames: Set<String> = []
    private var continuations: [
        String: CheckedContinuation<any PtyTerminalConnection, Never>
    ] = [:]

    func attach(
        sessionName: String,
        columns: UInt32,
        rows: UInt32
    ) async throws -> any PtyTerminalConnection {
        requests.append(Request(sessionName: sessionName, columns: columns, rows: rows))
        let connection = FakeAgentWindowTerminalConnection()
        connections[sessionName] = connection
        if suspendedSessionNames.contains(sessionName) {
            return await withCheckedContinuation { continuation in
                continuations[sessionName] = continuation
            }
        }
        return connection
    }

    func resumeAttach(sessionName: String) {
        guard let connection = connections[sessionName] else { return }
        continuations.removeValue(forKey: sessionName)?.resume(returning: connection)
    }
}

private final class FakeAgentWindowTerminalConnection: PtyTerminalConnection, @unchecked Sendable {
    private let stream: AsyncThrowingStream<PtySessionEvent, Error>
    private let continuation: AsyncThrowingStream<PtySessionEvent, Error>.Continuation
    private(set) var detachCount = 0

    init() {
        let pair = AsyncThrowingStream<PtySessionEvent, Error>.makeStream()
        stream = pair.stream
        continuation = pair.continuation
    }

    func yield(_ event: PtySessionEvent) {
        continuation.yield(event)
    }

    func fail(_ error: Error) {
        continuation.finish(throwing: error)
    }

    func events() -> AsyncThrowingStream<PtySessionEvent, Error> { stream }
    func sendInput(_ data: Data) async throws {}
    func resize(columns: UInt32, rows: UInt32) async throws {}
    func detach() async throws { detachCount += 1 }
}

private enum TestTerminalConnectionError: Error {
    case socketLost
}

@MainActor
private final class AgentWindowTerminalStatusRecorder {
    var messages: [AgentTerminalHostMessage] = []
}

@MainActor
private final class AgentWindowTerminalLayoutRecorder {
    var values: [Bool] = []
}
