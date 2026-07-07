import Foundation
import os
import PtyClientSwift
import SwiftTerm
import UIKit

@available(iOS 26.0, *)
final class TerminalSurface: UIView, @MainActor TerminalViewDelegate {
    private static let sessionName = "agentdesk-home"

    private let terminalView = TerminalView(frame: .zero)
    private let statusLabel = UILabel()
    private let logger = Logger(subsystem: Config.logSubsystem, category: "terminal-surface")
    private var sessionConnection: PtySessionConnection?
    private var eventsTask: Task<Void, Never>?
    private var hasStarted = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        configureView()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        configureView()
    }

    deinit {
        detach()
    }

    func connect(using transport: QuicSessionClientTransport?) {
        guard !hasStarted else { return }
        guard let transport else {
            setStatus("No active session transport.")
            return
        }
        hasStarted = true
        setStatus("Connecting terminal...")
        let columns = UInt32(max(terminalView.getTerminal().cols, 80))
        let rows = UInt32(max(terminalView.getTerminal().rows, 24))
        Task { [weak self, weak transport] in
            do {
                guard let transport else { throw PtyClientError.closed }
                let client = try await transport.openTerminalPtyClient()
                let connection = try await client.openSession(
                    name: Self.sessionName,
                    cwd: "",
                    shell: "",
                    columns: columns,
                    rows: rows,
                    createIfMissing: true,
                    clientTitle: "AgentDesk iPhone"
                )
                await MainActor.run {
                    self?.attach(connection)
                }
            } catch {
                await MainActor.run {
                    self?.setStatus("Terminal unavailable: \(error)")
                    self?.logger.error("terminal attach failed: \(String(describing: error), privacy: .public)")
                }
            }
        }
    }

    func detach() {
        eventsTask?.cancel()
        eventsTask = nil
        guard let sessionConnection else { return }
        self.sessionConnection = nil
        Task {
            try? await sessionConnection.detach()
        }
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil {
            _ = terminalView.becomeFirstResponder()
        }
    }

    func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
        guard let sessionConnection else { return }
        Task {
            try? await sessionConnection.resize(columns: UInt32(newCols), rows: UInt32(newRows))
        }
    }

    func setTerminalTitle(source: TerminalView, title: String) {}

    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}

    func send(source: TerminalView, data: ArraySlice<UInt8>) {
        guard let sessionConnection else { return }
        let payload = Data(data)
        Task {
            try? await sessionConnection.sendInput(payload)
        }
    }

    func scrolled(source: TerminalView, position: Double) {}

    func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
        guard let url = URL(string: link) else { return }
        UIApplication.shared.open(url)
    }

    func bell(source: TerminalView) {}

    func clipboardCopy(source: TerminalView, content: Data) {
        guard let text = String(data: content, encoding: .utf8) else { return }
        UIPasteboard.general.string = text
    }

    func clipboardRead(source: TerminalView) -> Data? {
        guard let text = UIPasteboard.general.string else { return nil }
        return Data(text.utf8)
    }

    func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}

    func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}

    private func configureView() {
        backgroundColor = .black
        terminalView.translatesAutoresizingMaskIntoConstraints = false
        terminalView.backgroundColor = .black
        terminalView.nativeBackgroundColor = .black
        terminalView.nativeForegroundColor = .white
        terminalView.contentInsetAdjustmentBehavior = .never
        terminalView.terminalDelegate = self
        addSubview(terminalView)

        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.textColor = .secondaryLabel
        statusLabel.font = .preferredFont(forTextStyle: .footnote)
        statusLabel.textAlignment = .center
        statusLabel.numberOfLines = 2
        addSubview(statusLabel)

        NSLayoutConstraint.activate([
            terminalView.leadingAnchor.constraint(equalTo: leadingAnchor),
            terminalView.trailingAnchor.constraint(equalTo: trailingAnchor),
            terminalView.topAnchor.constraint(equalTo: topAnchor),
            terminalView.bottomAnchor.constraint(equalTo: bottomAnchor),
            statusLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            statusLabel.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            statusLabel.centerYAnchor.constraint(equalTo: centerYAnchor)
        ])
    }

    private func attach(_ connection: PtySessionConnection) {
        sessionConnection = connection
        setStatus("")
        eventsTask = Task { [weak self, connection] in
            do {
                for try await event in connection.events() {
                    await MainActor.run {
                        self?.handle(event)
                    }
                }
            } catch {
                await MainActor.run {
                    self?.setStatus("Terminal closed: \(error)")
                }
            }
        }
        _ = terminalView.becomeFirstResponder()
    }

    private func handle(_ event: PtySessionEvent) {
        switch event {
        case .attached:
            setStatus("")
        case .output(let data):
            terminalView.feed(byteArray: [UInt8](data)[...])
        case .detachedByManager(let clientID):
            setStatus("Terminal client detached: \(clientID)")
        case .exited(let status):
            setStatus("Terminal exited: \(status)")
        case .error(let message):
            setStatus("Terminal error: \(message)")
        }
    }

    private func setStatus(_ text: String) {
        statusLabel.text = text
        statusLabel.isHidden = text.isEmpty
    }
}
