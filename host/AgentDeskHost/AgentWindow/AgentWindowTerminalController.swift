import AppKit
import AgentDeskWire
import AgentPanel
import Foundation
import PtyClientSwift
import PtyTerminalSession
import PtyTerminalSwiftTerm

enum AgentWindowTerminalExplicitCloseReason: String, Equatable {
    case windowHidden = "window-hidden"
    case windowShouldClose = "window-should-close"
    case appTermination = "app-termination"
}

@MainActor
protocol AgentWindowTerminalControlling: AnyObject {
    var terminalView: NSView { get }
    func handle(_ intent: AgentPanelTerminalIntent)
    @discardableResult
    func beginExplicitClose(
        reason: AgentWindowTerminalExplicitCloseReason
    ) -> Task<Void, Never>?
}

@MainActor
protocol AgentWindowTerminalEndpointRouting: AnyObject {
    func setPush(_ push: (@Sendable (AgentTerminalHostMessage) async -> Void)?) async
    func openLocal(_ open: AgentTerminalOpen) async -> AgentTerminalHostMessage?
    func transferLocal(
        from oldRequestID: String,
        to open: AgentTerminalOpen
    ) async -> AgentTerminalHostMessage?
    func handle(_ message: AgentTerminalClientMessage) async
    func terminalEnded(
        requestID: String,
        context: AgentResumeTerminalContext,
        ptySessionName: String,
        exitStatus: Int32?
    ) async
}

@MainActor
final class LocalAgentSessionTerminalEndpointRouter: AgentWindowTerminalEndpointRouting {
    private let endpoint: AgentSessionTerminalEndpoint

    init(endpoint: AgentSessionTerminalEndpoint) {
        self.endpoint = endpoint
    }

    func setPush(_ push: (@Sendable (AgentTerminalHostMessage) async -> Void)?) async {
        await endpoint.setPush(push)
    }

    func openLocal(_ open: AgentTerminalOpen) async -> AgentTerminalHostMessage? {
        await endpoint.openLocal(open)
    }

    func transferLocal(
        from oldRequestID: String,
        to open: AgentTerminalOpen
    ) async -> AgentTerminalHostMessage? {
        await endpoint.transferLocal(from: oldRequestID, to: open)
    }

    func handle(_ message: AgentTerminalClientMessage) async {
        await endpoint.handle(message)
    }

    func terminalEnded(
        requestID: String,
        context: AgentResumeTerminalContext,
        ptySessionName: String,
        exitStatus: Int32?
    ) async {
        await endpoint.terminalEnded(
            requestID: requestID,
            context: context,
            ptySessionName: ptySessionName,
            exitStatus: exitStatus
        )
    }
}

@MainActor
protocol AgentWindowTerminalAttaching: AnyObject {
    func attach(
        sessionName: String,
        columns: UInt32,
        rows: UInt32
    ) async throws -> any PtyTerminalConnection
}

enum AgentWindowTerminalAttachError: Error, Equatable {
    case sessionUnavailable
    case sessionIdentityMismatch
}

struct AgentWindowOpenedPtyConnection {
    let connection: any PtyTerminalConnection
    let sessionName: String
    let attachment: PtySessionAttachment
}

@MainActor
protocol AgentWindowPtyClientRouting: AnyObject {
    func listSessions() async throws -> [PtySessionSummary]
    func openSession(
        name: String,
        launch: PtySessionLaunch,
        lifetime: PtySessionLifetime,
        columns: UInt32,
        rows: UInt32,
        createIfMissing: Bool,
        clientTitle: String
    ) async throws -> AgentWindowOpenedPtyConnection
}

@MainActor
private final class LiveAgentWindowPtyClientRouter: AgentWindowPtyClientRouting {
    nonisolated(unsafe) private let client: PtyClient

    init(client: PtyClient) {
        self.client = client
    }

    func listSessions() async throws -> [PtySessionSummary] {
        try await client.listSessions()
    }

    func openSession(
        name: String,
        launch: PtySessionLaunch,
        lifetime: PtySessionLifetime,
        columns: UInt32,
        rows: UInt32,
        createIfMissing: Bool,
        clientTitle: String
    ) async throws -> AgentWindowOpenedPtyConnection {
        let connection = try await client.openSession(
            name: name,
            launch: launch,
            lifetime: lifetime,
            columns: columns,
            rows: rows,
            createIfMissing: createIfMissing,
            clientTitle: clientTitle
        )
        return AgentWindowOpenedPtyConnection(
            connection: connection,
            sessionName: connection.sessionName,
            attachment: connection.attachment
        )
    }
}

