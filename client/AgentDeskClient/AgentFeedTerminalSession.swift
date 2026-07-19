import AgentDeskWire
import AgentPanel
import Foundation
import OSLog
import PtyTerminalSession
import PtyTerminalSwiftTerm

enum AgentFeedTerminalAbandonmentReason: String, CaseIterable {
    case userClose = "user-close"
    case contextEnded = "context-ended"
    case surfaceSwitched = "surface-switched"
    case surfaceTeardown = "surface-teardown"
    case pairingDisconnected = "pairing-disconnected"
    case pairingRevoked = "pairing-revoked"
}

enum AgentFeedTerminalInterruption {
    case background
    case transportLoss
}

@MainActor
protocol AgentFeedTerminalLifecycleHandling: AnyObject {
    @discardableResult
    func abandonTerminal(_ reason: AgentFeedTerminalAbandonmentReason) -> Task<Void, Never>?
    func interruptTerminal(_ interruption: AgentFeedTerminalInterruption)
    @discardableResult
    func teardown() -> Task<Void, Never>?
}

enum AgentFeedTerminalLifecycleEvent: Equatable {
    case switchAway
    case surfaceTeardown
    case rejection(SessionRejectionReason)
    case forget
    case disconnect
    case background
    case transportFailure
}

@MainActor
final class AgentFeedTerminalCloseDelivery {
    private struct PendingClose {
        let close: AgentTerminalClose
        let completion: () -> Void
        let generation: UInt64
    }

    private let logger = Logger(subsystem: Config.logSubsystem, category: "agent-feed-terminal-close")
    private weak var coordinator: (any AgentFeedTerminalCoordinating)?
    private var coordinatorGeneration: UInt64 = 0
    private var closeGeneration: UInt64 = 0
    private var closeTask: Task<Void, Never>?
    private var pendingClose: PendingClose?

    var hasPendingClose: Bool { pendingClose != nil }

    func bind(_ coordinator: (any AgentFeedTerminalCoordinating)?) {
        guard self.coordinator !== coordinator else { return }
        coordinatorGeneration &+= 1
        self.coordinator = coordinator
        _ = sendPendingCloseIfPossible()
    }

    @discardableResult
    func enqueue(
        _ close: AgentTerminalClose,
        completion: @escaping () -> Void
    ) -> Task<Void, Never>? {
        guard pendingClose == nil else { return closeTask }
        closeGeneration &+= 1
        pendingClose = PendingClose(
            close: close,
            completion: completion,
            generation: closeGeneration
        )
        return sendPendingCloseIfPossible()
    }

    private func sendPendingCloseIfPossible() -> Task<Void, Never>? {
        guard closeTask == nil,
              let pendingClose,
              let coordinator else {
            return closeTask
        }
        let coordinatorGeneration = self.coordinatorGeneration
        let task = Task { [weak self, coordinator] in
            do {
                try await coordinator.sendAgentTerminal(.close(pendingClose.close))
                self?.finish(
                    pendingClose,
                    succeeded: true,
                    coordinatorGeneration: coordinatorGeneration
                )
            } catch is CancellationError {
                self?.finish(
                    pendingClose,
                    succeeded: false,
                    coordinatorGeneration: coordinatorGeneration
                )
            } catch {
                self?.logger.error(
                    "agent terminal close send failed: \(String(describing: error), privacy: .public)"
                )
                self?.finish(
                    pendingClose,
                    succeeded: false,
                    coordinatorGeneration: coordinatorGeneration
                )
            }
        }
        closeTask = task
        return task
    }

    private func finish(
        _ completed: PendingClose,
        succeeded: Bool,
        coordinatorGeneration: UInt64
    ) {
        guard pendingClose?.generation == completed.generation else { return }
        closeTask = nil
        if succeeded {
            pendingClose = nil
            completed.completion()
        } else if self.coordinatorGeneration != coordinatorGeneration {
            _ = sendPendingCloseIfPossible()
        }
    }
}

