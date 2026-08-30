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

    override init(frame: CGRect) {
        super.init(frame: frame)
        configure()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        configure()
    }

    func applyPanelOrigin(_ push: AgentPanelOriginPush) {
        switch AgentFeedSurface.panelOrigin(from: push.origin) {
        case .bundled:
            panelController?.loadPanel(origin: nil)
        case .live(let url):
            panelController?.loadPanel(origin: url)
        case .refused:
            Self.logger.error(
                "desktop-web: refused panel origin \(push.origin ?? "", privacy: .public)"
            )
        }
    }

    func teardown() {
        panelController?.teardown()
        panelController = nil
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
                additionalUserScripts: [entryScript]
            )
            panelController = controller
            contentView = controller.webView
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

        contentView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(contentView)
        NSLayoutConstraint.activate([
            contentView.topAnchor.constraint(equalTo: topAnchor),
            contentView.leadingAnchor.constraint(equalTo: leadingAnchor),
            contentView.trailingAnchor.constraint(equalTo: trailingAnchor),
            contentView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }
}