private final class AgentWindowTerminalConnectionCleanup: @unchecked Sendable {
    private let connection: any PtyTerminalConnection

    init(connection: any PtyTerminalConnection) {
        self.connection = connection
    }

    func detach() async {
        try? await connection.detach()
    }
}

@MainActor
final class PtyClientAgentWindowTerminalAttacher: AgentWindowTerminalAttaching {
    private let client: any AgentWindowPtyClientRouting

    init(client: PtyClient) {
        self.client = LiveAgentWindowPtyClientRouter(client: client)
    }

    init(clientRouter: any AgentWindowPtyClientRouting) {
        self.client = clientRouter
    }

    func attach(
        sessionName: String,
        columns: UInt32,
        rows: UInt32
    ) async throws -> any PtyTerminalConnection {
        let sessions = try await client.listSessions()
        guard let session = sessions.first(where: { $0.name == sessionName }),
              session.state == .running,
              session.lifetime == .leased else {
            throw AgentWindowTerminalAttachError.sessionUnavailable
        }
        let opened = try await client.openSession(
            name: sessionName,
            launch: .shell(cwd: session.cwd, shell: session.shell),
            lifetime: .leased,
            columns: columns,
            rows: rows,
            createIfMissing: false,
            clientTitle: "Agent Panel macOS"
        )
        guard opened.sessionName == session.name,
              opened.attachment.name == session.name,
              opened.attachment.pid == session.pid else {
            let cleanup = AgentWindowTerminalConnectionCleanup(connection: opened.connection)
            await cleanup.detach()
            throw AgentWindowTerminalAttachError.sessionIdentityMismatch
        }
        return opened.connection
    }
}

enum AgentWindowTerminalState: Equatable {
    case idle
    case loading(requestID: String, context: AgentResumeTerminalContext)
    case acknowledging(
        requestID: String,
        context: AgentResumeTerminalContext,
        ptySessionName: String
    )
    case ready(requestID: String, context: AgentResumeTerminalContext, ptySessionName: String)
}