@MainActor
final class AgentFeedTerminalLifecycleRouter {
    let closeDelivery: AgentFeedTerminalCloseDelivery

    init(closeDelivery: AgentFeedTerminalCloseDelivery = AgentFeedTerminalCloseDelivery()) {
        self.closeDelivery = closeDelivery
    }

    func bind(_ coordinator: (any AgentFeedTerminalCoordinating)?) {
        closeDelivery.bind(coordinator)
    }

    @discardableResult
    func route(
        _ event: AgentFeedTerminalLifecycleEvent,
        to target: (any AgentFeedTerminalLifecycleHandling)?
    ) -> Task<Void, Never>? {
        switch event {
        case .switchAway:
            return target?.abandonTerminal(.surfaceSwitched)
        case .surfaceTeardown:
            return target?.teardown()
        case .rejection(let reason):
            switch reason {
            case .revoked, .unknownDevice, .badSignature, .unauthorized:
                return target?.abandonTerminal(.pairingRevoked)
            case .replay, .malformed, .expiredResume, .signingKeyUnavailable, .incompatibleProtocol:
                return target?.abandonTerminal(.surfaceTeardown)
            }
        case .forget:
            return target?.abandonTerminal(.pairingRevoked)
        case .disconnect:
            return target?.abandonTerminal(.pairingDisconnected)
        case .background:
            target?.interruptTerminal(.background)
            return nil
        case .transportFailure:
            target?.interruptTerminal(.transportLoss)
            return nil
        }
    }

    @discardableResult
    func teardown(
        _ target: (any AgentFeedTerminalLifecycleHandling)?,
        release: () -> Void
    ) -> Task<Void, Never>? {
        let closeTask = route(.surfaceTeardown, to: target)
        release()
        return closeTask
    }
}

@MainActor
final class AgentFeedTerminalSession: PtyTerminalSwiftTermContentViewDelegate {
    private struct TerminalDescriptor: Equatable {
        let open: AgentTerminalOpen
        var ptySessionName: String?
        var pid: UInt32?
        var wasReportedReady: Bool
    }

    private struct ActiveTerminal {
        let ready: AgentTerminalReady
        let connection: any AgentFeedTerminalConnection
        let operationGeneration: UInt64
        let contextGeneration: UInt64
    }

    private let logger = Logger(subsystem: Config.logSubsystem, category: "agent-feed-terminal")
    private weak var terminalContent: PtyTerminalSwiftTermContentView?
    private let setPresented: (Bool) -> Void
    private let deliver: (AgentTerminalHostMessage) -> Void
    private let closeDelivery: AgentFeedTerminalCloseDelivery

    private weak var coordinator: (any AgentFeedTerminalCoordinating)?
    private weak var sessionOpener: (any AgentFeedTerminalSessionOpening)?
    private var updatesTask: Task<Void, Never>?
    private var openTask: Task<Void, Never>?
    private var attachTask: Task<Void, Never>?
    private var dependencyGeneration: UInt64 = 0
    private var operationGeneration: UInt64 = 0
    private var contextGeneration: UInt64 = 0
    private var responseFence = AgentTerminalResponseFence()
    private var responseOperationGeneration: UInt64?
    private var responseContextGeneration: UInt64?
    private var descriptor: TerminalDescriptor?
    private var activeTerminal: ActiveTerminal?

    init(
        terminalContent: PtyTerminalSwiftTermContentView,
        closeDelivery: AgentFeedTerminalCloseDelivery,
        setPresented: @escaping (Bool) -> Void,
        deliver: @escaping (AgentTerminalHostMessage) -> Void
    ) {
        self.terminalContent = terminalContent
        self.closeDelivery = closeDelivery
        self.setPresented = setPresented
        self.deliver = deliver
        terminalContent.delegate = self
    }

