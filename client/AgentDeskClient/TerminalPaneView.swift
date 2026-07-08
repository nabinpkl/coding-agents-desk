import Foundation
import os
import PtyClientSwift
import SwiftTerm
import UIKit

@available(iOS 26.0, *)
protocol TerminalPaneViewDelegate: AnyObject {
    func terminalPaneViewRequestedFocus(_ paneView: TerminalPaneView)
    func terminalPaneView(_ paneView: TerminalPaneView, requestedSplit axis: TerminalSplitAxis)
    func terminalPaneViewRequestedClose(_ paneView: TerminalPaneView)
}

@available(iOS 26.0, *)
protocol TerminalPaneSessionConnection: AnyObject, Sendable {
    var sessionName: String { get }
    var attachedClientCount: UInt32 { get }

    func events() -> AsyncThrowingStream<PtySessionEvent, Error>
    func sendInput(_ data: Data) async throws
    func resize(columns: UInt32, rows: UInt32) async throws
    func detach() async throws
    func kill() async throws
}

@available(iOS 26.0, *)
extension PtySessionConnection: TerminalPaneSessionConnection {
    var attachedClientCount: UInt32 {
        attachment.clientCount
    }
}

@available(iOS 26.0, *)
enum TerminalPaneUserCloseResult: Equatable {
    case detached
    case killed
    case closedBeforeAttach
    case failed(String)
}

@available(iOS 26.0, *)
final class TerminalPaneView: UIView, @MainActor TerminalViewDelegate, UIGestureRecognizerDelegate {
    let leaf: TerminalPaneLeaf

    weak var delegate: TerminalPaneViewDelegate?

    private let logger = Logger(subsystem: Config.logSubsystem, category: "terminal-pane")
    private let terminalView = TerminalView(frame: .zero)
    private let statusLabel = UILabel()
    private let titleLabel = UILabel()
    private let closeButton = UIButton(type: .system)
    private var sessionConnection: TerminalPaneSessionConnection?
    private weak var transport: QuicSessionClientTransport?
    private var latestClientCount: UInt32?
    private var eventsTask: Task<Void, Never>?
    private var connectTask: Task<Void, Never>?
    private var connectGeneration = 0
    private(set) var isFocusedPane = false

    init(leaf: TerminalPaneLeaf) {
        self.leaf = leaf
        super.init(frame: .zero)
        configureView()
    }

    required init?(coder: NSCoder) {
        return nil
    }

    deinit {
        connectTask?.cancel()
        eventsTask?.cancel()
        if let sessionConnection {
            Task {
                try? await sessionConnection.detach()
            }
        }
    }

    func connect(using transport: QuicSessionClientTransport?) {
        guard connectTask == nil, sessionConnection == nil else { return }
        self.transport = transport
        guard let transport else {
            setStatus("No active session transport.")
            return
        }

        setStatus("Connecting terminal...")
        connectGeneration += 1
        let generation = connectGeneration
        let sessionName = leaf.sessionName
        let columns = UInt32(max(terminalView.getTerminal().cols, 80))
        let rows = UInt32(max(terminalView.getTerminal().rows, 24))
        connectTask = Task { [weak self, weak transport] in
            do {
                guard let transport else { throw PtyClientError.closed }
                let client = try await transport.openTerminalPtyClient()
                try Task.checkCancellation()
                let connection = try await client.openSession(
                    name: sessionName,
                    cwd: "",
                    shell: "",
                    columns: columns,
                    rows: rows,
                    createIfMissing: true,
                    clientTitle: "AgentDesk iPhone"
                )
                await MainActor.run {
                    guard let self, self.connectGeneration == generation else {
                        Task {
                            try? await connection.detach()
                        }
                        return
                    }
                    self.attach(connection)
                }
            } catch is CancellationError {
            } catch {
                await MainActor.run {
                    guard let self, self.connectGeneration == generation else { return }
                    self.setStatus("Terminal unavailable: \(error)")
                    self.logger.error("terminal attach failed: \(String(describing: error), privacy: .public)")
                }
            }
            await MainActor.run {
                if self?.connectGeneration == generation {
                    self?.connectTask = nil
                }
            }
        }
    }

    func detach() {
        connectGeneration += 1
        connectTask?.cancel()
        connectTask = nil
        eventsTask?.cancel()
        eventsTask = nil
        latestClientCount = nil
        transport = nil
        guard let sessionConnection else { return }
        self.sessionConnection = nil
        Task {
            try? await sessionConnection.detach()
        }
    }

    func closeForUser() async -> TerminalPaneUserCloseResult {
        connectGeneration += 1
        connectTask?.cancel()
        connectTask = nil

        guard let sessionConnection else {
            eventsTask?.cancel()
            eventsTask = nil
            latestClientCount = nil
            setStatus("")
            return .closedBeforeAttach
        }

        self.sessionConnection = nil
        do {
            let currentClientCount = try await currentClientCount(for: sessionConnection)
            let shouldKillSession = currentClientCount <= 1
            if shouldKillSession {
                try await sessionConnection.kill()
                eventsTask?.cancel()
                eventsTask = nil
                latestClientCount = nil
                setStatus("")
                return .killed
            }
            try await sessionConnection.detach()
            eventsTask?.cancel()
            eventsTask = nil
            latestClientCount = nil
            setStatus("")
            return .detached
        } catch {
            self.sessionConnection = sessionConnection
            latestClientCount = sessionConnection.attachedClientCount
            let message = "Terminal close failed: \(error)"
            setStatus(message)
            logger.error("terminal user close failed: \(String(describing: error), privacy: .public)")
            return .failed(message)
        }
    }

