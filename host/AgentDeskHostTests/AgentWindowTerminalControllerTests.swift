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

    func events() -> AsyncThrowingStream<PtySessionEvent, Error> { stream }
    func sendInput(_ data: Data) async throws {}
    func resize(columns: UInt32, rows: UInt32) async throws {}
    func detach() async throws { detachCount += 1 }
}

@MainActor
private final class AgentWindowTerminalStatusRecorder {
    var messages: [AgentTerminalHostMessage] = []
}

@MainActor
private final class AgentWindowTerminalLayoutRecorder {
    var values: [Bool] = []
}
