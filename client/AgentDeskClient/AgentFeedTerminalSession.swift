import AgentDeskWire
import AgentPanel
import Foundation
import OSLog
import PtyClientSwift
import PtyTerminalSession
import PtyTerminalSwiftTerm

@MainActor
final class AgentFeedTerminalSession: PtyTerminalSwiftTermContentViewDelegate {
    private struct ActiveTerminal {
        let ready: AgentTerminalReady
        let connection: any AgentFeedTerminalConnection
        let operationGeneration: UInt64
    }

    private let logger = Logger(subsystem: Config.logSubsystem, category: "agent-feed-terminal")
    private weak var terminalContent: PtyTerminalSwiftTermContentView?
    private let setPresented: (Bool) -> Void
    private let deliver: (AgentTerminalHostMessage) -> Void

    private weak var coordinator: (any AgentFeedTerminalCoordinating)?
    private weak var sessionOpener: (any AgentFeedTerminalSessionOpening)?
    private var updatesTask: Task<Void, Never>?
    private var sendTask: Task<Void, Never>?
    private var attachTask: Task<Void, Never>?
    private var dependencyGeneration: UInt64 = 0
    private var operationGeneration: UInt64 = 0
    private var responseFence = AgentTerminalResponseFence()
    private var activeTerminal: ActiveTerminal?

    init(
        terminalContent: PtyTerminalSwiftTermContentView,
        setPresented: @escaping (Bool) -> Void,
        deliver: @escaping (AgentTerminalHostMessage) -> Void
    ) {
        self.terminalContent = terminalContent
        self.setPresented = setPresented
        self.deliver = deliver
        terminalContent.delegate = self
    }

    deinit {
        updatesTask?.cancel()
        sendTask?.cancel()
        attachTask?.cancel()
    }

    func bind(
        coordinator: (any AgentFeedTerminalCoordinating)?,
        sessionOpener: (any AgentFeedTerminalSessionOpening)?
    ) {
        guard self.coordinator !== coordinator || self.sessionOpener !== sessionOpener else { return }
        dependencyGeneration &+= 1
        operationGeneration &+= 1
        updatesTask?.cancel()
        sendTask?.cancel()
        attachTask?.cancel()
        updatesTask = nil
        sendTask = nil
        attachTask = nil
        responseFence.cancel()
        detachCurrentTerminal()
        self.coordinator = coordinator
        self.sessionOpener = sessionOpener

        guard let coordinator else { return }
        let generation = dependencyGeneration
        updatesTask = Task { [weak self, weak coordinator] in
            guard let coordinator else { return }
            for await message in coordinator.agentTerminalUpdates {
                guard !Task.isCancelled else { return }
                self?.receive(message, dependencyGeneration: generation)
            }
        }
    }

    func invalidate() {
        dependencyGeneration &+= 1
        operationGeneration &+= 1
        updatesTask?.cancel()
        sendTask?.cancel()
        attachTask?.cancel()
        updatesTask = nil
        sendTask = nil
        attachTask = nil
        coordinator = nil
        sessionOpener = nil
        responseFence.cancel()
        detachCurrentTerminal()
        terminalContent?.delegate = nil
    }

    func handle(_ intent: AgentPanelTerminalIntent) {
        switch intent {
        case .open(let requestID, let context):
            open(requestID: requestID, context: context)
        case .close(let requestID, let context):
            close(requestID: requestID, context: context, reason: "user-close")
        case .contextEnded:
            // R70 owns navigation and context-ended lifecycle policy.
            break
        }
    }

    private func open(requestID: String, context: AgentPanelTerminalContext) {
        let open = AgentTerminalOpen(requestID: requestID, context: wireContext(context))
        if let activeRequest = responseFence.activeRequest {
            guard activeRequest == open else {
                deliver(.error(AgentTerminalError(
                    requestID: requestID,
                    context: open.context,
                    code: .sessionEnded
                )))
                return
            }
            return
        }
        guard let coordinator, sessionOpener != nil else {
            deliver(.error(AgentTerminalError(
                requestID: requestID,
                context: open.context,
                code: .sessionEnded
            )))
            return
        }

        operationGeneration &+= 1
        let generation = operationGeneration
        responseFence.begin(open)
        sendTask?.cancel()
        sendTask = Task { [weak self, weak coordinator] in
            do {
                guard let coordinator else { throw CancellationError() }
                try await coordinator.sendAgentTerminal(.open(open))
            } catch is CancellationError {
            } catch {
                self?.failCurrentOpen(
                    open,
                    code: .sessionEnded,
                    operationGeneration: generation,
                    error: error
                )
            }
        }
    }

