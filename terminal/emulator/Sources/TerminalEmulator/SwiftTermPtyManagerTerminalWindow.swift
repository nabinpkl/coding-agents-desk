import AppKit
import Foundation
import PtyClientSwift
import PtyTerminalSession
import PtyTerminalSwiftTerm
import SwiftTerm
import os

public enum SwiftTermPtyManagerTerminalSpawnError: Error, Equatable {
    case managerUnavailable(String)
}

public final class SwiftTermPtyManagerTerminalSpawn: TerminalEmulatorSpawn {
    private let client: PtyClient
    private let shell: String

    public init(
        client: PtyClient = PtyClient(),
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
                        cwd: cwd.path,
                        shell: self.shell,
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
                        cwd: session.cwd,
                        shell: session.shell,
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

final class SwiftTermPtyManagerTerminalWindow: NSObject, TerminalEmulatorWindow, NSWindowDelegate, TerminalViewDelegate, PtyTerminalRenderer {
    private static let defaultFontSize: CGFloat = 14

    private let window: NSWindow
    private let terminalView: TerminalView
    private let terminalStyle: PtyTerminalViewStyle
    private let cwd: URL
    private let logger = Logger(subsystem: "com.example.agentdesk.agent-workspace-ide", category: "terminal")
    private var sessionDriver: PtyTerminalSessionDriver?
    private var terminalFontSize = defaultFontSize
    private var closed = false

    var columns: Int { terminalView.getTerminal().cols }
    var rows: Int { terminalView.getTerminal().rows }

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
        self.terminalStyle = terminalStyle
        terminalView = PtyManagerTerminalView(
            frame: CGRect(origin: .zero, size: frame.size),
            font: PtyTerminalViewStyle.terminalFont(pointSize: Self.defaultFontSize)
        )
        terminalView.autoresizingMask = [.width, .height]
        do {
            try terminalStyle.apply(to: terminalView)
        } catch {
            terminalView.feed(text: "\r\n[terminal renderer unavailable: \(error)]\r\n")
        }

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
        window.contentView = terminalView
        super.init()
        window.delegate = self
        terminalView.terminalDelegate = self
    }

    func attach(_ connection: PtySessionConnection) {
        guard !closed else { return }
        let driver = PtyTerminalSessionDriver(
            connection: connection,
            renderer: self
        ) { [weak self] error in
            self?.logger.error("pty manager event stream failed: \(String(describing: error), privacy: .public)")
        }
        sessionDriver = driver
        driver.start()
    }

    func feedOutput(_ data: Data) {
        guard !closed else { return }
        terminalView.feed(byteArray: [UInt8](data)[...])
    }

    func feedStatus(_ text: String) {
        guard !closed else { return }
        terminalView.feed(text: text)
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
        window.makeFirstResponder(terminalView)
    }

    func raise() {
        guard !closed else { return }
        window.orderFrontRegardless()
        window.makeFirstResponder(terminalView)
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
            window.makeFirstResponder(terminalView)
        }
    }

    func close() {
        guard markClosed() else { return }
        window.alphaValue = 1
        window.orderOut(nil)
        window.close()
    }

    func closeAfterManagerDetach() {
        guard !closed else { return }
        closed = true
        sessionDriver = nil
        window.alphaValue = 1
        window.orderOut(nil)
        window.close()
    }

    func setTerminalFontSize(_ pointSize: CGFloat) {
        guard !closed else { return }
        terminalFontSize = pointSize
        terminalView.font = PtyTerminalViewStyle.terminalFont(pointSize: pointSize)
        terminalView.resize(cols: terminalView.getTerminal().cols, rows: terminalView.getTerminal().rows)
        terminalView.needsDisplay = true
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
        window.makeFirstResponder(terminalView)
    }

    func windowWillClose(_ notification: Notification) {
        _ = markClosed()
    }

    func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
        guard !closed else { return }
        sessionDriver?.resize(columns: newCols, rows: newRows)
    }

    func setTerminalTitle(source: TerminalView, title: String) {
        guard !title.isEmpty else { return }
        window.title = title
    }

    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}

    func send(source: TerminalView, data: ArraySlice<UInt8>) {
        guard !closed else { return }
        sessionDriver?.sendInput(Data(data))
    }

    func scrolled(source: TerminalView, position: Double) {}

    func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}

    func clipboardCopy(source: TerminalView, content: Data) {
        guard let string = String(data: content, encoding: .utf8) else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.writeObjects([string as NSString])
    }

    func clipboardRead(source: TerminalView) -> Data? {
        guard let string = NSPasteboard.general.string(forType: .string) else { return nil }
        return Data(string.utf8)
    }

    private func markClosed() -> Bool {
        guard !closed else { return false }
        closed = true
        sessionDriver?.detach()
        sessionDriver = nil
        return true
    }

}
