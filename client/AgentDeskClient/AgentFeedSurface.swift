import Foundation
import OSLog
import UIKit
import WebKit

// AgentFeedSurface hosts a WKWebView that loads the bundled agent-feed web app.
// It bridges JavaScript to the QUIC input lane in both directions:
//   - Inbound  (JS -> native): window.webkit.messageHandlers.agentFeed.postMessage(...)
//   - Outbound (native -> JS): window.__agentFeedDeliver(rawJSON)
//
// Retain-cycle safety: WKWebView holds a strong reference to its
// WKUserContentController which in turn holds a strong reference to any
// registered WKScriptMessageHandler. To break the cycle we register a
// WeakScriptMessageProxy that holds only a weak reference to self.

@MainActor
final class AgentFeedSurface: UIView {
    private let logger = Logger(subsystem: Config.logSubsystem, category: "agent-feed-surface")

    // Injected by PairingViewController to forward inbound requests to InputChannel.
    var onAgentRequest: ((AgentFeedRequest) -> Void)?

    // Injected by PairingViewController (set to agentSurface.deliver) so the
    // OwnedMediaTransport push-forward closure has a concrete target.
    // This property is the *deliver* entry point; external callers use it via
    // the closure set on OwnedMediaTransport's onAgentPush.

    private var webView: WKWebView?
    private var isLoaded = false
    private var pendingJSON: [String] = []
    // evaluateJavaScript abstraction for testability.
    var evaluateScript: ((String) -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        setupWebView()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setupWebView()
    }

    private func setupWebView() {
        let contentController = WKUserContentController()
        let proxy = WeakScriptMessageProxy(target: self)
        contentController.add(proxy, name: "agentFeed")

        let config = WKWebViewConfiguration()
        config.userContentController = contentController
        // Allow file:// access to assets/ siblings of index.html.
        config.preferences.javaScriptEnabled = true

        let wv = WKWebView(frame: .zero, configuration: config)
        wv.navigationDelegate = self
        wv.translatesAutoresizingMaskIntoConstraints = false
        addSubview(wv)
        NSLayoutConstraint.activate([
            wv.topAnchor.constraint(equalTo: topAnchor),
            wv.leadingAnchor.constraint(equalTo: leadingAnchor),
            wv.trailingAnchor.constraint(equalTo: trailingAnchor),
            wv.bottomAnchor.constraint(equalTo: bottomAnchor)
        ])
        webView = wv

        // Set up the default evaluateScript closure so the real WKWebView is used.
        evaluateScript = { [weak wv] js in
            wv?.evaluateJavaScript(js, completionHandler: nil)
        }

        loadBundle()
    }

    private func loadBundle() {
        guard let url = Config.agentFeedWebviewIndexURL else {
            logger.error("AgentFeedSurface: agentFeedWebviewIndexURL is nil; bundle missing")
            return
        }
        // allowingReadAccessTo the directory so assets/ is reachable.
        webView?.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }

    // MARK: - Outbound: native -> webview

    // Deliver raw push JSON from the host to the webview. If the page has not
    // finished loading yet the payload is queued and flushed on didFinish.
    func deliver(rawJSON: String) {
        if isLoaded {
            callDeliverJS(rawJSON)
        } else {
            pendingJSON.append(rawJSON)
        }
    }

    private func callDeliverJS(_ rawJSON: String) {
        let js = "window.__agentFeedDeliver(\(rawJSON))"
        if let evaluateScript {
            evaluateScript(js)
        } else {
            webView?.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    private func flushPending() {
        let queued = pendingJSON
        pendingJSON = []
        for json in queued {
            callDeliverJS(json)
        }
    }

    // MARK: - Lifecycle

    func teardown() {
        // Remove the message handler so the content controller no longer holds the proxy.
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "agentFeed")
        // Ask the JS side to clean up if it exposes a destroy hook.
        webView?.evaluateJavaScript("window.__agentFeedBridge?.destroy?.()", completionHandler: nil)
        isLoaded = false
        pendingJSON = []
    }
}

// MARK: - WKNavigationDelegate

extension AgentFeedSurface: WKNavigationDelegate {
    nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Task { @MainActor [weak self] in
            self?.markLoaded()
        }
    }

    nonisolated func webView(
        _ webView: WKWebView,
        didFail navigation: WKNavigation!,
        withError error: Error
    ) {
        Task { @MainActor [weak self] in
            self?.logger.error(
                "AgentFeedSurface: navigation failed: \(String(describing: error), privacy: .public)"
            )
        }
    }

    // Exposed for testing: mark the surface as loaded and flush pending payloads.
    // In production this is called from the nonisolated WKNavigationDelegate callback.
    func markLoaded() {
        isLoaded = true
        flushPending()
    }
}

// MARK: - WKScriptMessageHandler (via proxy)

extension AgentFeedSurface: WKScriptMessageHandler {
    nonisolated func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard let body = message.body as? [String: Any],
              let tag = body["t"] as? String else {
            return
        }
        let request = AgentFeedRequest.decode(tag: tag, body: body)
        guard let request else { return }
        Task { @MainActor [weak self] in
            self?.onAgentRequest?(request)
        }
    }
}

// MARK: - Retain-cycle-safe proxy

// WKWebView strongly retains the WKScriptMessageHandler it registers, which
// would create a strong reference cycle: webView -> contentController -> handler
// -> AgentFeedSurface -> webView. The proxy holds only a weak reference to the
// real handler, breaking the cycle.
private final class WeakScriptMessageProxy: NSObject, WKScriptMessageHandler {
    private weak var target: (any WKScriptMessageHandler & AnyObject)?

    init(target: any WKScriptMessageHandler & AnyObject) {
        self.target = target
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        target?.userContentController(userContentController, didReceive: message)
    }
}

// MARK: - Inbound request decoding

// Decodes the four agent-feed request types from a JS postMessage body dictionary.
// Unknown t tags return nil (forward-compatible: ignored by the caller).
enum AgentFeedRequest {
    case projectsSubscribe
    case threadSubscribe(AgentThreadSubscribe)
    case threadLoadOlder(AgentThreadLoadOlder)
    case threadUnsubscribe(AgentThreadUnsubscribe)

    static func decode(tag: String, body: [String: Any]) -> AgentFeedRequest? {
        switch tag {
        case "agent-projects-sub":
            return .projectsSubscribe

        case "agent-thread-sub":
            guard let projectPath = body["pp"] as? String else { return nil }
            let source = body["src"] as? String
            let sessionId = body["sid"] as? String
            return .threadSubscribe(AgentThreadSubscribe(
                projectPath: projectPath,
                source: source,
                sessionId: sessionId
            ))

        case "agent-thread-older":
            guard let sessionId = body["sid"] as? String,
                  let beforeIndex = body["bi"] as? Int,
                  let limit = body["lim"] as? Int else { return nil }
            return .threadLoadOlder(AgentThreadLoadOlder(
                sessionId: sessionId,
                beforeIndex: beforeIndex,
                limit: limit
            ))

        case "agent-thread-unsub":
            guard let sessionId = body["sid"] as? String else { return nil }
            return .threadUnsubscribe(AgentThreadUnsubscribe(sessionId: sessionId))

        default:
            return nil
        }
    }
}