    deinit {
        updatesTask?.cancel()
        openTask?.cancel()
        attachTask?.cancel()
    }

    func bind(
        coordinator: (any AgentFeedTerminalCoordinating)?,
        sessionOpener: (any AgentFeedTerminalSessionOpening)?
    ) {
        guard self.coordinator !== coordinator || self.sessionOpener !== sessionOpener else { return }
        invalidateOperations(preservingDescriptor: true)
        self.coordinator = coordinator
        self.sessionOpener = sessionOpener
        closeDelivery.bind(coordinator)
        startUpdatesIfPossible()
        if !closeDelivery.hasPendingClose {
            resumeDescriptorIfPossible()
        }
    }

    func interrupt(_ interruption: AgentFeedTerminalInterruption) {
        _ = interruption
        invalidateOperations(preservingDescriptor: true)
        coordinator = nil
        sessionOpener = nil
        closeDelivery.bind(nil)
    }

    @discardableResult
    func abandon(_ reason: AgentFeedTerminalAbandonmentReason) -> Task<Void, Never>? {
        abandon(reason, matching: nil)
    }

    @discardableResult
    func teardown() -> Task<Void, Never>? {
        let closeTask = abandon(.surfaceTeardown)
        invalidateOperations(preservingDescriptor: false)
        coordinator = nil
        sessionOpener = nil
        closeDelivery.bind(nil)
        terminalContent?.delegate = nil
        return closeTask
    }

    func handle(_ intent: AgentPanelTerminalIntent) {
        switch intent {
        case .open(let requestID, let context):
            open(requestID: requestID, context: context)
        case .close(let requestID, let context):
            _ = abandon(.userClose, matching: AgentTerminalOpen(
                requestID: requestID,
                context: wireContext(context)
            ))
        case .contextEnded(let requestID, let context):
            _ = abandon(.contextEnded, matching: AgentTerminalOpen(
                requestID: requestID,
                context: wireContext(context)
            ))
        }
    }

    private func startUpdatesIfPossible() {
        guard let coordinator else { return }
        let dependencyGeneration = self.dependencyGeneration
        updatesTask = Task { [weak self, weak coordinator] in
            guard let coordinator else { return }
            for await message in coordinator.agentTerminalUpdates {
                guard !Task.isCancelled else { return }
                self?.receive(message, dependencyGeneration: dependencyGeneration)
            }
        }
    }

    private func open(requestID: String, context: AgentPanelTerminalContext) {
        let open = AgentTerminalOpen(requestID: requestID, context: wireContext(context))
        guard !closeDelivery.hasPendingClose else {
            deliver(.error(AgentTerminalError(
                requestID: requestID,
                context: open.context,
                code: .sessionEnded
            )))
            return
        }
        if let descriptor {
            guard descriptor.open == open else {
                deliver(.error(AgentTerminalError(
                    requestID: requestID,
                    context: open.context,
                    code: .sessionEnded
                )))
                return
            }
            if responseFence.activeRequest == nil {
                resumeDescriptorIfPossible()
            }
            return
        }

        guard coordinator != nil, sessionOpener != nil else {
            deliver(.error(AgentTerminalError(
                requestID: requestID,
                context: open.context,
                code: .sessionEnded
            )))
            return
        }

        contextGeneration &+= 1
        descriptor = TerminalDescriptor(
            open: open,
            ptySessionName: nil,
            pid: nil,
            wasReportedReady: false
        )
        sendOpen(open)
    }

    private func resumeDescriptorIfPossible() {
        guard let descriptor, coordinator != nil, sessionOpener != nil else { return }
        sendOpen(descriptor.open)
    }

