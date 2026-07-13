import AppKit
import Foundation
import PtyClientSwift
import PtyTerminalSwiftTerm
import os

public enum SwiftTermPtyManagerTerminalSpawnError: Error, Equatable {
    case managerUnavailable(String)
}

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

    public func spawn(cwd: URL, into frame: CGRect, completion: @escaping (Result<TerminalEmulatorWindow, Error>) -> Void) {
        DispatchQueue.main.async {
            let window = SwiftTermPtyManagerTerminalWindow(cwd: cwd, frame: frame)
            Task {
                do {
                    let connection = try await self.client.openSession(
                        name: TerminalSessionName.make(for: cwd),
                        launch: .shell(cwd: cwd.path, shell: self.shell),
                        lifetime: .persistent,
                        columns: UInt32(window.columns),
                        rows: UInt32(window.rows),
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
            let window = SwiftTermPtyManagerTerminalWindow(cwd: cwd, frame: frame)
            Task {
                do {
                    let connection = try await self.client.openSession(
                        name: session.name,
                        launch: .shell(cwd: session.cwd, shell: session.shell),
                        lifetime: .persistent,
                        columns: UInt32(window.columns),
                        rows: UInt32(window.rows),
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

final class SwiftTermPtyManagerTerminalWindow: NSObject,
    TerminalEmulatorWindow,
    NSWindowDelegate,
    PtyTerminalSwiftTermContentViewDelegate
{
    private let window: NSWindow
    private let terminalContent: PtyTerminalSwiftTermContentView
    private let cwd: URL
    private let logger = Logger(subsystem: "com.example.agentdesk.agent-workspace-ide", category: "terminal")
    private var closed = false

    var columns: Int { terminalContent.columns }
    var rows: Int { terminalContent.rows }

    var isOpen: Bool { !closed }

    var assignedDesktopWindowID: UInt32? {
        guard window.windowNumber > 0 else { return nil }
        return UInt32(window.windowNumber)
    }

    init(
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
        window.setAccessibilityIdentifier("terminal-window-\(cwd.path)")
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
            terminalContent.feedOutput(Data("\r\n[terminal renderer unavailable: \(error)]\r\n".utf8))
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
        guard markClosed() else { return }
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

    func windowWillClose(_ notification: Notification) {
        _ = markClosed()
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
        content.feedOutput(Data(text.utf8))
    }

    func ptyTerminalContent(
        _ content: PtyTerminalSwiftTermContentView,
        didFail error: Error
    ) {
        logger.error("pty manager event stream failed: \(String(describing: error), privacy: .public)")
    }

    func ptyTerminalContentDidDetachByManager(_ content: PtyTerminalSwiftTermContentView) {
        guard !closed else { return }
        closed = true
        window.alphaValue = 1
        window.orderOut(nil)
        window.close()
    }

    private func markClosed() -> Bool {
        guard !closed else { return false }
        closed = true
        terminalContent.detach()
        return true
    }

}
