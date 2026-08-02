import AppKit
import OSLog
import PtyClientSwift
import PtyTerminalSession
import PtyTerminalWebView

/// Drives the Workspace IDE's terminal pane as a full terminal workspace: tabs, splits and the
/// session drawer, the same surface the standalone terminal window presents. Session lifecycle is
/// not reimplemented here - `WorkspaceIDETerminalBackend` routes every pane through the workspace
/// terminal coordinator, and this controller owns only what the IDE adds: which workspace is
/// selected, whether the pane is on screen, and remembering each workspace's layout.
@MainActor
final class WorkspaceIDEMacTerminalController: NSObject, PtyTerminalWebViewDelegate {
    let contentView = PtyTerminalWebView(profile: .workspace)

    private let endpoint: WorkspaceTerminalEndpoint
    private let ptyClient: PtyClient
    private let store: WorkspaceIDETerminalWorkspaceStore
    private let logger = Logger(subsystem: Config.logSubsystem, category: "workspace-ide-terminal")

    private var selectedWorkspaceID: UUID?
    private var backend: WorkspaceIDETerminalBackend?
    private var isWindowPresented = false
    private var isPanePresented = true

    init(
        endpoint: WorkspaceTerminalEndpoint,
        ptyClient: PtyClient = PtyManagerSocketClient.makeClient(),
        store: WorkspaceIDETerminalWorkspaceStore
    ) {
        self.endpoint = endpoint
        self.ptyClient = ptyClient
        self.store = store
        super.init()
        contentView.delegate = self
        contentView.setAccessibilityIdentifier("workspace-ide-terminal")
        contentView.setAccessibilityLabel("Workspace terminal")
    }

    func selectWorkspace(id: String?, name _: String?) {
        let workspaceID = id.flatMap(UUID.init(uuidString:))
        guard workspaceID != selectedWorkspaceID else { return }
        persistWorkspaceState()
        selectedWorkspaceID = workspaceID
        restartIfPresented()
    }

    func setWindowPresented(_ presented: Bool) {
        guard isWindowPresented != presented else { return }
        isWindowPresented = presented
        let participates = presented && isPanePresented
        contentView.setViewportActive(participates, claim: participates)
        if presented {
            restartIfPresented()
        } else {
            invalidate()
        }
    }

    func setPanePresented(_ presented: Bool) {
        guard isPanePresented != presented else { return }
        isPanePresented = presented
        let participates = presented && isWindowPresented
        contentView.setViewportActive(participates, claim: participates)
        if presented {
            if isWindowPresented, !contentView.isBound { restartIfPresented() }
        } else {
            contentView.resignFocus()
        }
    }

    func claimViewportOwnership() {
        guard isWindowPresented, isPanePresented else { return }
        contentView.claimViewportOwnership()
    }

    func setZoomScale(_ scale: Double) {
        contentView.setFontSize(PtyTerminalWebView.defaultFontPointSize * CGFloat(scale))
    }

    func stop() {
        isWindowPresented = false
        persistWorkspaceState()
        selectedWorkspaceID = nil
        invalidate()
        contentView.delegate = nil
    }

    /// Rebinding a workspace means tearing down every pane first: `restoreWorkspaceState` requires
    /// an empty slot table, and the restored layout belongs to the workspace being switched to.
    private func restartIfPresented() {
        guard isWindowPresented, let workspaceID = selectedWorkspaceID else { return }
        if backend?.workspaceID == workspaceID, contentView.isBound { return }
        invalidate()
        let backend = WorkspaceIDETerminalBackend(
            workspaceID: workspaceID,
            endpoint: endpoint,
            ptyClient: ptyClient,
            clientTitle: "Workspace IDE macOS"
        )
        self.backend = backend
        contentView.restoreWorkspaceState(
            store.load(workspaceID: workspaceID) ?? PtyTerminalWorkspaceState(profile: .workspace)
        )
        contentView.configureWorkspaceBackend(backend)
        // The claim recorded before the swap referenced the previous layout's pane, so re-record it
        // against the restored one; the panes bind asynchronously and honour it as they arrive.
        if isPanePresented { contentView.claimViewportOwnership() }
    }

    private func invalidate() {
        backend = nil
        contentView.detach()
    }

    private func persistWorkspaceState() {
        guard let workspaceID = selectedWorkspaceID, contentView.isBound else { return }
        store.save(contentView.workspaceState, workspaceID: workspaceID)
    }

    func ptyTerminalContent(_ content: PtyTerminalWebView, didUpdateWorkspace state: PtyTerminalWorkspaceState) {
        guard let workspaceID = selectedWorkspaceID else { return }
        store.save(state, workspaceID: workspaceID)
    }

    func ptyTerminalContent(_ content: PtyTerminalWebView, didReceiveStatus text: String) {
        logger.info("workspace IDE terminal status: \(text, privacy: .public)")
    }

    func ptyTerminalContent(_ content: PtyTerminalWebView, didFail error: Error) {
        logger.error("workspace IDE terminal failed: \(String(describing: error), privacy: .public)")
    }

    func ptyTerminalContent(
        _ content: PtyTerminalWebView,
        didTerminate termination: PtyTerminalSessionTermination,
        terminalID: String
    ) {
        closeOrRestart(terminalID: terminalID)
    }

    func ptyTerminalContentDidDetachByManager(_ content: PtyTerminalWebView, terminalID: String) {
        closeOrRestart(terminalID: terminalID)
    }

    /// One pane ending closes that pane. The last one ending would leave the IDE with a dead
    /// terminal region, so it restarts into a fresh workspace instead.
    private func closeOrRestart(terminalID: String) {
        if contentView.workspaceState.panes.count > 1 {
            contentView.removeEndedWorkspaceTerminal(terminalID: terminalID)
            persistWorkspaceState()
            return
        }
        guard let workspaceID = selectedWorkspaceID else { return }
        store.save(PtyTerminalWorkspaceState(profile: .workspace), workspaceID: workspaceID)
        invalidate()
        restartIfPresented()
    }
}