@MainActor
final class AgentWindowTerminalController: NSObject, AgentWindowTerminalControlling,
    PtyTerminalSwiftTermContentViewDelegate
{
    private struct OpenRequest: Equatable {
        let requestID: String
        let context: AgentResumeTerminalContext
    }

    private final class Binding {
        let requestID: String
        let context: AgentResumeTerminalContext
        var ptySessionName: String?
        let generation: UInt64

        init(
            requestID: String,
            context: AgentResumeTerminalContext,
            ptySessionName: String? = nil,
            generation: UInt64
        ) {
            self.requestID = requestID
            self.context = context
            self.ptySessionName = ptySessionName
            self.generation = generation
        }

        func matches(_ request: OpenRequest) -> Bool {
            requestID == request.requestID && context == request.context
        }
    }

    private final class OpenOperation {
        let binding: Binding
        let transferFromRequestID: String?
        var task: Task<Void, Never>?

        init(binding: Binding, transferFromRequestID: String? = nil) {
            self.binding = binding
            self.transferFromRequestID = transferFromRequestID
        }
    }

    @MainActor
    private final class AcknowledgementOperation {
        let binding: Binding
        let ready: AgentTerminalReady
        var task: Task<Void, Never>?

        private var isComplete = false
        private var nextWaiterID: UInt64 = 0
        private var waiters: [UInt64: CheckedContinuation<Bool, Never>] = [:]
        private var timeoutTasks: [UInt64: Task<Void, Never>] = [:]

        init(binding: Binding, ready: AgentTerminalReady) {
            self.binding = binding
            self.ready = ready
        }

        func waitForCompletion(grace: Duration) async -> Bool {
            if isComplete { return true }
            nextWaiterID &+= 1
            let waiterID = nextWaiterID
            return await withCheckedContinuation { continuation in
                waiters[waiterID] = continuation
                timeoutTasks[waiterID] = Task { [weak self] in
                    do {
                        try await Task.sleep(for: grace)
                    } catch {
                        return
                    }
                    self?.timeout(waiterID: waiterID)
                }
            }
        }

        func complete() {
            guard !isComplete else { return }
            isComplete = true
            let pending = waiters.values
            let timeouts = timeoutTasks.values
            waiters.removeAll(keepingCapacity: false)
            timeoutTasks.removeAll(keepingCapacity: false)
            for timeout in timeouts {
                timeout.cancel()
            }
            for continuation in pending {
                continuation.resume(returning: true)
            }
        }

        func cancel() {
            let task = task
            self.task = nil
            task?.cancel()
        }

        private func timeout(waiterID: UInt64) {
            timeoutTasks.removeValue(forKey: waiterID)
            waiters.removeValue(forKey: waiterID)?.resume(returning: false)
        }
    }

    private enum CloseCompletion {
        case none
        case error(AgentTerminalError)
    }

    private final class CloseBarrier {
        let binding: Binding
        let reason: String
        let acknowledgement: AcknowledgementOperation?
        let completion: CloseCompletion
        var pendingOpen: OpenRequest?
        var task: Task<Void, Never>?

        init(
            binding: Binding,
            reason: String,
            acknowledgement: AcknowledgementOperation?,
            pendingOpen: OpenRequest?,
            completion: CloseCompletion
        ) {
            self.binding = binding
            self.reason = reason
            self.acknowledgement = acknowledgement
            self.pendingOpen = pendingOpen
            self.completion = completion
        }
    }

    private enum Phase {
        case idle
        case opening(OpenOperation)
        case acknowledging(AcknowledgementOperation)
        case ready(Binding)
        case detached(Binding)
        case closing(CloseBarrier)
    }

    let contentView: PtyTerminalSwiftTermContentView
    var terminalView: NSView { contentView }
    private(set) var stateForTesting: AgentWindowTerminalState = .idle

    private let endpoint: any AgentWindowTerminalEndpointRouting
    private let attacher: any AgentWindowTerminalAttaching
    private let acknowledgementCloseGrace: Duration
    private let setTerminalOpen: (Bool) -> Void
    private let deliverStatus: (AgentTerminalHostMessage) -> Void

    private var nextGeneration: UInt64 = 0
    private var phase: Phase = .idle
    private var isTerminalPresented = false

    init(
        endpoint: any AgentWindowTerminalEndpointRouting,
        attacher: any AgentWindowTerminalAttaching,
        contentView: PtyTerminalSwiftTermContentView = PtyTerminalSwiftTermContentView(),
        acknowledgementCloseGrace: Duration = .milliseconds(250),
        setTerminalOpen: @escaping (Bool) -> Void,
        deliverStatus: @escaping (AgentTerminalHostMessage) -> Void
    ) {
        self.endpoint = endpoint
        self.attacher = attacher
        self.contentView = contentView
        self.acknowledgementCloseGrace = acknowledgementCloseGrace
        self.setTerminalOpen = setTerminalOpen
        self.deliverStatus = deliverStatus
        super.init()
        contentView.delegate = self
    }

    func handle(_ intent: AgentPanelTerminalIntent) {
        switch intent {
        case .open(let requestID, let context):
            beginOpen(OpenRequest(requestID: requestID, context: wireContext(context)))
        case .close(let requestID, let context):
            closeMatching(
                requestID: requestID,
                context: context,
                reason: "user-close"
            )
        case .contextEnded(let requestID, let context):
            closeMatching(
                requestID: requestID,
                context: context,
                reason: "context-ended"
            )
        }
    }

    @discardableResult
    func beginExplicitClose(
        reason: AgentWindowTerminalExplicitCloseReason
    ) -> Task<Void, Never>? {
        let closeReason = reason.rawValue
        switch phase {
        case .idle:
            return nil
        case .opening(let operation):
            return beginClose(
                binding: operation.binding,
                acknowledgement: nil,
                reason: closeReason,
                pendingOpen: nil,
                completion: .none,
                cancel: operation.task
            ).task
        case .acknowledging(let acknowledgement):
            return beginClose(
                binding: acknowledgement.binding,
                acknowledgement: acknowledgement,
                reason: closeReason,
                pendingOpen: nil,
                completion: .none,
                cancel: nil
            ).task
        case .ready(let binding):
            return beginClose(
                binding: binding,
                acknowledgement: nil,
                reason: closeReason,
                pendingOpen: nil,
                completion: .none,
                cancel: nil
            ).task
        case .detached(let binding):
            return beginClose(
                binding: binding,
                acknowledgement: nil,
                reason: closeReason,
                pendingOpen: nil,
                completion: .none,
                cancel: nil
            ).task
        case .closing(let barrier):
            // Lifecycle teardown supersedes any queued replacement but never overtakes or duplicates
            // the close already committed to this barrier.
            barrier.pendingOpen = nil
            return barrier.task
        }
    }

    private func beginOpen(_ request: OpenRequest) {
        switch phase {
        case .idle:
            startOpen(request)
        case .opening(let operation):
            guard !operation.binding.matches(request) else { return }
            beginClose(
                binding: operation.binding,
                acknowledgement: nil,
                reason: "context-replaced",
                pendingOpen: request,
                completion: .none,
                cancel: operation.task
            )
        case .acknowledging(let acknowledgement):
            guard !acknowledgement.binding.matches(request) else { return }
            beginClose(
                binding: acknowledgement.binding,
                acknowledgement: acknowledgement,
                reason: "context-replaced",
                pendingOpen: request,
                completion: .none,
                cancel: nil
            )
        case .ready(let binding):
            guard !binding.matches(request) else { return }
            beginClose(
                binding: binding,
                acknowledgement: nil,
                reason: "context-replaced",
                pendingOpen: request,
                completion: .none,
                cancel: nil
            )
        case .detached(let binding):
            if binding.context == request.context {
                // Re-enter the coordinator for the same deterministic leased PTY while its manager
                // grace is active. A fresh panel request ID atomically takes endpoint/coordinator
                // ownership before attach; exact-ID retry uses the endpoint's cached-ready path.
                startOpen(
                    request,
                    transferFromRequestID: binding.requestID == request.requestID
                        ? nil
                        : binding.requestID
                )
            } else {
                beginClose(
                    binding: binding,
                    acknowledgement: nil,
                    reason: "context-replaced",
                    pendingOpen: request,
                    completion: .none,
                    cancel: nil
                )
            }
        case .closing(let barrier):
            if barrier.pendingOpen == request { return }
            barrier.pendingOpen = request
        }
    }

    private func startOpen(
        _ request: OpenRequest,
        transferFromRequestID: String? = nil
    ) {
        nextGeneration &+= 1
        let binding = Binding(
            requestID: request.requestID,
            context: request.context,
            generation: nextGeneration
        )
        let operation = OpenOperation(
            binding: binding,
            transferFromRequestID: transferFromRequestID
        )
        phase = .opening(operation)
        stateForTesting = .loading(requestID: request.requestID, context: request.context)
        operation.task = Task { [weak self, weak operation] in
            guard let self, let operation else { return }
            await self.performOpen(operation)
        }
    }

    private func performOpen(_ operation: OpenOperation) async {
        guard isOpening(operation) else { return }
        await endpoint.setPush { [weak self] message in
            await self?.receiveEndpointStatus(message)
        }
        guard isOpening(operation) else { return }

        let binding = operation.binding
        let open = AgentTerminalOpen(requestID: binding.requestID, context: binding.context)
        let response: AgentTerminalHostMessage?
        if let oldRequestID = operation.transferFromRequestID {
            response = await endpoint.transferLocal(from: oldRequestID, to: open)
        } else {
            response = await endpoint.openLocal(open)
        }
        guard let response,
              isOpening(operation) else {
            return
        }

        switch response {
        case .ready(let ready):
            guard ready.requestID == binding.requestID,
                  ready.context == binding.context else {
                return
            }
            await attach(ready, operation: operation)
        case .error(let error):
            guard error.requestID == binding.requestID,
                  error.context == binding.context else {
                return
            }
            finishWithError(error, operation: operation)
        case .ended(let ended):
            receiveEndpointStatus(.ended(ended))
        }
    }

    private func attach(_ ready: AgentTerminalReady, operation: OpenOperation) async {
        do {
            let connection = try await attacher.attach(
                sessionName: ready.ptySessionName,
                columns: UInt32(max(contentView.columns, 1)),
                rows: UInt32(max(contentView.rows, 1))
            )
            guard isOpening(operation) else {
                let cleanup = AgentWindowTerminalConnectionCleanup(connection: connection)
                Task { await cleanup.detach() }
                return
            }

            operation.binding.ptySessionName = ready.ptySessionName
            contentView.bind(to: connection)
            let acknowledgement = AcknowledgementOperation(
                binding: operation.binding,
                ready: ready
            )
            phase = .acknowledging(acknowledgement)
            stateForTesting = .acknowledging(
                requestID: ready.requestID,
                context: ready.context,
                ptySessionName: ready.ptySessionName
            )
            let attached = AgentTerminalAttachedAck(
                requestID: ready.requestID,
                context: ready.context,
                ptySessionName: ready.ptySessionName
            )
            acknowledgement.task = Task { [endpoint, weak self, weak acknowledgement] in
                await endpoint.handle(.attached(attached))
                guard let self, let acknowledgement else { return }
                acknowledgement.task = nil
                self.acknowledgementDidComplete(acknowledgement)
            }
        } catch {
            guard isOpening(operation) else { return }
            operation.binding.ptySessionName = ready.ptySessionName
            let terminalError = AgentTerminalError(
                requestID: ready.requestID,
                context: ready.context,
                ptySessionName: ready.ptySessionName,
                code: .launchFailed
            )
            beginClose(
                binding: operation.binding,
                acknowledgement: nil,
                reason: "attach-failed",
                pendingOpen: nil,
                completion: .error(terminalError),
                cancel: operation.task
            )
        }
    }

    private func acknowledgementDidComplete(_ acknowledgement: AcknowledgementOperation) {
        acknowledgement.complete()
        guard case .acknowledging(let current) = phase,
              current === acknowledgement,
              contentView.isBound else {
            return
        }

        phase = .ready(acknowledgement.binding)
        let ready = acknowledgement.ready
        stateForTesting = .ready(
            requestID: ready.requestID,
            context: ready.context,
            ptySessionName: ready.ptySessionName
        )
        updatePresentation(open: true)
        deliverStatus(.ready(ready))
        contentView.focus()
    }

    private func closeMatching(
        requestID: String,
        context panelContext: AgentPanelTerminalContext,
        reason: String
    ) {
        let context = wireContext(panelContext)
        let request = OpenRequest(requestID: requestID, context: context)

        switch phase {
        case .opening(let operation) where operation.binding.matches(request):
            beginClose(
                binding: operation.binding,
                acknowledgement: nil,
                reason: reason,
                pendingOpen: nil,
                completion: .none,
                cancel: operation.task
            )
        case .acknowledging(let acknowledgement) where acknowledgement.binding.matches(request):
            beginClose(
                binding: acknowledgement.binding,
                acknowledgement: acknowledgement,
                reason: reason,
                pendingOpen: nil,
                completion: .none,
                cancel: nil
            )
        case .ready(let binding) where binding.matches(request):
            beginClose(
                binding: binding,
                acknowledgement: nil,
                reason: reason,
                pendingOpen: nil,
                completion: .none,
                cancel: nil
            )
        case .detached(let binding) where binding.matches(request):
            beginClose(
                binding: binding,
                acknowledgement: nil,
                reason: reason,
                pendingOpen: nil,
                completion: .none,
                cancel: nil
            )
        case .closing(let barrier) where barrier.binding.matches(request):
            return
        case .closing(let barrier) where barrier.pendingOpen == request:
            barrier.pendingOpen = nil
        default:
            return
        }
    }

    @discardableResult
    private func beginClose(
        binding: Binding,
        acknowledgement: AcknowledgementOperation?,
        reason: String,
        pendingOpen: OpenRequest?,
        completion: CloseCompletion,
        cancel taskToCancel: Task<Void, Never>?
    ) -> CloseBarrier {
        let barrier = CloseBarrier(
            binding: binding,
            reason: reason,
            acknowledgement: acknowledgement,
            pendingOpen: pendingOpen,
            completion: completion
        )
        phase = .closing(barrier)
        taskToCancel?.cancel()
        contentView.detach()
        updatePresentation(open: false)
        stateForTesting = .idle

        barrier.task = Task { [weak self, weak barrier] in
            guard let self, let barrier else { return }
            await self.performClose(barrier)
        }
        return barrier
    }

    private func performClose(_ barrier: CloseBarrier) async {
        if let acknowledgement = barrier.acknowledgement {
            let completed = await acknowledgement.waitForCompletion(
                grace: acknowledgementCloseGrace
            )
            if !completed {
                acknowledgement.cancel()
            }
        }

        await endpoint.handle(.close(closeMessage(
            for: barrier.binding,
            reason: barrier.reason
        )))
        closeDidCommit(barrier)
    }

    private func closeDidCommit(_ barrier: CloseBarrier) {
        guard case .closing(let current) = phase, current === barrier else { return }
        let pendingOpen = barrier.pendingOpen
        phase = .idle

        if case .error(let error) = barrier.completion {
            deliverStatus(.error(error))
        }
        if let pendingOpen {
            startOpen(pendingOpen)
        }
    }

    private func receiveEndpointStatus(_ message: AgentTerminalHostMessage) {
        guard let binding = activeBinding,
              message.requestID == binding.requestID,
              message.context == binding.context else {
            return
        }
        switch message {
        case .ready:
            return
        case .error, .ended:
            cancelActiveOperation()
            phase = .idle
            contentView.stop()
            updatePresentation(open: false)
            stateForTesting = .idle
            deliverStatus(message)
        }
    }

    private func finishWithError(
        _ error: AgentTerminalError,
        operation: OpenOperation
    ) {
        guard isOpening(operation) else { return }
        phase = .idle
        contentView.detach()
        updatePresentation(open: false)
        stateForTesting = .idle
        deliverStatus(.error(error))
    }

    private func isOpening(_ operation: OpenOperation) -> Bool {
        guard case .opening(let current) = phase else { return false }
        return current === operation
    }

    private var activeBinding: Binding? {
        switch phase {
        case .opening(let operation): operation.binding
        case .acknowledging(let acknowledgement): acknowledgement.binding
        case .ready(let binding): binding
        case .idle, .detached, .closing: nil
        }
    }

    private func cancelActiveOperation() {
        switch phase {
        case .opening(let operation):
            operation.task?.cancel()
        case .acknowledging(let acknowledgement):
            acknowledgement.cancel()
        case .idle, .ready, .detached, .closing:
            break
        }
    }

    private func updatePresentation(open: Bool) {
        guard open != isTerminalPresented else { return }
        isTerminalPresented = open
        setTerminalOpen(open)
    }

    private func wireContext(_ context: AgentPanelTerminalContext) -> AgentResumeTerminalContext {
        AgentResumeTerminalContext(
            projectPath: context.projectPath,
            source: context.source.rawValue,
            harnessSessionID: context.sessionID
        )
    }

    private func closeMessage(for binding: Binding, reason: String) -> AgentTerminalClose {
        AgentTerminalClose(
            requestID: binding.requestID,
            context: binding.context,
            ptySessionName: binding.ptySessionName,
            reason: reason
        )
    }

    func ptyTerminalContent(
        _ content: PtyTerminalSwiftTermContentView,
        didTerminate termination: PtyTerminalSessionTermination
    ) {
        guard case .exited(let status) = termination,
              let binding = activeBinding,
              let ptySessionName = binding.ptySessionName else {
            return
        }
        Task { [endpoint] in
            await endpoint.terminalEnded(
                requestID: binding.requestID,
                context: binding.context,
                ptySessionName: ptySessionName,
                exitStatus: status
            )
        }
    }

    func ptyTerminalContent(
        _ content: PtyTerminalSwiftTermContentView,
        didFail error: Error
    ) {
        detachAfterUnexpectedLoss(contentAlreadyStopped: false)
    }

    func ptyTerminalContentDidDetachByManager(
        _ content: PtyTerminalSwiftTermContentView
    ) {
        detachAfterUnexpectedLoss(contentAlreadyStopped: true)
    }

    private func detachAfterUnexpectedLoss(contentAlreadyStopped: Bool) {
        let binding: Binding
        switch phase {
        case .acknowledging(let acknowledgement):
            binding = acknowledgement.binding
        case .ready(let readyBinding):
            binding = readyBinding
        case .idle, .opening, .detached, .closing:
            return
        }
        cancelActiveOperation()
        phase = .detached(binding)
        if contentAlreadyStopped {
            contentView.stop()
        } else {
            contentView.detach()
        }
        updatePresentation(open: false)
        stateForTesting = .idle
    }
}