    private func sendOpen(_ open: AgentTerminalOpen) {
        guard let coordinator,
              descriptor?.open == open,
              sessionOpener != nil else {
            return
        }
        operationGeneration &+= 1
        let dependencyGeneration = self.dependencyGeneration
        let operationGeneration = self.operationGeneration
        let contextGeneration = self.contextGeneration
        responseFence.begin(open)
        responseOperationGeneration = operationGeneration
        responseContextGeneration = contextGeneration
        openTask?.cancel()
        openTask = Task { [weak self, weak coordinator] in
            do {
                guard let coordinator else { throw CancellationError() }
                try await coordinator.sendAgentTerminal(.open(open))
            } catch is CancellationError {
            } catch {
                self?.failCurrentOpen(
                    open,
                    dependencyGeneration: dependencyGeneration,
                    operationGeneration: operationGeneration,
                    contextGeneration: contextGeneration,
                    error: error
                )
            }
            self?.clearOpenTask(
                dependencyGeneration: dependencyGeneration,
                operationGeneration: operationGeneration,
                contextGeneration: contextGeneration
            )
        }
    }

    private func abandon(
        _ reason: AgentFeedTerminalAbandonmentReason,
        matching expectedOpen: AgentTerminalOpen?
    ) -> Task<Void, Never>? {
        guard let descriptor,
              expectedOpen == nil || expectedOpen == descriptor.open else {
            return nil
        }

        let close = AgentTerminalClose(
            requestID: descriptor.open.requestID,
            context: descriptor.open.context,
            ptySessionName: descriptor.ptySessionName,
            reason: reason.rawValue
        )
        operationGeneration &+= 1
        contextGeneration &+= 1
        self.descriptor = nil
        responseFence.cancel()
        responseOperationGeneration = nil
        responseContextGeneration = nil
        openTask?.cancel()
        openTask = nil
        attachTask?.cancel()
        attachTask = nil
        detachCurrentTerminal()
        if reason != .userClose, descriptor.wasReportedReady {
            if let ptySessionName = close.ptySessionName {
                deliver(.ended(AgentTerminalEnded(
                    requestID: close.requestID,
                    context: close.context,
                    ptySessionName: ptySessionName,
                    exitStatus: nil
                )))
            } else {
                deliver(.error(AgentTerminalError(
                    requestID: close.requestID,
                    context: close.context,
                    code: .sessionEnded
                )))
            }
        }

        let dependencyGeneration = self.dependencyGeneration
        let operationGeneration = self.operationGeneration
        let contextGeneration = self.contextGeneration
        return closeDelivery.enqueue(close) { [weak self] in
            guard reason == .userClose,
                  let ptySessionName = close.ptySessionName else {
                return
            }
            self?.completeUserClose(
                close,
                ptySessionName: ptySessionName,
                dependencyGeneration: dependencyGeneration,
                operationGeneration: operationGeneration,
                contextGeneration: contextGeneration
            )
        }
    }

    private func completeUserClose(
        _ close: AgentTerminalClose,
        ptySessionName: String,
        dependencyGeneration: UInt64,
        operationGeneration: UInt64,
        contextGeneration: UInt64
    ) {
        guard self.dependencyGeneration == dependencyGeneration,
              self.operationGeneration == operationGeneration,
              self.contextGeneration == contextGeneration,
              descriptor == nil,
              activeTerminal == nil else {
            return
        }
        deliver(.ended(AgentTerminalEnded(
            requestID: close.requestID,
            context: close.context,
            ptySessionName: ptySessionName,
            exitStatus: nil
        )))
    }

