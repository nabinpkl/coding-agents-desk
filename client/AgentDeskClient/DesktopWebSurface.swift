import OSLog
import UIKit
import WebKit
import AgentDeskWire
import AgentPanel

/// A thin first-party container for the TypeScript desktop entry.
///
/// Swift names the entry, loads the host-stated panel origin, and owns teardown. The page owns
/// display discovery, browser media, pointer input, errors, controls, and later viewer behavior.
final class DesktopWebSurface: UIView {
    private static let logger = Logger(subsystem: Config.logSubsystem, category: "desktop-web")

    private var panelController: AgentPanelWebViewController?
    private var contentView: UIView!
    private var loadPanel: ((URL?) -> Void)?
    private var selectedOrigin: URL?
    private var hasStartedPanel = false
    private(set) var isPresented = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        configure()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        configure()
    }

    /// Test seam for the load boundary. Production still owns one AgentPanel controller;
    /// tests substitute only its view and navigation call so no network or bundle is involved.
    init(panelViewForTesting: UIView, loadPanel: @escaping (URL?) -> Void) {
        super.init(frame: .zero)
        self.contentView = panelViewForTesting
        self.loadPanel = loadPanel
        configureContainer()
    }

    func setPresented(_ presented: Bool) {
        guard isPresented != presented else { return }
        isPresented = presented
        isHidden = !presented
        if presented {
            setNeedsLayout()
        }
    }

    func applyPanelOrigin(_ push: AgentPanelOriginPush) {
        switch AgentFeedSurface.panelOrigin(from: push.origin) {
        case .bundled:
            selectedOrigin = nil
        case .live(let url):
            selectedOrigin = url
        case .refused:
            Self.logger.error(
                "desktop-web: refused panel origin \(push.origin ?? "", privacy: .public)"
            )
            return
        }
        if hasStartedPanel {
            loadPanel?(selectedOrigin)
        }
    }

    func teardown() {
        panelController?.teardown()
        panelController = nil
        loadPanel = nil
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if isPresented {
            setNeedsLayout()
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        startPanelIfReady()
    }

    private func configure() {
        backgroundColor = .black
        do {
            let entryScript = WKUserScript(
                source: "window.__agentPanelEntry = 'desktop';",
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
            let controller = try AgentPanelWebViewController(
                transport: nil,
                additionalUserScripts: [entryScript],
                loadsImmediately: false
            )
            panelController = controller
            contentView = controller.webView
            loadPanel = { [weak controller] origin in
                controller?.loadPanel(origin: origin)
            }
        } catch {
            Self.logger.error(
                "desktop-web: AgentPanel init failed: \(String(describing: error), privacy: .public)"
            )
            let label = UILabel()
            label.text = "WebView unavailable"
            label.textAlignment = .center
            label.textColor = .secondaryLabel
            label.accessibilityIdentifier = "desktop-web-unavailable"
            contentView = label
        }

        configureContainer()
    }

    private func configureContainer() {
        isHidden = true
        contentView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(contentView)
        NSLayoutConstraint.activate([
            contentView.topAnchor.constraint(equalTo: topAnchor),
            contentView.leadingAnchor.constraint(equalTo: leadingAnchor),
            contentView.trailingAnchor.constraint(equalTo: trailingAnchor),
            contentView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    /// WebKit snapshots its initial viewport when navigation begins. The panel is therefore
    /// mounted first and navigation starts only after UIKit has attached and sized both views.
    /// QUIC may choose the origin before or after this point, but it does not own this lifecycle.
    private func startPanelIfReady() {
        guard
            !hasStartedPanel,
            isPresented,
            window != nil,
            bounds.width > 0,
            bounds.height > 0,
            contentView.bounds.width > 0,
            contentView.bounds.height > 0,
            let loadPanel
        else { return }

        hasStartedPanel = true
        Self.logger.notice(
            "desktop-web: starting panel in viewport \(Int(self.contentView.bounds.width))x\(Int(self.contentView.bounds.height))"
        )
        loadPanel(selectedOrigin)
    }
}
