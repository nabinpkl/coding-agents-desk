import Foundation
import OSLog
import PtyClientSwift
import PtyTerminalSession
import PtyTerminalSwiftTerm
import UIKit

@MainActor
protocol WorkspaceTerminalViewDelegate: AnyObject {
    func workspaceTerminalViewRequestedRetry(_ view: WorkspaceTerminalView)
    func workspaceTerminalViewDidLoseConnection(_ view: WorkspaceTerminalView)
}

@MainActor
final class WorkspaceTerminalView: UIView, PtyTerminalSwiftTermContentViewDelegate {
    private static let titleFontSize: CGFloat = 12

    let workspaceID: String
    weak var delegate: WorkspaceTerminalViewDelegate?

    private let logger = Logger(subsystem: Config.logSubsystem, category: "workspace-terminal-view")
    private let titleLabel = UILabel()
    private let statusLabel = UILabel()
    private let retryButton = UIButton(type: .system)
    private let dismissKeyboardButton = UIButton(type: .system)
    private let terminalContent = PtyTerminalSwiftTermContentView(
        style: PtyTerminalViewStyle(fontSize: 14, metalRendering: PtyTerminalMetalRendering.from())
    )
    private var connection: (any WorkspaceTerminalConnection)?

    var attachmentDimensions: PtyTerminalDimensions { terminalContent.attachmentDimensions }
    var isAttached: Bool { connection != nil && terminalContent.isBound }
    var attachedSessionName: String? { connection?.sessionName }