    func setFocused(_ focused: Bool) {
        isFocusedPane = focused
        layer.borderWidth = focused ? 2 : 1
        layer.borderColor = focused ? UIColor.systemBlue.cgColor : UIColor.separator.cgColor
        if focused {
            _ = terminalView.becomeFirstResponder()
        } else if terminalView.isFirstResponder {
            _ = terminalView.resignFirstResponder()
        }
    }

    func setCloseEnabled(_ enabled: Bool) {
        closeButton.isHidden = !enabled
        closeButton.isEnabled = enabled
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
        guard isFocusedPane, let sessionConnection else { return }
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

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        guard let touchedView = touch.view else { return true }
        return !isControlTouch(touchedView)
    }

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
        layer.cornerRadius = 8
        layer.masksToBounds = true
        layer.borderWidth = 1
        layer.borderColor = UIColor.separator.cgColor

        let focusTap = UITapGestureRecognizer(target: self, action: #selector(handleFocusTap))
        focusTap.cancelsTouchesInView = false
        focusTap.delegate = self
        addGestureRecognizer(focusTap)

        let header = UIView()
        header.translatesAutoresizingMaskIntoConstraints = false
        header.backgroundColor = UIColor(white: 0.12, alpha: 1)
        addSubview(header)

        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        titleLabel.font = .monospacedSystemFont(ofSize: 12, weight: .medium)
        titleLabel.textColor = .secondaryLabel
        titleLabel.text = leaf.sessionName
        header.addSubview(titleLabel)

        let splitRightButton = makeButton(systemName: "rectangle.split.2x1", action: #selector(handleSplitRight))
        let splitDownButton = makeButton(systemName: "rectangle.split.1x2", action: #selector(handleSplitDown))
        closeButton.translatesAutoresizingMaskIntoConstraints = false
        closeButton.setImage(UIImage(systemName: "xmark"), for: .normal)
        closeButton.tintColor = .secondaryLabel
        closeButton.addTarget(self, action: #selector(handleClose), for: .touchUpInside)
        header.addSubview(splitRightButton)
        header.addSubview(splitDownButton)
        header.addSubview(closeButton)

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
            header.leadingAnchor.constraint(equalTo: leadingAnchor),
            header.trailingAnchor.constraint(equalTo: trailingAnchor),
            header.topAnchor.constraint(equalTo: topAnchor),
            header.heightAnchor.constraint(equalToConstant: 32),

            titleLabel.leadingAnchor.constraint(equalTo: header.leadingAnchor, constant: 10),
            titleLabel.centerYAnchor.constraint(equalTo: header.centerYAnchor),

            closeButton.trailingAnchor.constraint(equalTo: header.trailingAnchor, constant: -8),
            closeButton.centerYAnchor.constraint(equalTo: header.centerYAnchor),
            splitDownButton.trailingAnchor.constraint(equalTo: closeButton.leadingAnchor, constant: -8),
            splitDownButton.centerYAnchor.constraint(equalTo: header.centerYAnchor),
            splitRightButton.trailingAnchor.constraint(equalTo: splitDownButton.leadingAnchor, constant: -8),
            splitRightButton.centerYAnchor.constraint(equalTo: header.centerYAnchor),

            terminalView.leadingAnchor.constraint(equalTo: leadingAnchor),
            terminalView.trailingAnchor.constraint(equalTo: trailingAnchor),
            terminalView.topAnchor.constraint(equalTo: header.bottomAnchor),
            terminalView.bottomAnchor.constraint(equalTo: bottomAnchor),

            statusLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            statusLabel.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            statusLabel.centerXAnchor.constraint(equalTo: centerXAnchor),
            statusLabel.centerYAnchor.constraint(equalTo: centerYAnchor)
        ])
    }

    private func makeButton(systemName: String, action: Selector) -> UIButton {
        let button = UIButton(type: .system)
        button.translatesAutoresizingMaskIntoConstraints = false
        button.setImage(UIImage(systemName: systemName), for: .normal)
        button.tintColor = .secondaryLabel
        button.addTarget(self, action: action, for: .touchUpInside)
        return button
    }

    func attach(_ connection: TerminalPaneSessionConnection) {
        sessionConnection = connection
        latestClientCount = connection.attachedClientCount
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
        if isFocusedPane {
            _ = terminalView.becomeFirstResponder()
        }
    }

    private func handle(_ event: PtySessionEvent) {
        switch event {
        case .attached(let attachment):
            latestClientCount = attachment.clientCount
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

    private func currentClientCount(for connection: TerminalPaneSessionConnection) async throws -> UInt32 {
        guard let transport else {
            return latestClientCount ?? connection.attachedClientCount
        }
        let client = try await transport.openTerminalPtyClient()
        let sessions = try await client.listSessions()
        guard let session = sessions.first(where: { $0.name == connection.sessionName }) else {
            return 1
        }
        return session.clientCount
    }

    private func isControlTouch(_ view: UIView) -> Bool {
        var currentView: UIView? = view
        while let candidate = currentView {
            if candidate is UIControl { return true }
            if candidate === self { return false }
            currentView = candidate.superview
        }
        return false
    }

    private func setStatus(_ text: String) {
        statusLabel.text = text
        statusLabel.isHidden = text.isEmpty
    }

    @objc private func handleFocusTap() {
        delegate?.terminalPaneViewRequestedFocus(self)
    }

    @objc private func handleSplitRight() {
        delegate?.terminalPaneView(self, requestedSplit: .horizontal)
    }

    @objc private func handleSplitDown() {
        delegate?.terminalPaneView(self, requestedSplit: .vertical)
    }

    @objc private func handleClose() {
        delegate?.terminalPaneViewRequestedClose(self)
    }
}
