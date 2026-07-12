import Foundation
import OSLog
import UIKit
import WebKit
import AgentDeskWire
import AgentPanel

/// The iOS agent feed surface (R19). A thin UIView wrapper around the reusable AgentPanel package's
/// `AgentPanelWebViewController`: it hosts the panel's WKWebView, forwards deliver/resume/teardown to
/// it, and adapts the panel's request contract to the client's QUIC input-lane request callback. The
/// webview lifecycle, bundled-asset loading, JS bridge, and serialized delivery all live in the
/// package now, shared with the macOS Agents window rather than reimplemented per platform.
@MainActor
final class AgentFeedSurface: UIView, AgentPanelTransport {
    private let logger = Logger(subsystem: Config.logSubsystem, category: "agent-feed-surface")

    /// Injected by PairingViewController to forward inbound requests to the input lane.
    var onAgentRequest: ((AgentFeedRequest) -> Void)?
    /// Test seam: when set, receives the delivered payload instead of the real panel.
    var deliverForTesting: ((String) -> Void)?
    var resumeAfterReconnectForTesting: (() -> Void)?

    private var panelController: AgentPanelWebViewController?

    override init(frame: CGRect) {
        super.init(frame: frame)
        setUpPanel()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setUpPanel()
    }

    private func setUpPanel() {
        do {
            let controller = try AgentPanelWebViewController(transport: self)
            panelController = controller
            let webView = controller.webView
            webView.translatesAutoresizingMaskIntoConstraints = false
            addSubview(webView)
            NSLayoutConstraint.activate([
                webView.leadingAnchor.constraint(equalTo: leadingAnchor),
                webView.trailingAnchor.constraint(equalTo: trailingAnchor),
                webView.topAnchor.constraint(equalTo: topAnchor),
                webView.bottomAnchor.constraint(equalTo: bottomAnchor),
            ])
        } catch {
            logger.error("agent-feed: AgentPanel init failed: \(String(describing: error), privacy: .public)")
            installUnavailableFallback()
        }
    }

    /// Shows a visible placeholder when the panel could not be constructed (missing/misconfigured
    /// bundled web assets). Without this the surface is a mute blank pane the user cannot diagnose;
    /// the accessibility identifier also lets an AX/Maestro check assert the failure state.
    private func installUnavailableFallback() {
        let label = UILabel()
        label.text = "Agent view unavailable"
        label.textAlignment = .center
        label.textColor = .secondaryLabel
        label.numberOfLines = 0
        label.accessibilityIdentifier = "agent-surface-unavailable"
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: centerXAnchor),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
            label.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 16),
            label.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -16),
        ])
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

    func teardown() {
        panelController?.teardown()
        panelController = nil
    }

    // MARK: - AgentPanelTransport

    func sendAgentPanelRequest(_ request: AgentPanelRequest) {
        onAgentRequest?(AgentFeedRequest(request))
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
        }
    }
}
