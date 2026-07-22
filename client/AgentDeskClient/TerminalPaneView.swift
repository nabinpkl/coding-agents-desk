import Foundation
import os
import PtyClientSwift
import PtyTerminalSession
import PtyTerminalSwiftTerm
import UIKit

@available(iOS 26.0, *)
protocol TerminalPaneViewDelegate: AnyObject {
    func terminalPaneViewRequestedFocus(_ paneView: TerminalPaneView)
    func terminalPaneView(_ paneView: TerminalPaneView, requestedSplit axis: TerminalSplitAxis)
    func terminalPaneViewRequestedClose(_ paneView: TerminalPaneView)
}

@available(iOS 26.0, *)
protocol TerminalPaneSessionConnection: PtyTerminalConnection, Sendable {
    var sessionName: String { get }
    var attachedClientCount: UInt32 { get }
    var attachedClientID: UInt64 { get }

    func kill() async throws
}

@available(iOS 26.0, *)
extension PtySessionConnection: TerminalPaneSessionConnection {
    var attachedClientCount: UInt32 {
        attachment.clientCount
    }

    var attachedClientID: UInt64 {
        attachment.clientID
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
final class TerminalPaneView: UIView, PtyTerminalSwiftTermContentViewDelegate, UIGestureRecognizerDelegate {
    let leaf: TerminalPaneLeaf

    weak var delegate: TerminalPaneViewDelegate?

    private let logger = Logger(subsystem: Config.logSubsystem, category: "terminal-pane")
    private let terminalContent = PtyTerminalSwiftTermContentView(
        style: PtyTerminalViewStyle(
            fontSize: 14,
            metalRendering: PtyTerminalMetalRendering.from()
        )
    )
    private let statusLabel = UILabel()
    private let titleLabel = UILabel()
    private let dismissKeyboardButton = UIButton(type: .system)
    private let closeButton = UIButton(type: .system)
    private var sessionConnection: TerminalPaneSessionConnection?
    private weak var transport: QuicSessionClientTransport?
    private var latestClientCount: UInt32?
    private var connectTask: Task<Void, Never>?
    private var connectGeneration = 0
    private(set) var isFocusedPane = false
    private var didApplyFocus = false
    var attachedClientID: UInt64? {
        sessionConnection?.attachedClientID
    }

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
        let createIfMissing = leaf.createIfMissing
        let clientTitle = "AgentDesk iPhone pane \(leaf.paneID.rawValue)"
        let dimensions = terminalContent.attachmentDimensions
        connectTask = Task { [weak self, weak transport] in
            do {
                guard let transport else { throw PtyClientError.closed }
                let client = try await transport.openTerminalPtyClient()
                try Task.checkCancellation()
                let connection = try await client.openSession(
                    name: sessionName,
                    launch: .shell(cwd: "", shell: ""),
                    lifetime: .persistent,
                    columns: dimensions.columns,
                    rows: dimensions.rows,
                    createIfMissing: createIfMissing,
                    clientTitle: clientTitle
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
        terminalContent.setViewportActive(false)
        terminalContent.detach()
        latestClientCount = nil
        transport = nil
        self.sessionConnection = nil
    }

    func closeForUser() async -> TerminalPaneUserCloseResult {
        connectGeneration += 1
        connectTask?.cancel()
        connectTask = nil

        guard let sessionConnection else {
            terminalContent.stop()
            latestClientCount = nil
            setStatus("")
            return .closedBeforeAttach
        }

        do {
            let currentClientCount = try await currentClientCount(for: sessionConnection)
            let shouldKillSession = currentClientCount <= 1
            if shouldKillSession {
                try await killSession(sessionConnection)
                finishClosedSession()
                return .killed
            }
            try await sessionConnection.detach()
            finishClosedSession()
            return .detached
        } catch {
            latestClientCount = sessionConnection.attachedClientCount
            let message = "Terminal close failed: \(error)"
            setStatus(message)
            logger.error("terminal user close failed: \(String(describing: error), privacy: .public)")
            return .failed(message)
        }
    }

    func setFocused(_ focused: Bool) {
        guard !didApplyFocus || isFocusedPane != focused else { return }
        didApplyFocus = true
        isFocusedPane = focused
        terminalContent.isInputEnabled = focused
        terminalContent.setViewportActive(focused, claim: focused)
        layer.borderWidth = focused ? 2 : 1
        layer.borderColor = focused ? UIColor.systemBlue.cgColor : UIColor.separator.cgColor
        if focused {
            terminalContent.focus()
        } else {
            terminalContent.resignFocus()
        }
    }

    func flushViewportResize() {
        terminalContent.flushViewportResize()
    }

    func setCloseEnabled(_ enabled: Bool) {
        closeButton.isHidden = !enabled
        closeButton.isEnabled = enabled
    }

    func ptyTerminalContent(
        _ content: PtyTerminalSwiftTermContentView,
        didReceiveStatus text: String
    ) {
        let status = text.trimmingCharacters(in: .whitespacesAndNewlines)
        setStatus(status)
    }

    func ptyTerminalContent(
        _ content: PtyTerminalSwiftTermContentView,
        didFail error: Error
    ) {
        logger.error("terminal session driver failed: \(String(describing: error), privacy: .public)")
    }

    func ptyTerminalContentDidDetachByManager(_ content: PtyTerminalSwiftTermContentView) {
        sessionConnection = nil
        latestClientCount = nil
        setStatus("Terminal detached by manager.")
    }

    func closeAfterManagerDetach() {
        terminalContent.closeAfterManagerDetach()
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        guard let touchedView = touch.view else { return true }
        return !isControlTouch(touchedView)
    }

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
        titleLabel.text = leaf.createIfMissing ? leaf.sessionName : "\(leaf.sessionName) joined"
        header.addSubview(titleLabel)

        let splitRightButton = makeButton(systemName: "rectangle.split.2x1", action: #selector(handleSplitRight))
        let splitDownButton = makeButton(systemName: "rectangle.split.1x2", action: #selector(handleSplitDown))
        dismissKeyboardButton.translatesAutoresizingMaskIntoConstraints = false
        dismissKeyboardButton.setImage(UIImage(systemName: "keyboard.chevron.compact.down"), for: .normal)
        dismissKeyboardButton.tintColor = .secondaryLabel
        dismissKeyboardButton.addTarget(self, action: #selector(handleDismissKeyboard), for: .touchUpInside)
        closeButton.translatesAutoresizingMaskIntoConstraints = false
        closeButton.setImage(UIImage(systemName: "xmark"), for: .normal)
        closeButton.tintColor = .secondaryLabel
        closeButton.addTarget(self, action: #selector(handleClose), for: .touchUpInside)
        header.addSubview(splitRightButton)
        header.addSubview(splitDownButton)
        header.addSubview(dismissKeyboardButton)
        header.addSubview(closeButton)

        terminalContent.translatesAutoresizingMaskIntoConstraints = false
        terminalContent.delegate = self
        terminalContent.isInputEnabled = false
        if let error = terminalContent.rendererSetupError {
            logger.error("terminal renderer setup failed: \(String(describing: error), privacy: .public)")
        }
        addSubview(terminalContent)

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
            titleLabel.trailingAnchor.constraint(lessThanOrEqualTo: splitRightButton.leadingAnchor, constant: -8),

            closeButton.trailingAnchor.constraint(equalTo: header.trailingAnchor, constant: -8),
            closeButton.centerYAnchor.constraint(equalTo: header.centerYAnchor),
            dismissKeyboardButton.trailingAnchor.constraint(equalTo: closeButton.leadingAnchor, constant: -8),
            dismissKeyboardButton.centerYAnchor.constraint(equalTo: header.centerYAnchor),
            splitDownButton.trailingAnchor.constraint(equalTo: dismissKeyboardButton.leadingAnchor, constant: -8),
            splitDownButton.centerYAnchor.constraint(equalTo: header.centerYAnchor),
            splitRightButton.trailingAnchor.constraint(equalTo: splitDownButton.leadingAnchor, constant: -8),
            splitRightButton.centerYAnchor.constraint(equalTo: header.centerYAnchor),

            terminalContent.leadingAnchor.constraint(equalTo: leadingAnchor),
            terminalContent.trailingAnchor.constraint(equalTo: trailingAnchor),
            terminalContent.topAnchor.constraint(equalTo: header.bottomAnchor),
            terminalContent.bottomAnchor.constraint(equalTo: bottomAnchor),

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
        terminalContent.bind(to: connection)
        if isFocusedPane {
            terminalContent.focus()
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

    private func killSession(_ connection: TerminalPaneSessionConnection) async throws {
        guard let transport else {
            try await connection.kill()
            return
        }
        let client = try await transport.openTerminalPtyClient()
        try await client.killSession(name: connection.sessionName)
    }

    private func finishClosedSession() {
        sessionConnection = nil
        terminalContent.stop()
        latestClientCount = nil
        setStatus("")
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

    @objc private func handleDismissKeyboard() {
        terminalContent.resignFocus()
    }

    @objc private func handleClose() {
        delegate?.terminalPaneViewRequestedClose(self)
    }
}
