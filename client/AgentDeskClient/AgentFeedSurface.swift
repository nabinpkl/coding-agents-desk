import Foundation
import OSLog
import UIKit
import WebKit
import AgentDeskWire
import AgentPanel
import PtyTerminalSwiftTerm

/// The iOS Agent surface. AgentPanel retains web content ownership while this UIKit container owns
/// the native terminal layout and attachment workflow.
@MainActor
final class AgentFeedSurface: UIView, AgentPanelTransport, AgentFeedTerminalLifecycleHandling {
    static let defaultTerminalHeightFraction: CGFloat = 0.38
    static let terminalHeightRange: ClosedRange<CGFloat> = 0.25...0.65

    private let logger = Logger(subsystem: Config.logSubsystem, category: "agent-feed-surface")
    private let terminalCloseDelivery: AgentFeedTerminalCloseDelivery
    private static let terminalControlBarHeight: CGFloat = 32

    /// Injected by PairingViewController to forward inbound requests to the input lane.
    var onAgentRequest: ((AgentFeedRequest) -> Void)?
    /// Native container seam for Agent Panel terminal intent. L6 supplies terminal ownership.
    var onTerminalIntent: ((AgentPanelTerminalIntent) -> Void)?
    /// Test seam: when set, receives the delivered payload instead of the real panel.
    var deliverForTesting: ((String) -> Void)?
    var resumeAfterReconnectForTesting: (() -> Void)?

    private var panelController: AgentPanelWebViewController?
    private(set) var panelContentView = UIView()
    let resizeHandle = UIView()
    let terminalKeyboardDismissButton = UIButton(type: .system)
    let terminalContent = PtyTerminalSwiftTermContentView(
        style: PtyTerminalViewStyle(fontSize: 14, metalRendering: PtyTerminalMetalRendering.from())
    )
    let terminalAvailableLayoutGuide = UILayoutGuide()
    private(set) var terminalHeightFraction = AgentFeedSurface.defaultTerminalHeightFraction
    private(set) var isTerminalPresented = false
    private(set) var terminalHeightConstraint: NSLayoutConstraint?
    private(set) var terminalBottomConstraint: NSLayoutConstraint!

    private var panelClosedBottomConstraint: NSLayoutConstraint!
    private var panelOpenBottomConstraint: NSLayoutConstraint!
    private var resizeHandleOpenHeightConstraint: NSLayoutConstraint!
    private var resizeHandleClosedHeightConstraint: NSLayoutConstraint!
    private var terminalClosedHeightConstraint: NSLayoutConstraint!
    private var resizeStartFraction = AgentFeedSurface.defaultTerminalHeightFraction

    private lazy var terminalSession = AgentFeedTerminalSession(
        terminalContent: terminalContent,
        closeDelivery: terminalCloseDelivery,
        setPresented: { [weak self] presented in
            self?.setTerminalPresented(presented)
        },
        deliver: { [weak self] message in
            self?.deliver(message)
        }
    )

    override init(frame: CGRect) {
        terminalCloseDelivery = AgentFeedTerminalCloseDelivery()
        super.init(frame: frame)
        setUpPanel()
        configureContainer()
    }

    required init?(coder: NSCoder) {
        terminalCloseDelivery = AgentFeedTerminalCloseDelivery()
        super.init(coder: coder)
        setUpPanel()
        configureContainer()
    }

    init(closeDelivery: AgentFeedTerminalCloseDelivery) {
        terminalCloseDelivery = closeDelivery
        super.init(frame: .zero)
        setUpPanel()
        configureContainer()
    }

    init(
        panelViewForTesting panelView: UIView,
        closeDelivery: AgentFeedTerminalCloseDelivery = AgentFeedTerminalCloseDelivery()
    ) {
        terminalCloseDelivery = closeDelivery
        super.init(frame: .zero)
        panelContentView = panelView
        configureContainer()
    }

    private func setUpPanel() {
        do {
            let controller = try AgentPanelWebViewController(
                transport: self,
                additionalUserScripts: [AgentPanelAccessibility.userScript]
            )
            panelController = controller
            panelContentView = controller.webView
        } catch {
            logger.error("agent-feed: AgentPanel init failed: \(String(describing: error), privacy: .public)")
            panelContentView = unavailableFallback()
        }
    }

    /// Shows a visible placeholder when the panel could not be constructed (missing/misconfigured
    /// bundled web assets). Without this the surface is a mute blank pane the user cannot diagnose;
    /// the accessibility identifier also lets an AX/Maestro check assert the failure state.
    private func unavailableFallback() -> UIView {
        let label = UILabel()
        label.text = "Agent view unavailable"
        label.textAlignment = .center
        label.textColor = .secondaryLabel
        label.numberOfLines = 0
        label.accessibilityIdentifier = "agent-surface-unavailable"
        return label
    }

