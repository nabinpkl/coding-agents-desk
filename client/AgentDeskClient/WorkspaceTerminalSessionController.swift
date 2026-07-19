import AgentDeskWire
import Foundation
import OSLog
import UIKit

@MainActor
final class WorkspaceTerminalSessionController: WorkspaceTerminalViewDelegate {
    private struct ActiveRequest {
        let open: WorkspaceTerminalOpen
        let generation: UInt64
        var ptySessionName: String?
    }

    private let logger = Logger(subsystem: Config.logSubsystem, category: "workspace-terminal")
    private let container: UIView
    private let stateStore: WorkspaceWorkbenchStateStoring
    private let makeRequestID: () -> String
    private weak var coordinator: (any WorkspaceTerminalCoordinating)?
    private weak var sessionOpener: (any WorkspaceTerminalSessionOpening)?

    private var terminalViews: [String: WorkspaceTerminalView] = [:]
    private var selectedWorkspaceID: String?
    private var operationGeneration: UInt64 = 0
    private var activeRequest: ActiveRequest?
    private var updatesTask: Task<Void, Never>?
    private var openTask: Task<Void, Never>?
    private var attachTask: Task<Void, Never>?
    private var isTornDown = false

    var selectedWorkspaceIDForTesting: String? { selectedWorkspaceID }
    var cachedTerminalCountForTesting: Int { terminalViews.count }

    init(
        container: UIView,
        coordinator: (any WorkspaceTerminalCoordinating)?,
        sessionOpener: (any WorkspaceTerminalSessionOpening)?,
        stateStore: WorkspaceWorkbenchStateStoring,
        makeRequestID: @escaping () -> String = { UUID().uuidString }
    ) {
        self.container = container
        self.coordinator = coordinator
        self.sessionOpener = sessionOpener
        self.stateStore = stateStore
        self.makeRequestID = makeRequestID
        startUpdates()
    }

    deinit {
        updatesTask?.cancel()
        openTask?.cancel()
        attachTask?.cancel()
    }

    func selectWorkspace(id: String?, name: String?) {
        guard !isTornDown else { return }
        guard let id else {
            let cancellation = invalidateCurrentRequest(detach: true)
            selectedWorkspaceID = nil
            terminalViews.values.forEach { $0.isHidden = true }
            sendCancellation(cancellation)
            return
        }

        if selectedWorkspaceID == id {
            if let name { terminalViews[id]?.updateWorkspaceName(name) }
            return
        }

        let cancellation = invalidateCurrentRequest(detach: true)
        selectedWorkspaceID = id
        let terminalView = terminalView(workspaceID: id, workspaceName: name ?? id)
        terminalViews.values.forEach { $0.isHidden = $0 !== terminalView }
        beginOpen(workspaceID: id, terminalView: terminalView, after: cancellation)
    }

    func teardown() {
        guard !isTornDown else { return }
        isTornDown = true
        let cancellation = invalidateCurrentRequest(detach: true)
        selectedWorkspaceID = nil
        updatesTask?.cancel()
        updatesTask = nil
        terminalViews.values.forEach {
            $0.delegate = nil
            $0.detach()
        }
        sendCancellation(cancellation)
        coordinator = nil
        sessionOpener = nil
    }

    func setPresented(_ presented: Bool) {
        guard !presented, let selectedWorkspaceID else { return }
        terminalViews[selectedWorkspaceID]?.resignFocus()
    }

    func terminalViewForTesting(workspaceID: String) -> WorkspaceTerminalView? {
        terminalViews[workspaceID]
    }

    func workspaceTerminalViewRequestedRetry(_ view: WorkspaceTerminalView) {
        guard !isTornDown, selectedWorkspaceID == view.workspaceID else { return }
        let cancellation = invalidateCurrentRequest(detach: true)
        beginOpen(workspaceID: view.workspaceID, terminalView: view, after: cancellation)
    }

    func workspaceTerminalViewDidLoseConnection(_ view: WorkspaceTerminalView) {
        guard !isTornDown, selectedWorkspaceID == view.workspaceID else { return }
        let cancellation = invalidateCurrentRequest(detach: false)
        clearPreferredSessionName(for: view.workspaceID)
        sendCancellation(cancellation)
    }

    private func startUpdates() {
        guard let coordinator else { return }
        updatesTask = Task { [weak self, weak coordinator] in
            guard let coordinator else { return }
            for await message in coordinator.workspaceTerminalUpdates {
                guard !Task.isCancelled else { return }
                self?.receive(message)
            }
        }
    }

