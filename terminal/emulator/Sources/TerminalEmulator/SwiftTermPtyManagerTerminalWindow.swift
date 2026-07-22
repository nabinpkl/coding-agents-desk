import AppKit
import Foundation
import PtyClientSwift
import PtyTerminalSession
import PtyTerminalSwiftTerm
import os

public enum SwiftTermPtyManagerTerminalSpawnError: Error, Equatable {
    case managerUnavailable(String)
}

@MainActor
public final class SwiftTermPtyManagerTerminalSpawn: TerminalEmulatorSpawn {
    private let client: PtyClient
    private let shell: String

    // `client` is required (no default): a defaulted `PtyClient()` would silently dial the donor's
    // `/tmp/pty-manager.sock`, defeating AgentDesk's bundle-scoped socket. Callers inject a client
    // bound to their own socket (the host passes `PtyManagerSocketClient.makeClient()`).
    public init(
        client: PtyClient,
        shell: String = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
    ) {
        self.client = client
        self.shell = shell
    }

    public func spawn(
        sessionName: String,
        cwd: URL,
        into frame: CGRect,
        completion: @escaping (Result<TerminalEmulatorWindow, Error>) -> Void
    ) {
        DispatchQueue.main.async {
            let window = SwiftTermPtyManagerTerminalWindow(sessionName: sessionName, cwd: cwd, frame: frame)
            Task {
                do {
                    let dimensions = await MainActor.run { window.attachmentDimensions }
                    let connection = try await self.client.openSession(
                        name: sessionName,
                        launch: .shell(cwd: cwd.path, shell: self.shell),
                        lifetime: .persistent,
                        columns: dimensions.columns,
                        rows: dimensions.rows,
                        createIfMissing: true,
                        clientTitle: "Workspace Terminal"
                    )
                    await MainActor.run {
                        window.attach(connection)
                        completion(.success(window))
                    }
                } catch {
                    await MainActor.run {
                        window.close()
                        completion(.failure(SwiftTermPtyManagerTerminalSpawnError.managerUnavailable("\(error)")))
                    }
                }
            }
        }
    }

    public func spawnExistingSession(
        _ session: PtySessionSummary,
        into frame: CGRect,
        completion: @escaping (Result<TerminalEmulatorWindow, Error>) -> Void
    ) {
        DispatchQueue.main.async {
            let cwd = URL(fileURLWithPath: session.cwd, isDirectory: true)
            let window = SwiftTermPtyManagerTerminalWindow(sessionName: session.name, cwd: cwd, frame: frame)
            Task {
                do {
                    let dimensions = await MainActor.run { window.attachmentDimensions }
                    let connection = try await self.client.openSession(
                        name: session.name,
                        launch: .shell(cwd: session.cwd, shell: session.shell),
                        lifetime: .persistent,
                        columns: dimensions.columns,
                        rows: dimensions.rows,
                        createIfMissing: false,
                        clientTitle: "PTY Manager"
                    )
                    await MainActor.run {
                        window.attach(connection)
                        completion(.success(window))
                    }
                } catch {
                    await MainActor.run {
                        window.close()
                        completion(.failure(SwiftTermPtyManagerTerminalSpawnError.managerUnavailable("\(error)")))
                    }
                }
            }
        }
    }
}

@MainActor
final class SwiftTermPtyManagerTerminalWindow: NSObject,
    TerminalEmulatorWindow,
    TerminalWindowPresentationTrackable,
    TerminalWindowReplayInspectable,
    NSWindowDelegate,
    PtyTerminalSwiftTermContentViewDelegate
{
    private let window: NSWindow
    private let terminalContent: PtyTerminalSwiftTermContentView
    private let cwd: URL
    private let logger = Logger(subsystem: "com.example.agentdesk.agent-workspace-ide", category: "terminal")
    private var closed = false
    private var frameChanged: ((CGRect) -> Void)?
    private var presentationClosed: ((TerminalWindowCloseReason) -> Void)?

    var attachmentDimensions: PtyTerminalDimensions { terminalContent.attachmentDimensions }

    var isOpen: Bool { !closed }
    var currentFrame: CGRect { window.frame }

    var replayDiagnostics: TerminalWindowReplayDiagnostics {
        TerminalWindowReplayDiagnostics(
            columns: terminalContent.authoritativeDimensions.columns,
            rows: terminalContent.authoritativeDimensions.rows,
            revision: terminalContent.appliedRevision,
            fitScale: Double(terminalContent.fitScale),
            synchronizing: terminalContent.isSynchronizing
        )
    }

    var assignedDesktopWindowID: UInt32? {
        guard window.windowNumber > 0 else { return nil }
        return UInt32(window.windowNumber)
    }

    init(
        sessionName: String,
        cwd: URL,
        frame: CGRect,
        terminalStyle: PtyTerminalViewStyle = PtyTerminalViewStyle(
            metalRendering: PtyTerminalMetalRendering.from()
        )
    ) {
        self.cwd = cwd
        terminalContent = PtyTerminalSwiftTermContentView(style: terminalStyle)
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
        window.minSize = NSSize(width: 480, height: 320)
        window.contentView = terminalContent
        super.init()
        window.delegate = self
        terminalContent.delegate = self
        if let error = terminalContent.rendererSetupError {
            terminalContent.feedLocalStatus(Data("\r\n[terminal renderer unavailable: \(error)]\r\n".utf8))
        }
    }

    func attach(_ connection: PtySessionConnection) {
        guard !closed else { return }
        terminalContent.bind(to: connection)
    }

    func place(into frame: CGRect) {
        guard !closed else { return }
        window.setFrame(frame, display: window.isVisible)
    }

    func park() {
        guard !closed else { return }
        window.orderOut(nil)
    }

    func unpark(into frame: CGRect) {
        guard !closed else { return }
        window.setFrame(frame, display: true)
        window.orderFrontRegardless()
        terminalContent.focus()
    }

    func raise() {
        guard !closed else { return }
        window.orderFrontRegardless()
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
        closed: @escaping (TerminalWindowCloseReason) -> Void
    ) {
        self.frameChanged = frameChanged
        presentationClosed = closed
    }

    func orderWithoutFocus() {
        guard !closed else { return }
        window.orderFront(nil)
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

    func ptyTerminalContent(
        _ content: PtyTerminalSwiftTermContentView,
        didSetTitle title: String
    ) {
        guard !title.isEmpty else { return }
        window.title = title
    }

    func ptyTerminalContent(
        _ content: PtyTerminalSwiftTermContentView,
        didReceiveStatus text: String
    ) {
        guard !closed else { return }
        content.feedLocalStatus(Data(text.utf8))
    }

    func ptyTerminalContent(
        _ content: PtyTerminalSwiftTermContentView,
        didFail error: Error
    ) {
        logger.error("pty manager event stream failed: \(String(describing: error), privacy: .public)")
    }

    func ptyTerminalContentDidDetachByManager(_ content: PtyTerminalSwiftTermContentView) {
        closeAfterSessionExit()
    }

    func ptyTerminalContent(
        _ content: PtyTerminalSwiftTermContentView,
        didTerminate termination: PtyTerminalSessionTermination
    ) {
        closeAfterSessionExit()
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
        terminalContent.detach()
        if notifyPresentation { presentationClosed?(reason) }
        return true
    }

}