    private func close(
        requestID: String,
        context: AgentPanelTerminalContext,
        reason: String
    ) {
        let wireContext = wireContext(context)
        guard let open = responseFence.activeRequest,
              open.requestID == requestID,
              open.context == wireContext,
              let coordinator else {
            return
        }
        let ptySessionName = activeTerminal?.ready.ptySessionName
        let close = AgentTerminalClose(
            requestID: requestID,
            context: wireContext,
            ptySessionName: ptySessionName,
            reason: reason
        )
        operationGeneration &+= 1
        let dependencyGeneration = self.dependencyGeneration
        let operationGeneration = self.operationGeneration
        responseFence.cancel()
        attachTask?.cancel()
        attachTask = nil
        let retainedConnection = activeTerminal?.connection
        detachCurrentTerminal()

        sendTask?.cancel()
        sendTask = Task { [weak self, weak coordinator, retainedConnection] in
            _ = retainedConnection
            do {
                guard let coordinator else { throw CancellationError() }
                try await coordinator.sendAgentTerminal(.close(close))
                if let ptySessionName {
                    self?.completeClose(
                        requestID: requestID,
                        context: wireContext,
                        ptySessionName: ptySessionName,
                        dependencyGeneration: dependencyGeneration,
                        operationGeneration: operationGeneration
                    )
                }
            } catch is CancellationError {
            } catch {
                self?.logger.error("agent terminal close send failed: \(String(describing: error), privacy: .public)")
            }
            self?.clearSendTask(operationGeneration: operationGeneration)
        }
    }

    private func completeClose(
        requestID: String,
        context: AgentResumeTerminalContext,
        ptySessionName: String,
        dependencyGeneration: UInt64,
        operationGeneration: UInt64
    ) {
        guard self.dependencyGeneration == dependencyGeneration,
              self.operationGeneration == operationGeneration,
              responseFence.activeRequest == nil,
              activeTerminal == nil else {
            return
        }
        deliver(.ended(AgentTerminalEnded(
            requestID: requestID,
            context: context,
            ptySessionName: ptySessionName,
            exitStatus: nil
        )))
    }

    private func clearSendTask(operationGeneration: UInt64) {
        guard self.operationGeneration == operationGeneration else { return }
        sendTask = nil
    }

    private func receive(
        _ message: AgentTerminalHostMessage,
        dependencyGeneration: UInt64
    ) {
        guard dependencyGeneration == self.dependencyGeneration,
              let accepted = responseFence.accept(message) else {
            return
        }
        switch accepted {
        case .ready(let ready):
            attach(ready, dependencyGeneration: dependencyGeneration)
        case .error, .ended:
            finishCurrentTerminal()
            deliver(accepted)
        }
    }

    private func attach(
        _ ready: AgentTerminalReady,
        dependencyGeneration: UInt64
    ) {
        guard attachTask == nil,
              activeTerminal == nil,
              let coordinator,
              let sessionOpener,
              let terminalContent else {
            return
        }
        let operationGeneration = self.operationGeneration
        let request = AgentFeedTerminalAttachmentRequest(
            sessionName: ready.ptySessionName,
            columns: UInt32(max(terminalContent.columns, 80)),
            rows: UInt32(max(terminalContent.rows, 24))
        )
        attachTask = Task { [weak self, weak coordinator, weak sessionOpener] in
            do {
                guard let sessionOpener else { throw CancellationError() }
                let connection = try await sessionOpener.openAgentFeedTerminal(request)
                guard self?.bindConnection(
                    connection,
                    ready: ready,
                    dependencyGeneration: dependencyGeneration,
                    operationGeneration: operationGeneration
                ) == true else {
                    try? await connection.detach()
                    return
                }

                guard let coordinator else { throw CancellationError() }
                try await coordinator.sendAgentTerminal(.attached(AgentTerminalAttachedAck(
                    requestID: ready.requestID,
                    context: ready.context,
                    ptySessionName: ready.ptySessionName
                )))
                self?.completeAttachment(
                    connection,
                    ready: ready,
                    dependencyGeneration: dependencyGeneration,
                    operationGeneration: operationGeneration
                )
            } catch is CancellationError {
                if !Task.isCancelled {
                    self?.failCurrentReady(
                        ready,
                        operationGeneration: operationGeneration,
                        error: CancellationError()
                    )
                }
            } catch {
                self?.failCurrentReady(
                    ready,
                    operationGeneration: operationGeneration,
                    error: error
                )
            }
            self?.clearAttachTask(operationGeneration: operationGeneration)
        }
    }

