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

    @Test func replacingSettledTransportDetachesOldTerminalAndAllowsFreshOpen() async throws {
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

        harness.surface.sendAgentPanelRequest(.terminal(.open(
            requestID: "request-2",
            context: panelContext
        )))
        try await waitUntil { replacementCoordinator.sent.count == 1 }
        replacementCoordinator.yield(.ready(readyPayload(requestID: "request-2")))
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

    private func makeHarness(
        delayedOpen: Bool = false,
        openError: Error? = nil
    ) -> Harness {
        let surface = AgentFeedSurface(panelViewForTesting: UIView())
        let coordinator = FakeAgentTerminalCoordinator()
        let connection = FakeTerminalConnection()
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
    private let connection: FakeTerminalConnection
    private let delayedOpen: Bool
    private let openError: Error?
    private var isReleased = false
    var requests: [AgentFeedTerminalAttachmentRequest] = []

    init(
        connection: FakeTerminalConnection,
        delayedOpen: Bool = false,
        openError: Error? = nil
    ) {
        self.connection = connection
        self.delayedOpen = delayedOpen
        self.openError = openError
    }

    func openAgentFeedTerminal(
        _ request: AgentFeedTerminalAttachmentRequest
    ) async throws -> any AgentFeedTerminalConnection {
        requests.append(request)
        while delayedOpen && !isReleased {
            await Task.yield()
        }
        if let openError { throw openError }
        return connection
    }

    func releaseDelayedOpen() {
        isReleased = true
    }
}

private enum TestTerminalError: Error {
    case attachFailed
    case sendFailed
}

private final class FakeTerminalConnection: AgentFeedTerminalConnection, @unchecked Sendable {
    private let lock = NSLock()
    private let continuation: AsyncThrowingStream<PtySessionEvent, Error>.Continuation
    private let stream: AsyncThrowingStream<PtySessionEvent, Error>
    private var detachCountStorage = 0

    init() {
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
}