    private func configureContainer() {
        backgroundColor = .systemBackground
        addLayoutGuide(terminalAvailableLayoutGuide)

        panelContentView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(panelContentView)

        resizeHandle.translatesAutoresizingMaskIntoConstraints = false
        resizeHandle.backgroundColor = .secondarySystemBackground
        resizeHandle.accessibilityIdentifier = "agent-terminal-resize-handle"
        resizeHandle.accessibilityLabel = "Resize terminal"
        resizeHandle.isAccessibilityElement = true
        let grabber = UIView()
        grabber.translatesAutoresizingMaskIntoConstraints = false
        grabber.backgroundColor = .separator
        grabber.layer.cornerRadius = 1.5
        resizeHandle.addSubview(grabber)
        terminalKeyboardDismissButton.translatesAutoresizingMaskIntoConstraints = false
        terminalKeyboardDismissButton.setImage(UIImage(systemName: "keyboard.chevron.compact.down"), for: .normal)
        terminalKeyboardDismissButton.tintColor = .secondaryLabel
        terminalKeyboardDismissButton.accessibilityIdentifier = "agent-terminal-keyboard-dismiss"
        terminalKeyboardDismissButton.accessibilityLabel = "Hide keyboard"
        terminalKeyboardDismissButton.addTarget(self, action: #selector(handleTerminalKeyboardDismiss), for: .touchUpInside)
        resizeHandle.addSubview(terminalKeyboardDismissButton)
        resizeHandle.addGestureRecognizer(UIPanGestureRecognizer(
            target: self,
            action: #selector(handleTerminalResize(_:))
        ))
        addSubview(resizeHandle)

        terminalContent.translatesAutoresizingMaskIntoConstraints = false
        terminalContent.accessibilityIdentifier = "agent-terminal-content"
        addSubview(terminalContent)

        NSLayoutConstraint.activate([
            terminalAvailableLayoutGuide.topAnchor.constraint(equalTo: topAnchor),
            terminalAvailableLayoutGuide.bottomAnchor.constraint(equalTo: keyboardLayoutGuide.topAnchor),
            terminalAvailableLayoutGuide.leadingAnchor.constraint(equalTo: leadingAnchor),
            terminalAvailableLayoutGuide.trailingAnchor.constraint(equalTo: trailingAnchor),

            panelContentView.topAnchor.constraint(equalTo: topAnchor),
            panelContentView.leadingAnchor.constraint(equalTo: leadingAnchor),
            panelContentView.trailingAnchor.constraint(equalTo: trailingAnchor),

            terminalContent.leadingAnchor.constraint(equalTo: leadingAnchor),
            terminalContent.trailingAnchor.constraint(equalTo: trailingAnchor),

            resizeHandle.leadingAnchor.constraint(equalTo: leadingAnchor),
            resizeHandle.trailingAnchor.constraint(equalTo: trailingAnchor),
            resizeHandle.bottomAnchor.constraint(equalTo: terminalContent.topAnchor),

            grabber.widthAnchor.constraint(equalToConstant: 44),
            grabber.heightAnchor.constraint(equalToConstant: 3),
            grabber.centerXAnchor.constraint(equalTo: resizeHandle.centerXAnchor),
            grabber.centerYAnchor.constraint(equalTo: resizeHandle.centerYAnchor),

            terminalKeyboardDismissButton.trailingAnchor.constraint(equalTo: resizeHandle.trailingAnchor, constant: -10),
            terminalKeyboardDismissButton.centerYAnchor.constraint(equalTo: resizeHandle.centerYAnchor),
            terminalKeyboardDismissButton.widthAnchor.constraint(equalToConstant: 28),
            terminalKeyboardDismissButton.heightAnchor.constraint(equalToConstant: 28),
        ])

        terminalBottomConstraint = terminalContent.bottomAnchor.constraint(
            equalTo: keyboardLayoutGuide.topAnchor
        )
        panelClosedBottomConstraint = panelContentView.bottomAnchor.constraint(equalTo: bottomAnchor)
        panelOpenBottomConstraint = panelContentView.bottomAnchor.constraint(equalTo: resizeHandle.topAnchor)
        resizeHandleOpenHeightConstraint = resizeHandle.heightAnchor.constraint(equalToConstant: Self.terminalControlBarHeight)
        resizeHandleClosedHeightConstraint = resizeHandle.heightAnchor.constraint(equalToConstant: 0)
        terminalClosedHeightConstraint = terminalContent.heightAnchor.constraint(equalToConstant: 0)
        terminalBottomConstraint.isActive = true
        setTerminalPresented(false)
    }

    func bindTerminalDependencies(
        coordinator: (any AgentFeedTerminalCoordinating)?,
        sessionOpener: (any AgentFeedTerminalSessionOpening)?
    ) {
        terminalSession.bind(coordinator: coordinator, sessionOpener: sessionOpener)
    }

    @discardableResult
    func abandonTerminal(_ reason: AgentFeedTerminalAbandonmentReason) -> Task<Void, Never>? {
        terminalSession.abandon(reason)
    }

    func interruptTerminal(_ interruption: AgentFeedTerminalInterruption) {
        terminalSession.interrupt(interruption)
    }

    func setTerminalHeightFraction(_ fraction: CGFloat) {
        terminalHeightFraction = min(max(fraction, Self.terminalHeightRange.lowerBound),
                                     Self.terminalHeightRange.upperBound)
        guard isTerminalPresented else { return }
        replaceTerminalHeightConstraint()
    }

    private func setTerminalPresented(_ presented: Bool) {
        guard presented != isTerminalPresented || terminalHeightConstraint == nil else { return }
        isTerminalPresented = presented
        panelClosedBottomConstraint.isActive = !presented
        resizeHandleClosedHeightConstraint.isActive = !presented
        terminalClosedHeightConstraint.isActive = !presented
        panelOpenBottomConstraint.isActive = presented
        resizeHandleOpenHeightConstraint.isActive = presented
        resizeHandle.isHidden = !presented
        terminalKeyboardDismissButton.isHidden = !presented
        terminalContent.isHidden = !presented
        if presented {
            replaceTerminalHeightConstraint()
        } else {
            terminalHeightConstraint?.isActive = false
            terminalHeightConstraint = nil
        }
        setNeedsLayout()
    }

    private func replaceTerminalHeightConstraint() {
        terminalHeightConstraint?.isActive = false
        let constraint = terminalContent.heightAnchor.constraint(
            equalTo: terminalAvailableLayoutGuide.heightAnchor,
            multiplier: terminalHeightFraction
        )
        constraint.priority = .required
        constraint.isActive = true
        terminalHeightConstraint = constraint
    }

    @objc private func handleTerminalResize(_ recognizer: UIPanGestureRecognizer) {
        switch recognizer.state {
        case .began:
            resizeStartFraction = terminalHeightFraction
        case .changed:
            let availableHeight = max(terminalAvailableLayoutGuide.layoutFrame.height, 1)
            let translation = recognizer.translation(in: self)
            setTerminalHeightFraction(resizeStartFraction - (translation.y / availableHeight))
        default:
            break
        }
    }

    @objc func handleTerminalKeyboardDismiss() {
        terminalContent.resignFocus()
    }

    func deliver(rawJSON: String) {
        if let deliverForTesting {
            deliverForTesting(rawJSON)
            return
        }
        panelController?.deliver(rawJSON: rawJSON)
    }

    func resumeAfterSessionReconnect() {
        if let resumeAfterReconnectForTesting {
            resumeAfterReconnectForTesting()
            return
        }
        panelController?.resumeAfterSessionReconnect()
    }

    @discardableResult
    func teardown() -> Task<Void, Never>? {
        let closeTask = terminalSession.teardown()
        panelController?.teardown()
        panelController = nil
        return closeTask
    }

    // MARK: - AgentPanelTransport

    func sendAgentPanelRequest(_ request: AgentPanelRequest) {
        if case .terminal(let intent) = request {
            onTerminalIntent?(intent)
            terminalSession.handle(intent)
            return
        }
        onAgentRequest?(AgentFeedRequest(request))
    }

    private func deliver(_ message: AgentTerminalHostMessage) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(message),
              let rawJSON = String(data: data, encoding: .utf8) else {
            logger.error("agent terminal status encode failed")
            return
        }
        deliver(rawJSON: rawJSON)
    }
}

