import AgentDeskWire
import AppKit
import OSLog
import PtyClientSwift
import PtyTerminalSwiftTerm

@MainActor
final class WorkspaceIDEMacTerminalController: NSObject, PtyTerminalSwiftTermContentViewDelegate {
    let contentView = PtyTerminalSwiftTermContentView()

    private let endpoint: WorkspaceTerminalEndpoint
    nonisolated(unsafe) private let ptyClient: PtyClient
    private let defaults: UserDefaults
    private let logger = Logger(subsystem: Config.logSubsystem, category: "workspace-ide-terminal")

    private var selectedWorkspaceID: String?
    private var activeRequest: WorkspaceTerminalOpen?
    private var operationGeneration: UInt64 = 0
    private var openTask: Task<Void, Never>?
    private var isWindowPresented = false

    init(
        endpoint: WorkspaceTerminalEndpoint,
        ptyClient: PtyClient = PtyManagerSocketClient.makeClient(),
        defaults: UserDefaults = .standard
    ) {
        self.endpoint = endpoint
        self.ptyClient = ptyClient
        self.defaults = defaults
        super.init()
        contentView.delegate = self
        contentView.setAccessibilityIdentifier("workspace-ide-terminal")
        contentView.setAccessibilityLabel("Workspace terminal")
    }

    func selectWorkspace(id: String?, name _: String?) {
        selectedWorkspaceID = id
        restartIfPresented()
    }

    func setWindowPresented(_ presented: Bool) {
        guard isWindowPresented != presented else { return }
        isWindowPresented = presented
        if presented {
            restartIfPresented()
        } else {
            invalidate(detach: true)
        }
    }

    func setPanePresented(_ presented: Bool) {
        if presented {
            if isWindowPresented, !contentView.isBound { restartIfPresented() }
        } else {
            contentView.resignFocus()
        }
    }

    func setZoomScale(_ scale: Double) {
        contentView.setFontSize(PtyTerminalViewStyle.defaultFontSize * CGFloat(scale))
    }

    func stop() {
        isWindowPresented = false
        selectedWorkspaceID = nil
        invalidate(detach: true)
        contentView.delegate = nil
    }

    private func restartIfPresented() {
        guard isWindowPresented, let workspaceID = selectedWorkspaceID else { return }
        if activeRequest?.workspaceID == workspaceID, contentView.isBound { return }
        invalidate(detach: true)
        beginOpen(workspaceID: workspaceID)
    }

    private func beginOpen(workspaceID: String) {
        operationGeneration &+= 1
        let generation = operationGeneration
        let request = WorkspaceTerminalOpen(
            requestID: UUID().uuidString,
            workspaceID: workspaceID,
            preferredSessionName: preferredSessionName(for: workspaceID),
            columns: UInt32(max(contentView.columns, 1)),
            rows: UInt32(max(contentView.rows, 1))
        )
        activeRequest = request
        openTask = Task { [weak self] in
            await self?.performOpen(request, generation: generation)
        }
    }

    private func performOpen(_ request: WorkspaceTerminalOpen, generation: UInt64) async {
        guard let response = await endpoint.openLocal(request) else {
            finishIfCurrent(request, generation: generation)
            return
        }
        guard case .ready(let ready) = response else {
            if case .error(let error) = response { logFailure(error.code) }
            finishIfCurrent(request, generation: generation)
            return
        }
        do {
            let sessions = try await ptyClient.listSessions()
            guard let session = sessions.first(where: { $0.name == ready.ptySessionName }),
                  session.state == .running,
                  session.lifetime == .persistent else {
                throw WorkspaceIDEMacTerminalError.sessionUnavailable
            }
            let connection = try await ptyClient.openSession(
                name: session.name,
                launch: .shell(cwd: session.cwd, shell: session.shell),
                lifetime: .persistent,
                columns: UInt32(max(contentView.columns, 1)),
                rows: UInt32(max(contentView.rows, 1)),
                createIfMissing: false,
                clientTitle: "Workspace IDE macOS"
            )
            guard isCurrent(request, generation: generation),
                  connection.sessionName == ready.ptySessionName,
                  connection.attachment.name == session.name,
                  connection.attachment.pid == session.pid else {
                try? await connection.detach()
                await cancel(request, ptySessionName: ready.ptySessionName)
                return
            }
            contentView.bind(to: connection)
            await endpoint.handle(.attached(WorkspaceTerminalAttachedAck(
                requestID: ready.requestID,
                workspaceID: ready.workspaceID,
                ptySessionName: ready.ptySessionName
            )))
            rememberSessionName(ready.ptySessionName, for: ready.workspaceID)
            openTask = nil
        } catch {
            logger.error("workspace IDE terminal attach failed: \(String(describing: error), privacy: .public)")
            await cancel(request, ptySessionName: ready.ptySessionName)
            finishIfCurrent(request, generation: generation)
        }
    }

    private func invalidate(detach: Bool) {
        operationGeneration &+= 1
        openTask?.cancel()
        openTask = nil
        let request = activeRequest
        activeRequest = nil
        if detach { contentView.detach() }
        if let request {
            Task { [endpoint] in
                await endpoint.handle(.cancel(WorkspaceTerminalCancel(
                    requestID: request.requestID,
                    workspaceID: request.workspaceID,
                    ptySessionName: nil
                )))
            }
        }
    }

    private func cancel(_ request: WorkspaceTerminalOpen, ptySessionName: String?) async {
        await endpoint.handle(.cancel(WorkspaceTerminalCancel(
            requestID: request.requestID,
            workspaceID: request.workspaceID,
            ptySessionName: ptySessionName
        )))
    }

    private func isCurrent(_ request: WorkspaceTerminalOpen, generation: UInt64) -> Bool {
        isWindowPresented
            && operationGeneration == generation
            && activeRequest?.requestID == request.requestID
            && selectedWorkspaceID == request.workspaceID
    }

    private func finishIfCurrent(_ request: WorkspaceTerminalOpen, generation: UInt64) {
        guard isCurrent(request, generation: generation) else { return }
        activeRequest = nil
        openTask = nil
    }

    private func preferenceKey(_ workspaceID: String) -> String {
        "agentDesk.workspaceIDE.terminal.\(workspaceID)"
    }

    private func preferredSessionName(for workspaceID: String) -> String? {
        defaults.string(forKey: preferenceKey(workspaceID))
    }

    private func rememberSessionName(_ name: String, for workspaceID: String) {
        defaults.set(name, forKey: preferenceKey(workspaceID))
    }

    private func logFailure(_ code: WorkspaceTerminalErrorCode) {
        logger.error("workspace IDE terminal open failed: \(code.rawValue, privacy: .public)")
    }

    func ptyTerminalContent(_ content: PtyTerminalSwiftTermContentView, didFail error: Error) {
        logger.error("workspace IDE terminal connection failed: \(String(describing: error), privacy: .public)")
        activeRequest = nil
        contentView.detach()
        restartIfPresented()
    }

    func ptyTerminalContentDidDetachByManager(_ content: PtyTerminalSwiftTermContentView) {
        activeRequest = nil
        restartIfPresented()
    }
}

private enum WorkspaceIDEMacTerminalError: Error {
    case sessionUnavailable
}
