import AppKit
import Foundation
import PtyClientSwift
import PtyTerminalSession
import PtyTerminalWebView
import os

@MainActor
final class WebPtyManagerTerminalWindow: NSObject,
    TerminalEmulatorWindow,
    TerminalWindowPresentationTrackable,
    TerminalWindowReplayInspectable,
    NSWindowDelegate,
    PtyTerminalWebViewDelegate
{
    private let window: NSWindow
    private let terminalContent: PtyTerminalWebView
    private let initialSessionName: String
    private let workspaceBackend: LocalTerminalWorkspaceBackend
    private let cwd: URL
    private let logger = Logger(subsystem: "agentdesk.workspace-ide", category: "terminal")
    private var closed = false
    private var frameChanged: ((CGRect) -> Void)?
    private var workspaceChanged: ((PtyTerminalWorkspaceState) -> Void)?
    private var presentationClosed: ((TerminalWindowCloseReason) -> Void)?

    var attachmentDimensions: PtyTerminalDimensions { terminalContent.attachmentDimensions }

    var isOpen: Bool { !closed }
    var currentFrame: CGRect { window.frame }
    var terminalWorkspaceState: PtyTerminalWorkspaceState { terminalContent.workspaceState }

    var replayDiagnostics: TerminalWindowReplayDiagnostics {
        let viewport = terminalContent.viewportStatus
        return TerminalWindowReplayDiagnostics(
            columns: UInt32(terminalContent.columns),
            rows: UInt32(terminalContent.rows),
            revision: terminalContent.appliedRevision,
            fitScale: Double(terminalContent.fitScale),
            viewportCropped: terminalContent.isViewportCropped,
            synchronizing: terminalContent.isSynchronizing,
            ownershipEpoch: viewport?.ownershipEpoch ?? 0,
            ownerClientID: viewport?.ownerClientID ?? 0,
            isOwner: viewport?.isOwner ?? false,
            sourceColumns: viewport?.sourceDimensions.columns ?? 0,
            sourceRows: viewport?.sourceDimensions.rows ?? 0,
            sourceRevision: viewport?.sourceRevision ?? 0,
            viewColumns: viewport?.viewDimensions.columns ?? 0,
            viewRows: viewport?.viewDimensions.rows ?? 0
        )
    }

    func claimViewportForReplay() {
        terminalContent.claimViewportOwnership()
    }

    func flushViewportForReplay() {
        terminalContent.flushViewportResize()
    }

    func sendInputForReplay(_ text: String) {
        terminalContent.sendInput(Data(text.utf8))
    }

    var assignedDesktopWindowID: UInt32? {
        guard window.windowNumber > 0 else { return nil }
        return UInt32(window.windowNumber)
    }

    init(
        sessionName: String,
        cwd: URL,
        frame: CGRect,
        client: PtyClient,
        shell: String,
        restoredWorkspace: PtyTerminalWorkspaceState? = nil
    ) {
        self.cwd = cwd
        initialSessionName = sessionName
        workspaceBackend = LocalTerminalWorkspaceBackend(client: client, cwd: cwd.path, shell: shell)
        terminalContent = PtyTerminalWebView(profile: .workspace)
        terminalContent.autoresizingMask = [.width, .height]

        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = cwd.lastPathComponent.isEmpty ? cwd.path : cwd.lastPathComponent
        window.setAccessibilityIdentifier("terminal-window-\(sessionName)")
        window.setAccessibilityLabel("Terminal \(window.title)")
        window.setAccessibilityHelp("Terminal session rooted at \(cwd.path)")
        window.isReleasedWhenClosed = false
        window.hidesOnDeactivate = false
        window.level = .normal
        window.contentView = terminalContent
        super.init()
        window.delegate = self
        terminalContent.delegate = self
        if let restoredWorkspace { terminalContent.restoreWorkspaceState(restoredWorkspace) }
        if let error = terminalContent.rendererSetupError {
            terminalContent.feedLocalStatus(Data("\r\n[terminal renderer unavailable: \(error)]\r\n".utf8))
        }
    }

    func attach(_ connection: PtySessionConnection) {
        guard !closed else { return }
        terminalContent.bindWorkspaceInitialSession(
            connection, sessionName: initialSessionName, title: window.title
        )
        terminalContent.configureWorkspaceBackend(workspaceBackend)
    }

    func attachWorkspace(_ connections: [String: PtySessionConnection]) {
        guard !closed else { return }
        for pane in terminalContent.workspaceState.panes {
            guard let connection = connections[pane.paneID] else { continue }
            terminalContent.bindWorkspaceSession(connection, paneID: pane.paneID)
        }
        terminalContent.configureWorkspaceBackend(workspaceBackend)
    }

    func place(into frame: CGRect) {
        guard !closed else { return }
        window.setFrame(frame, display: window.isVisible)
    }

    func park() {
        guard !closed else { return }
        terminalContent.setViewportActive(false)
        window.orderOut(nil)
    }

    func unpark(into frame: CGRect) {
        guard !closed else { return }
        window.setFrame(frame, display: true)
        window.orderFrontRegardless()
        terminalContent.setViewportActive(true, claim: true)
        terminalContent.focus()
    }

    func raise() {
        guard !closed else { return }
        window.orderFrontRegardless()
        terminalContent.setViewportActive(true, claim: true)
        terminalContent.focus()
    }

    func prepareForAssignedDesktop(into frame: CGRect) {
        guard !closed else { return }
        window.setFrame(frame, display: false)
        window.alphaValue = 0
        window.orderBack(nil)
        window.displayIfNeeded()
    }

    func revealAfterAssignedDesktop(into frame: CGRect, focus: Bool) {
        guard !closed else { return }
        window.setFrame(frame, display: true)
        window.alphaValue = 1
        window.orderFrontRegardless()
        terminalContent.setViewportActive(true, claim: focus)
        if focus {
            terminalContent.focus()
        }
    }

    func close() {
        guard markClosed(reason: .user, notifyPresentation: true) else { return }
        window.alphaValue = 1
        window.orderOut(nil)
        window.close()
    }

    func setTerminalFontSize(_ pointSize: CGFloat) {
        guard !closed else { return }
        terminalContent.setFontSize(pointSize)
    }

    func setWorkspaceLabel(_ workspaceName: String) {
        guard !closed else { return }
        let terminalName = cwd.lastPathComponent.isEmpty ? cwd.path : cwd.lastPathComponent
        window.title = "\(terminalName) - \(workspaceName)"
        window.setAccessibilityLabel("Terminal \(workspaceName)")
        window.setAccessibilityHelp("Terminal session rooted at \(cwd.path) for workspace \(workspaceName)")
    }

    func focusForAccessibility() {
        guard !closed else { return }
        window.orderFrontRegardless()
        terminalContent.focus()
    }

    func observePresentation(
        frameChanged: @escaping (CGRect) -> Void,
        workspaceChanged: @escaping (PtyTerminalWorkspaceState) -> Void,
        closed: @escaping (TerminalWindowCloseReason) -> Void
    ) {
        self.frameChanged = frameChanged
        self.workspaceChanged = workspaceChanged
        presentationClosed = closed
    }

    func orderWithoutFocus() {
        guard !closed else { return }
        window.orderFront(nil)
        terminalContent.setViewportActive(true, claim: false)
    }

    func closePreservingPresentation() {
        guard markClosed(reason: .user, notifyPresentation: false) else { return }
        window.orderOut(nil)
        window.close()
    }

    func windowWillClose(_ notification: Notification) {
        _ = markClosed(reason: .user, notifyPresentation: true)
    }

    func windowDidMove(_ notification: Notification) {
        frameChanged?(window.frame)
    }

    func windowDidResize(_ notification: Notification) {
        frameChanged?(window.frame)
    }

    func windowDidEndLiveResize(_ notification: Notification) {
        terminalContent.flushViewportResize()
    }

    func windowDidBecomeKey(_ notification: Notification) {
        terminalContent.claimViewportOwnership()
    }

    func windowDidMiniaturize(_ notification: Notification) {
        terminalContent.setViewportActive(false)
    }

    func windowDidDeminiaturize(_ notification: Notification) {
        terminalContent.setViewportActive(true, claim: false)
    }

    func ptyTerminalContent(
        _ content: PtyTerminalWebView,
        didSetTitle title: String
    ) {
        guard !title.isEmpty else { return }
        window.title = title
    }

    func ptyTerminalContent(
        _ content: PtyTerminalWebView,
        didReceiveStatus text: String
    ) {
        // Do not feed this back into `content`. Runtime status already reaches the
        // renderer through `feedStatus`, so echoing it drew every line twice -- and while
        // the display path still announced what it displayed, it recursed until the stack
        // guard page killed the host. This is a notification; the other two delegates in
        // this repo log it, so this one does too.
        guard !closed else { return }
        logger.info("pty manager terminal status: \(text, privacy: .public)")
    }

    func ptyTerminalContent(
        _ content: PtyTerminalWebView,
        didFail error: Error
    ) {
        logger.error("pty manager event stream failed: \(String(describing: error), privacy: .public)")
    }

    func ptyTerminalContentDidDetachByManager(_ content: PtyTerminalWebView) {
        closeAfterSessionExit()
    }

    func ptyTerminalContentDidDetachByManager(
        _ content: PtyTerminalWebView,
        terminalID: String
    ) {
        if content.workspaceState.panes.count > 1 {
            content.removeEndedWorkspaceTerminal(terminalID: terminalID)
        } else {
            closeAfterSessionExit()
        }
    }

    func ptyTerminalContent(
        _ content: PtyTerminalWebView,
        didUpdateWorkspace state: PtyTerminalWorkspaceState
    ) {
        workspaceChanged?(state)
    }

    func ptyTerminalContent(
        _ content: PtyTerminalWebView,
        didTerminate termination: PtyTerminalSessionTermination
    ) {
        closeAfterSessionExit()
    }

    func ptyTerminalContent(
        _ content: PtyTerminalWebView,
        didTerminate termination: PtyTerminalSessionTermination,
        terminalID: String
    ) {
        if content.workspaceState.panes.count > 1 {
            content.removeEndedWorkspaceTerminal(terminalID: terminalID)
        } else {
            closeAfterSessionExit()
        }
    }

    private func closeAfterSessionExit() {
        guard markClosed(reason: .sessionExited, notifyPresentation: true) else { return }
        window.alphaValue = 1
        window.orderOut(nil)
        window.close()
    }

    private func markClosed(
        reason: TerminalWindowCloseReason,
        notifyPresentation: Bool
    ) -> Bool {
        guard !closed else { return false }
        closed = true
        terminalContent.setViewportActive(false)
        terminalContent.detach()
        if notifyPresentation { presentationClosed?(reason) }
        return true
    }

}