    private func terminalView(
        workspaceID: String,
        workspaceName: String
    ) -> WorkspaceTerminalView {
        if let existing = terminalViews[workspaceID] {
            existing.updateWorkspaceName(workspaceName)
            return existing
        }

        let view = WorkspaceTerminalView(workspaceID: workspaceID, workspaceName: workspaceName)
        view.translatesAutoresizingMaskIntoConstraints = false
        view.delegate = self
        view.isHidden = true
        container.addSubview(view)
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            view.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            view.topAnchor.constraint(equalTo: container.topAnchor),
            view.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
        terminalViews = terminalViews.merging([workspaceID: view]) { _, replacement in replacement }
        return view
    }

    private func beginOpen(
        workspaceID: String,
        terminalView: WorkspaceTerminalView,
        after cancellation: WorkspaceTerminalCancel?
    ) {
        guard let coordinator, sessionOpener != nil else {
            terminalView.showFailure("No active Mac session.")
            sendCancellation(cancellation)
            return
        }

        operationGeneration &+= 1
        let generation = operationGeneration
        let request = WorkspaceTerminalOpen(
            requestID: makeRequestID(),
            workspaceID: workspaceID,
            preferredSessionName: stateStore.state(for: workspaceID).preferredTerminalSessionName,
            columns: terminalView.columns,
            rows: terminalView.rows
        )
        activeRequest = ActiveRequest(open: request, generation: generation)
        terminalView.showConnecting()
        openTask = Task { [weak self, weak coordinator] in
            do {
                guard let coordinator else { throw CancellationError() }
                if let cancellation {
                    try? await coordinator.sendWorkspaceTerminal(.cancel(cancellation))
                }
                try Task.checkCancellation()
                try await coordinator.sendWorkspaceTerminal(.open(request))
            } catch is CancellationError {
            } catch {
                self?.failOpen(request, generation: generation, error: error)
            }
            self?.clearOpenTask(generation: generation)
        }
    }

    private func receive(_ message: WorkspaceTerminalHostMessage) {
        guard !isTornDown else { return }
        guard let current = activeRequest,
              current.open.requestID == message.requestID,
              current.open.workspaceID == message.workspaceID,
              selectedWorkspaceID == message.workspaceID else {
            cancelStale(message)
            return
        }

        switch message {
        case .ready(let ready):
            attach(ready, generation: current.generation)
        case .error(let error):
            handle(error, generation: current.generation)
        }
    }

    private func attach(_ ready: WorkspaceTerminalReady, generation: UInt64) {
        guard attachTask == nil,
              let coordinator,
              let sessionOpener,
              let terminalView = terminalViews[ready.workspaceID] else {
            return
        }
        activeRequest?.ptySessionName = ready.ptySessionName
        let attachment = WorkspaceTerminalAttachmentRequest(
            sessionName: ready.ptySessionName,
            columns: terminalView.columns,
            rows: terminalView.rows
        )
        attachTask = Task { [weak self, weak coordinator, weak sessionOpener] in
            do {
                guard let sessionOpener else { throw CancellationError() }
                let connection = try await sessionOpener.openWorkspaceTerminal(attachment)
                guard self?.isCurrent(ready, generation: generation) == true else {
                    try? await connection.detach()
                    return
                }
                guard connection.sessionName == ready.ptySessionName else {
                    try? await connection.detach()
                    self?.failAttach(
                        ready,
                        generation: generation,
                        error: WorkspaceTerminalClientError.identityMismatch
                    )
                    return
                }
                terminalView.bind(connection)
                guard let coordinator else { throw CancellationError() }
                try await coordinator.sendWorkspaceTerminal(.attached(WorkspaceTerminalAttachedAck(
                    requestID: ready.requestID,
                    workspaceID: ready.workspaceID,
                    ptySessionName: ready.ptySessionName
                )))
                guard self?.isCurrent(ready, generation: generation) == true else {
                    terminalView.detach()
                    return
                }
                self?.rememberSessionName(ready.ptySessionName, for: ready.workspaceID)
            } catch is CancellationError {
            } catch {
                self?.failAttach(ready, generation: generation, error: error)
            }
            self?.clearAttachTask(generation: generation)
        }
    }