/// The client's agent request type carried over the QUIC input lane. Bridged from the AgentPanel
/// package's `AgentPanelRequest`, whose webview-message decoding is authoritative and tested in the
/// package (`requestDecoderPreservesCurrentAgentFeedContract`).
enum AgentFeedRequest: Equatable {
    case projectsSubscribe
    case threadSubscribe(AgentThreadSubscribe)
    case threadLoadOlder(AgentThreadLoadOlder)
    case threadUnsubscribe(AgentThreadUnsubscribe)

    init(_ request: AgentPanelRequest) {
        switch request {
        case .projectsSubscribe:
            self = .projectsSubscribe
        case .threadSubscribe(let projectPath, let source, let sessionId):
            self = .threadSubscribe(AgentThreadSubscribe(projectPath: projectPath, source: source, sessionId: sessionId))
        case .threadLoadOlder(let sessionId, let beforeIndex, let limit):
            self = .threadLoadOlder(AgentThreadLoadOlder(sessionId: sessionId, beforeIndex: beforeIndex, limit: limit))
        case .threadUnsubscribe(let sessionId):
            self = .threadUnsubscribe(AgentThreadUnsubscribe(sessionId: sessionId))
        case .terminal:
            preconditionFailure("Terminal intents must route through AgentFeedSurface.onTerminalIntent")
        }
    }
}