    private func bindConnection(
        _ connection: any AgentFeedTerminalConnection,
        ready: AgentTerminalReady,
        dependencyGeneration: UInt64,
        operationGeneration: UInt64
    ) -> Bool {
        guard let terminalContent,
              self.dependencyGeneration == dependencyGeneration,
              self.operationGeneration == operationGeneration,
              responseFence.activeRequest == AgentTerminalOpen(
                requestID: ready.requestID,
                context: ready.context
              ),
              activeTerminal == nil else {
            return false
        }
        activeTerminal = ActiveTerminal(
            ready: ready,
            connection: connection,
            operationGeneration: operationGeneration
        )
        terminalContent.bind(to: connection)
        setPresented(true)
        return true
    }

    private func completeAttachment(
        _ connection: any AgentFeedTerminalConnection,
        ready: AgentTerminalReady,
        dependencyGeneration: UInt64,
        operationGeneration: UInt64
    ) {
        guard let terminalContent,
              self.dependencyGeneration == dependencyGeneration,
              self.operationGeneration == operationGeneration,
              activeTerminal?.connection === connection,
              activeTerminal?.ready == ready,
              terminalContent.isBound else {
            return
        }
        deliver(.ready(ready))
    }

    private func clearAttachTask(operationGeneration: UInt64) {
        guard self.operationGeneration == operationGeneration else { return }
        attachTask = nil
    }

    private func failCurrentOpen(
        _ open: AgentTerminalOpen,
        code: AgentTerminalErrorCode,
        operationGeneration: UInt64,
        error: Error
    ) {
        guard self.operationGeneration == operationGeneration,
              responseFence.activeRequest == open else { return }
        logger.error("agent terminal open send failed: \(String(describing: error), privacy: .public)")
        let message = AgentTerminalHostMessage.error(AgentTerminalError(
            requestID: open.requestID,
            context: open.context,
            code: code
        ))
        _ = responseFence.accept(message)
        deliver(message)
    }

    private func failCurrentReady(
        _ ready: AgentTerminalReady,
        operationGeneration: UInt64,
        error: Error
    ) {
        guard self.operationGeneration == operationGeneration,
              responseFence.activeRequest?.requestID == ready.requestID,
              responseFence.activeRequest?.context == ready.context else { return }
        logger.error("agent terminal attach failed: \(String(describing: error), privacy: .public)")
        let message = AgentTerminalHostMessage.error(AgentTerminalError(
            requestID: ready.requestID,
            context: ready.context,
            ptySessionName: ready.ptySessionName,
            code: .launchFailed
        ))
        _ = responseFence.accept(message)
        detachCurrentTerminal()
        deliver(message)
    }

    private func finishCurrentTerminal() {
        operationGeneration &+= 1
        attachTask?.cancel()
        attachTask = nil
        detachCurrentTerminal()
    }

    private func detachCurrentTerminal() {
        terminalContent?.detach()
        activeTerminal = nil
        setPresented(false)
    }

    private func wireContext(_ context: AgentPanelTerminalContext) -> AgentResumeTerminalContext {
        AgentResumeTerminalContext(
            projectPath: context.projectPath,
            source: context.source.rawValue,
            harnessSessionID: context.sessionID
        )
    }

    func ptyTerminalContent(
        _ content: PtyTerminalSwiftTermContentView,
        didTerminate termination: PtyTerminalSessionTermination
    ) {
        guard let activeTerminal,
              activeTerminal.operationGeneration == operationGeneration else { return }
        let exitStatus: Int32
        switch termination {
        case .exited(let status):
            exitStatus = status
        }
        let message = AgentTerminalHostMessage.ended(AgentTerminalEnded(
            requestID: activeTerminal.ready.requestID,
            context: activeTerminal.ready.context,
            ptySessionName: activeTerminal.ready.ptySessionName,
            exitStatus: exitStatus
        ))
        guard responseFence.accept(message) != nil else { return }
        finishCurrentTerminal()
        deliver(message)
    }

    func ptyTerminalContent(
        _ content: PtyTerminalSwiftTermContentView,
        didFail error: Error
    ) {
        guard let activeTerminal,
              activeTerminal.operationGeneration == operationGeneration else { return }
        failCurrentReady(
            activeTerminal.ready,
            operationGeneration: activeTerminal.operationGeneration,
            error: error
        )
    }

    func ptyTerminalContentDidDetachByManager(_ content: PtyTerminalSwiftTermContentView) {
        guard let activeTerminal,
              activeTerminal.operationGeneration == operationGeneration else { return }
        failCurrentReady(
            activeTerminal.ready,
            operationGeneration: activeTerminal.operationGeneration,
            error: PtyClientError.closed
        )
    }
}