    private func receive(
        _ message: AgentTerminalHostMessage,
        dependencyGeneration: UInt64
    ) {
        guard dependencyGeneration == self.dependencyGeneration,
              responseOperationGeneration == operationGeneration,
              responseContextGeneration == contextGeneration,
              let accepted = responseFence.accept(message),
              descriptor?.open.requestID == message.requestID,
              descriptor?.open.context == message.context else {
            return
        }
        switch accepted {
        case .ready(let ready):
            if let expectedName = descriptor?.ptySessionName,
               expectedName != ready.ptySessionName {
                failResumeIdentity(
                    ready,
                    dependencyGeneration: dependencyGeneration,
                    operationGeneration: operationGeneration,
                    contextGeneration: contextGeneration
                )
                return
            }
            descriptor?.ptySessionName = ready.ptySessionName
            attach(ready, dependencyGeneration: dependencyGeneration)
        case .error, .ended:
            responseOperationGeneration = nil
            responseContextGeneration = nil
            clearDescriptorAndTerminal()
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
        let contextGeneration = self.contextGeneration
        let expectedPID = descriptor?.pid
        let request = AgentFeedTerminalAttachmentRequest(
            sessionName: ready.ptySessionName,
            columns: UInt32(max(terminalContent.columns, 80)),
            rows: UInt32(max(terminalContent.rows, 24))
        )
        attachTask = Task { [weak self, weak coordinator, weak sessionOpener] in
            do {
                guard let sessionOpener else { throw CancellationError() }
                let connection = try await sessionOpener.openAgentFeedTerminal(request)
                guard self?.isCurrentAttach(
                    ready,
                    dependencyGeneration: dependencyGeneration,
                    operationGeneration: operationGeneration,
                    contextGeneration: contextGeneration
                ) == true else {
                    try? await connection.detach()
                    return
                }
                guard connection.identity.sessionName == ready.ptySessionName,
                      expectedPID == nil || connection.identity.pid == expectedPID else {
                    try? await connection.detach()
                    self?.failResumeIdentity(
                        ready,
                        dependencyGeneration: dependencyGeneration,
                        operationGeneration: operationGeneration,
                        contextGeneration: contextGeneration
                    )
                    return
                }
                guard self?.bindConnection(
                    connection,
                    ready: ready,
                    dependencyGeneration: dependencyGeneration,
                    operationGeneration: operationGeneration,
                    contextGeneration: contextGeneration
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
                    operationGeneration: operationGeneration,
                    contextGeneration: contextGeneration
                )
            } catch is CancellationError {
                if !Task.isCancelled {
                    self?.failCurrentReady(
                        ready,
                        dependencyGeneration: dependencyGeneration,
                        operationGeneration: operationGeneration,
                        contextGeneration: contextGeneration,
                        error: CancellationError()
                    )
                }
            } catch {
                self?.failCurrentReady(
                    ready,
                    dependencyGeneration: dependencyGeneration,
                    operationGeneration: operationGeneration,
                    contextGeneration: contextGeneration,
                    error: error
                )
            }
            self?.clearAttachTask(
                dependencyGeneration: dependencyGeneration,
                operationGeneration: operationGeneration,
                contextGeneration: contextGeneration
            )
        }
    }

    private func bindConnection(
        _ connection: any AgentFeedTerminalConnection,
        ready: AgentTerminalReady,
        dependencyGeneration: UInt64,
        operationGeneration: UInt64,
        contextGeneration: UInt64
    ) -> Bool {
        guard let terminalContent,
              self.dependencyGeneration == dependencyGeneration,
              self.operationGeneration == operationGeneration,
              self.contextGeneration == contextGeneration,
              responseFence.activeRequest == AgentTerminalOpen(
                requestID: ready.requestID,
                context: ready.context
              ),
              descriptor?.ptySessionName == ready.ptySessionName,
              activeTerminal == nil else {
            return false
        }
        descriptor?.pid = connection.identity.pid
        activeTerminal = ActiveTerminal(
            ready: ready,
            connection: connection,
            operationGeneration: operationGeneration,
            contextGeneration: contextGeneration
        )
        terminalContent.bind(to: connection)
        setPresented(true)
        return true
    }

    private func isCurrentAttach(
        _ ready: AgentTerminalReady,
        dependencyGeneration: UInt64,
        operationGeneration: UInt64,
        contextGeneration: UInt64
    ) -> Bool {
        self.dependencyGeneration == dependencyGeneration
            && self.operationGeneration == operationGeneration
            && self.contextGeneration == contextGeneration
            && responseFence.activeRequest == AgentTerminalOpen(
                requestID: ready.requestID,
                context: ready.context
            )
            && descriptor?.ptySessionName == ready.ptySessionName
            && activeTerminal == nil
    }

    private func completeAttachment(
        _ connection: any AgentFeedTerminalConnection,
        ready: AgentTerminalReady,
        dependencyGeneration: UInt64,
        operationGeneration: UInt64,
        contextGeneration: UInt64
    ) {
        guard let terminalContent,
              self.dependencyGeneration == dependencyGeneration,
              self.operationGeneration == operationGeneration,
              self.contextGeneration == contextGeneration,
              activeTerminal?.connection === connection,
              activeTerminal?.ready == ready,
              descriptor?.ptySessionName == connection.identity.sessionName,
              descriptor?.pid == connection.identity.pid,
              terminalContent.isBound else {
            return
        }
        descriptor?.wasReportedReady = true
        deliver(.ready(ready))
    }

    private func failCurrentOpen(
        _ open: AgentTerminalOpen,
        dependencyGeneration: UInt64,
        operationGeneration: UInt64,
        contextGeneration: UInt64,
        error: Error
    ) {
        guard self.dependencyGeneration == dependencyGeneration,
              self.operationGeneration == operationGeneration,
              self.contextGeneration == contextGeneration,
              responseFence.activeRequest == open,
              descriptor?.open == open else {
            return
        }
        logger.error("agent terminal open send failed: \(String(describing: error), privacy: .public)")
        let message = AgentTerminalHostMessage.error(AgentTerminalError(
            requestID: open.requestID,
            context: open.context,
            code: .sessionEnded
        ))
        _ = responseFence.accept(message)
        responseOperationGeneration = nil
        responseContextGeneration = nil
        descriptor = nil
        contextGenerationIncrement()
        deliver(message)
    }

    private func failCurrentReady(
        _ ready: AgentTerminalReady,
        dependencyGeneration: UInt64,
        operationGeneration: UInt64,
        contextGeneration: UInt64,
        error: Error
    ) {
        guard self.dependencyGeneration == dependencyGeneration,
              self.operationGeneration == operationGeneration,
              self.contextGeneration == contextGeneration,
              responseFence.activeRequest?.requestID == ready.requestID,
              responseFence.activeRequest?.context == ready.context else {
            return
        }
        logger.error("agent terminal attach failed: \(String(describing: error), privacy: .public)")
        let message = AgentTerminalHostMessage.error(AgentTerminalError(
            requestID: ready.requestID,
            context: ready.context,
            ptySessionName: ready.ptySessionName,
            code: .launchFailed
        ))
        _ = responseFence.accept(message)
        responseOperationGeneration = nil
        responseContextGeneration = nil
        descriptor = nil
        contextGenerationIncrement()
        detachCurrentTerminal()
        deliver(message)
    }

    private func failResumeIdentity(
        _ ready: AgentTerminalReady,
        dependencyGeneration: UInt64,
        operationGeneration: UInt64,
        contextGeneration: UInt64
    ) {
        guard self.dependencyGeneration == dependencyGeneration,
              self.operationGeneration == operationGeneration,
              self.contextGeneration == contextGeneration,
              responseFence.activeRequest?.requestID == ready.requestID,
              responseFence.activeRequest?.context == ready.context else {
            return
        }
        let message = AgentTerminalHostMessage.error(AgentTerminalError(
            requestID: ready.requestID,
            context: ready.context,
            ptySessionName: ready.ptySessionName,
            code: .sessionEnded
        ))
        _ = responseFence.accept(message)
        responseOperationGeneration = nil
        responseContextGeneration = nil
        descriptor = nil
        contextGenerationIncrement()
        detachCurrentTerminal()
        deliver(message)
    }

    private func clearDescriptorAndTerminal() {
        descriptor = nil
        contextGenerationIncrement()
        operationGeneration &+= 1
        openTask?.cancel()
        openTask = nil
        attachTask?.cancel()
        attachTask = nil
        detachCurrentTerminal()
    }

    private func invalidateOperations(preservingDescriptor: Bool) {
        dependencyGeneration &+= 1
        operationGeneration &+= 1
        updatesTask?.cancel()
        openTask?.cancel()
        attachTask?.cancel()
        updatesTask = nil
        openTask = nil
        attachTask = nil
        responseFence.cancel()
        responseOperationGeneration = nil
        responseContextGeneration = nil
        detachCurrentTerminal()
        if !preservingDescriptor {
            descriptor = nil
            contextGenerationIncrement()
        }
    }

    private func recoverDedicatedTerminalConnection() {
        guard descriptor != nil, coordinator != nil, sessionOpener != nil else {
            interrupt(.transportLoss)
            return
        }
        operationGeneration &+= 1
        openTask?.cancel()
        attachTask?.cancel()
        openTask = nil
        attachTask = nil
        responseFence.cancel()
        responseOperationGeneration = nil
        responseContextGeneration = nil
        detachCurrentTerminal()
        resumeDescriptorIfPossible()
    }

    private func detachCurrentTerminal() {
        terminalContent?.resignFocus()
        terminalContent?.detach()
        activeTerminal = nil
        setPresented(false)
    }

    private func clearOpenTask(
        dependencyGeneration: UInt64,
        operationGeneration: UInt64,
        contextGeneration: UInt64
    ) {
        guard self.dependencyGeneration == dependencyGeneration,
              self.operationGeneration == operationGeneration,
              self.contextGeneration == contextGeneration else {
            return
        }
        openTask = nil
    }

    private func clearAttachTask(
        dependencyGeneration: UInt64,
        operationGeneration: UInt64,
        contextGeneration: UInt64
    ) {
        guard self.dependencyGeneration == dependencyGeneration,
              self.operationGeneration == operationGeneration,
              self.contextGeneration == contextGeneration else {
            return
        }
        attachTask = nil
    }

    private func contextGenerationIncrement() {
        contextGeneration &+= 1
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
              activeTerminal.operationGeneration == operationGeneration,
              activeTerminal.contextGeneration == contextGeneration else {
            return
        }
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
        clearDescriptorAndTerminal()
        deliver(message)
    }

    func ptyTerminalContent(
        _ content: PtyTerminalSwiftTermContentView,
        didFail error: Error
    ) {
        guard let activeTerminal,
              activeTerminal.operationGeneration == operationGeneration,
              activeTerminal.contextGeneration == contextGeneration else {
            return
        }
        if descriptor?.wasReportedReady == true {
            logger.error("active agent terminal transport failed: \(String(describing: error), privacy: .public)")
            recoverDedicatedTerminalConnection()
            return
        }
        failCurrentReady(
            activeTerminal.ready,
            dependencyGeneration: dependencyGeneration,
            operationGeneration: activeTerminal.operationGeneration,
            contextGeneration: activeTerminal.contextGeneration,
            error: error
        )
    }

    func ptyTerminalContentDidDetachByManager(_ content: PtyTerminalSwiftTermContentView) {
        guard let activeTerminal,
              activeTerminal.operationGeneration == operationGeneration,
              activeTerminal.contextGeneration == contextGeneration else {
            return
        }
        let message = AgentTerminalHostMessage.error(AgentTerminalError(
            requestID: activeTerminal.ready.requestID,
            context: activeTerminal.ready.context,
            ptySessionName: activeTerminal.ready.ptySessionName,
            code: .sessionEnded
        ))
        guard responseFence.accept(message) != nil else { return }
        responseOperationGeneration = nil
        responseContextGeneration = nil
        clearDescriptorAndTerminal()
        deliver(message)
    }
}
