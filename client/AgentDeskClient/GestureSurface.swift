import Foundation
import OSLog
import UIKit
import WebKit
import InteractionPanel

/// The iOS gesture surface: hosts the shared InteractionPanel webview full-bleed
/// and forwards each detected Space step to the input lane. No bridge, no
/// sidecar — detection runs in the webview; `PairingViewController` wires
/// `onSpaceStep` to `sendInput(.switchSpaceStep(delta:))` over QUIC.
@MainActor
final class GestureSurface: UIView, InteractionPanelTransport, WKUIDelegate {
    /// Injected by PairingViewController to forward the Space step to the input lane.
    var onSpaceStep: ((Int) -> Void)?
    /// Test seam: when set, receives requests instead of the injected handler.
    var onRequestForTesting: ((InteractionPanelRequest) -> Void)?

    private let logger = Logger(subsystem: Config.logSubsystem, category: "gesture-surface")
    private var panelController: InteractionPanelWebViewController?
    private var panelContentView = UIView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        setUpPanel()
        configureContainer()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setUpPanel()
        configureContainer()
    }

    private func setUpPanel() {
        do {
            let controller = try InteractionPanelWebViewController(transport: self)
            // The gesture UI needs the camera; grant capture from the bundled
            // origin (the app must also declare NSCameraUsageDescription).
            controller.webView.uiDelegate = self
            panelController = controller
            panelContentView = controller.webView
        } catch {
            logger.error("gesture-surface: InteractionPanel init failed: \(String(describing: error), privacy: .public)")
            panelContentView = unavailableFallback()
        }
    }

    /// Visible placeholder when the panel could not be constructed (missing or
    /// misconfigured bundled web assets), so the surface is never a mute blank.
    private func unavailableFallback() -> UIView {
        let label = UILabel()
        label.text = "Gesture view unavailable"
        label.textAlignment = .center
        label.textColor = .secondaryLabel
        label.numberOfLines = 0
        label.accessibilityIdentifier = "gesture-surface-unavailable"
        return label
    }

    private func configureContainer() {
        backgroundColor = .systemBackground
        panelContentView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(panelContentView)
        NSLayoutConstraint.activate([
            panelContentView.topAnchor.constraint(equalTo: topAnchor),
            panelContentView.leadingAnchor.constraint(equalTo: leadingAnchor),
            panelContentView.trailingAnchor.constraint(equalTo: trailingAnchor),
            panelContentView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    func teardown() {
        panelController?.teardown()
        panelController = nil
    }

    // MARK: - InteractionPanelTransport

    func sendInteractionRequest(_ request: InteractionPanelRequest) {
        if let onRequestForTesting {
            onRequestForTesting(request)
            return
        }
        switch request {
        case .spaceStep(let delta):
            onSpaceStep?(delta)
        }
    }

    // MARK: - WKUIDelegate

    nonisolated func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        decisionHandler(.grant)
    }
}