    init(workspaceID: String, workspaceName: String) {
        self.workspaceID = workspaceID
        super.init(frame: .zero)
        setUp(workspaceName: workspaceName)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func updateWorkspaceName(_ name: String) {
        titleLabel.text = name
    }

    func showConnecting() {
        setStatus("Connecting workspace terminal…", retryable: false)
    }

    func showFailure(_ message: String) {
        setStatus(message, retryable: true)
    }

    func bind(_ connection: any WorkspaceTerminalConnection) {
        detach()
        self.connection = connection
        setStatus("", retryable: false)
        terminalContent.bind(to: connection)
    }

    func detach() {
        terminalContent.resignFocus()
        terminalContent.detach()
        connection = nil
    }

    func focus() {
        guard isAttached else { return }
        terminalContent.focus()
    }

    func resignFocus() {
        terminalContent.resignFocus()
    }

    func setZoomScale(_ scale: Double) {
        let resolvedScale = CGFloat(scale)
        titleLabel.font = .monospacedSystemFont(
            ofSize: Self.titleFontSize * resolvedScale,
            weight: .medium
        )
        terminalContent.setFontSize(PtyTerminalViewStyle.defaultFontSize * resolvedScale)
    }

    func ptyTerminalContent(
        _ content: PtyTerminalSwiftTermContentView,
        didFail error: Error
    ) {
        logger.error("workspace terminal driver failed: \(String(describing: error), privacy: .public)")
        terminalContent.stop()
        connection = nil
        showFailure("Terminal connection was lost.")
        delegate?.workspaceTerminalViewDidLoseConnection(self)
    }

    func ptyTerminalContent(
        _ content: PtyTerminalSwiftTermContentView,
        didTerminate termination: PtyTerminalSessionTermination
    ) {
        connection = nil
        showFailure("Workspace shell exited.")
        delegate?.workspaceTerminalViewDidLoseConnection(self)
    }

    func ptyTerminalContentDidDetachByManager(_ content: PtyTerminalSwiftTermContentView) {
        connection = nil
        showFailure("Workspace terminal ended on the Mac.")
        delegate?.workspaceTerminalViewDidLoseConnection(self)
    }

    private func setUp(workspaceName: String) {
        backgroundColor = .black
        accessibilityIdentifier = "workspace-terminal-\(workspaceID)"

        let header = UIView()
        header.translatesAutoresizingMaskIntoConstraints = false
        header.backgroundColor = UIColor(white: 0.12, alpha: 1)
        addSubview(header)

        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        titleLabel.font = .monospacedSystemFont(ofSize: Self.titleFontSize, weight: .medium)
        titleLabel.textColor = .secondaryLabel
        titleLabel.text = workspaceName
        titleLabel.lineBreakMode = .byTruncatingMiddle
        header.addSubview(titleLabel)

        retryButton.translatesAutoresizingMaskIntoConstraints = false
        retryButton.setImage(UIImage(systemName: "arrow.clockwise"), for: .normal)
        retryButton.accessibilityLabel = "Retry workspace terminal"
        retryButton.accessibilityIdentifier = "workspace-terminal-retry"
        retryButton.addTarget(self, action: #selector(retryTapped), for: .touchUpInside)
        retryButton.isHidden = true
        header.addSubview(retryButton)

        dismissKeyboardButton.translatesAutoresizingMaskIntoConstraints = false
        dismissKeyboardButton.setImage(
            UIImage(systemName: "keyboard.chevron.compact.down"),
            for: .normal
        )
        dismissKeyboardButton.accessibilityLabel = "Dismiss terminal keyboard"
        dismissKeyboardButton.accessibilityIdentifier = "workspace-terminal-dismiss-keyboard"
        dismissKeyboardButton.addTarget(self, action: #selector(dismissKeyboardTapped), for: .touchUpInside)
        header.addSubview(dismissKeyboardButton)

        terminalContent.translatesAutoresizingMaskIntoConstraints = false
        terminalContent.delegate = self
        terminalContent.accessibilityIdentifier = "workspace-terminal-content"
        if let error = terminalContent.rendererSetupError {
            logger.error("workspace terminal renderer setup failed: \(String(describing: error), privacy: .public)")
        }
        addSubview(terminalContent)

        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.font = .preferredFont(forTextStyle: .footnote)
        statusLabel.textColor = .secondaryLabel
        statusLabel.textAlignment = .center
        statusLabel.numberOfLines = 2
        statusLabel.accessibilityIdentifier = "workspace-terminal-status"
        addSubview(statusLabel)

        NSLayoutConstraint.activate([
            header.leadingAnchor.constraint(equalTo: leadingAnchor),
            header.trailingAnchor.constraint(equalTo: trailingAnchor),
            header.topAnchor.constraint(equalTo: topAnchor),
            header.heightAnchor.constraint(equalToConstant: 32),

            titleLabel.leadingAnchor.constraint(equalTo: header.leadingAnchor, constant: 10),
            titleLabel.centerYAnchor.constraint(equalTo: header.centerYAnchor),
            titleLabel.trailingAnchor.constraint(
                lessThanOrEqualTo: retryButton.leadingAnchor,
                constant: -8
            ),
            dismissKeyboardButton.trailingAnchor.constraint(
                equalTo: header.trailingAnchor,
                constant: -8
            ),
            dismissKeyboardButton.centerYAnchor.constraint(equalTo: header.centerYAnchor),
            retryButton.trailingAnchor.constraint(
                equalTo: dismissKeyboardButton.leadingAnchor,
                constant: -8
            ),
            retryButton.centerYAnchor.constraint(equalTo: header.centerYAnchor),

            terminalContent.leadingAnchor.constraint(equalTo: leadingAnchor),
            terminalContent.trailingAnchor.constraint(equalTo: trailingAnchor),
            terminalContent.topAnchor.constraint(equalTo: header.bottomAnchor),
            terminalContent.bottomAnchor.constraint(equalTo: bottomAnchor),

            statusLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            statusLabel.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            statusLabel.centerYAnchor.constraint(equalTo: terminalContent.centerYAnchor),
        ])
    }

    private func setStatus(_ text: String, retryable: Bool) {
        statusLabel.text = text
        statusLabel.isHidden = text.isEmpty
        retryButton.isHidden = !retryable
    }

    @objc private func retryTapped() {
        delegate?.workspaceTerminalViewRequestedRetry(self)
    }

    @objc private func dismissKeyboardTapped() {
        terminalContent.resignFocus()
    }
}