    private func handle(_ error: WorkspaceTerminalError, generation: UInt64) {
        guard activeRequest?.generation == generation,
              selectedWorkspaceID == error.workspaceID else { return }
        openTask?.cancel()
        openTask = nil
        attachTask?.cancel()
        attachTask = nil
        activeRequest = nil
        terminalViews[error.workspaceID]?.detach()
        if error.code == .invalidSession || error.code == .sessionEnded {
            clearPreferredSessionName(for: error.workspaceID)
        }
        terminalViews[error.workspaceID]?.showFailure(message(for: error.code))
    }

    private func failOpen(
        _ open: WorkspaceTerminalOpen,
        generation: UInt64,
        error: Error
    ) {
        guard activeRequest?.generation == generation,
              activeRequest?.open.requestID == open.requestID else { return }
        logger.error("workspace terminal open failed: \(String(describing: error), privacy: .public)")
        openTask = nil
        activeRequest = nil
        terminalViews[open.workspaceID]?.showFailure("Could not contact the Mac terminal service.")
    }

    private func failAttach(
        _ ready: WorkspaceTerminalReady,
        generation: UInt64,
        error: Error
    ) {
        guard isCurrent(ready, generation: generation) else { return }
        logger.error("workspace terminal attach failed: \(String(describing: error), privacy: .public)")
        terminalViews[ready.workspaceID]?.detach()
        terminalViews[ready.workspaceID]?.showFailure("Could not attach the workspace terminal.")
        let cancellation = invalidateCurrentRequest(detach: false)
        sendCancellation(cancellation)
    }

    private func isCurrent(_ ready: WorkspaceTerminalReady, generation: UInt64) -> Bool {
        guard let activeRequest else { return false }
        return !isTornDown
            && activeRequest.generation == generation
            && activeRequest.open.requestID == ready.requestID
            && activeRequest.open.workspaceID == ready.workspaceID
            && activeRequest.ptySessionName == ready.ptySessionName
            && selectedWorkspaceID == ready.workspaceID
    }

    private func invalidateCurrentRequest(detach: Bool) -> WorkspaceTerminalCancel? {
        operationGeneration &+= 1
        openTask?.cancel()
        openTask = nil
        attachTask?.cancel()
        attachTask = nil
        let cancellation = activeRequest.map {
            WorkspaceTerminalCancel(
                requestID: $0.open.requestID,
                workspaceID: $0.open.workspaceID,
                ptySessionName: $0.ptySessionName
            )
        }
        if detach, let workspaceID = selectedWorkspaceID {
            terminalViews[workspaceID]?.detach()
        }
        activeRequest = nil
        return cancellation
    }

    private func cancelStale(_ message: WorkspaceTerminalHostMessage) {
        guard case .ready(let ready) = message else { return }
        sendCancellation(WorkspaceTerminalCancel(
            requestID: ready.requestID,
            workspaceID: ready.workspaceID,
            ptySessionName: ready.ptySessionName
        ))
    }

    private func sendCancellation(_ cancellation: WorkspaceTerminalCancel?) {
        guard let cancellation, let coordinator else { return }
        Task { [weak coordinator] in
            try? await coordinator?.sendWorkspaceTerminal(.cancel(cancellation))
        }
    }

    private func rememberSessionName(_ sessionName: String, for workspaceID: String) {
        var state = stateStore.state(for: workspaceID)
        state.preferredTerminalSessionName = sessionName
        stateStore.setState(state, for: workspaceID)
    }

    private func clearPreferredSessionName(for workspaceID: String) {
        var state = stateStore.state(for: workspaceID)
        state.preferredTerminalSessionName = nil
        stateStore.setState(state, for: workspaceID)
    }

    private func clearOpenTask(generation: UInt64) {
        guard activeRequest?.generation == generation else { return }
        openTask = nil
    }

    private func clearAttachTask(generation: UInt64) {
        guard activeRequest?.generation == generation else { return }
        attachTask = nil
    }

    private func message(for code: WorkspaceTerminalErrorCode) -> String {
        switch code {
        case .workspaceUnavailable: "This workspace is no longer available on the Mac."
        case .invalidSession: "The remembered workspace terminal is no longer valid."
        case .launchFailed: "The Mac could not start a workspace shell."
        case .handoffTimedOut: "The workspace terminal handoff timed out."
        case .sessionEnded: "The workspace terminal ended on the Mac."
        }
    }
}

private enum WorkspaceTerminalClientError: Error {
    case identityMismatch
}
