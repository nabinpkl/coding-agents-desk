import Foundation
import OSLog
import UIKit
import WebKit
import AgentDeskWire

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
    // Set once teardown() runs. Guards deliver(), markLoaded(), and the didFinish
    // handler so a lagging onAgentPush task or a late navigation callback cannot
    // evaluateJavaScript on (or re-flush into) a torn-down page.
    private var torn = false
    private var pendingJSON: [String] = []
    // Test seam: when set, receives the delivered payload instead of evaluating
    // it in the real web view.
    var deliverForTesting: ((String) -> Void)?
    var resumeAfterReconnectForTesting: (() -> Void)?

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
        // JS-error bridge so a blank/erroring page is never debugged blind: the
        // documentStart shim forwards window.onerror and console.error/warn to
        // this handler, which logs to OSLog (category agent-surface).
        contentController.add(proxy, name: "agentLog")
        contentController.addUserScript(WKUserScript(
            source: Self.diagnosticsShimSource,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        ))

        let config = WKWebViewConfiguration()
        config.userContentController = contentController
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        // Serve the bundle under a custom scheme. A scheme handler MUST be set on
        // the configuration before the WKWebView is created; it cannot be added
        // afterward. The custom scheme gives the page a real origin so Vite's ES
        // module entry and dynamic imports load (file:// null-origin CORS-blocks
        // them, producing the blank page).
        config.setURLSchemeHandler(
            AgentFeedSchemeHandler(rootDirectory: Config.agentFeedWebviewRootURL),
            forURLScheme: Config.agentFeedWebviewScheme
        )

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

        loadBundle()
    }

    private func loadBundle() {
        guard let url = Config.agentFeedWebviewIndexRequestURL else {
            logger.error("AgentFeedSurface: agentFeedWebviewIndexRequestURL is nil")
            return
        }
        webView?.load(URLRequest(url: url))
    }

    // Forwards JS errors and console.error/warn to the native agentLog handler so
    // they surface in OSLog. Injected at documentStart so it catches early errors.
    private static let diagnosticsShimSource = """
    (function () {
      function post(kind, args) {
        try {
          window.webkit.messageHandlers.agentLog.postMessage({
            kind: kind,
            message: Array.prototype.map.call(args, function (a) {
              try { return typeof a === 'string' ? a : JSON.stringify(a); }
              catch (e) { return String(a); }
            }).join(' ')
          });
        } catch (e) {}
      }
      window.addEventListener('error', function (e) {
        post('error', [e.message + ' @ ' + (e.filename || '?') + ':' + (e.lineno || 0)]);
      });
      window.addEventListener('unhandledrejection', function (e) {
        post('error', ['unhandledrejection: ' + (e.reason && e.reason.message ? e.reason.message : e.reason)]);
      });
      var origError = console.error;
      console.error = function () { post('error', arguments); origError.apply(console, arguments); };
      var origWarn = console.warn;
      console.warn = function () { post('warn', arguments); origWarn.apply(console, arguments); };
    })();
    """

    // MARK: - Outbound: native -> webview

    // Deliver raw push JSON from the host to the webview. If the page has not
    // finished loading yet the payload is queued and flushed on didFinish.
    func deliver(rawJSON: String) {
        guard !torn else {
            logger.notice("agent-feed: deliver skipped, surface torn")
            return
        }
        logger.notice("agent-feed: deliver len=\(rawJSON.count, privacy: .public) isLoaded=\(self.isLoaded, privacy: .public)")
        if isLoaded {
            callDeliverJS(rawJSON)
        } else {
            pendingJSON.append(rawJSON)
        }
    }

    private func callDeliverJS(_ rawJSON: String) {
        if let deliverForTesting {
            deliverForTesting(rawJSON)
            return
        }
        // Pass the payload as a marshaled argument (callAsyncJavaScript, iOS 14+)
        // rather than interpolating it into JS source. Arbitrary agent-transcript
        // content (quotes, backslashes, U+2028/U+2029, etc.) then cannot break JS
        // parsing or inject code: the raw JSON crosses as a real string argument
        // and is parsed on the JS side. Source interpolation failed silently, which
        // is how a single bad push could leave the feed stuck with no error.
        Task { @MainActor [weak self] in
            guard let self, let webView = self.webView else { return }
            do {
                _ = try await webView.callAsyncJavaScript(
                    "window.__agentFeedDeliver(JSON.parse(payload))",
                    arguments: ["payload": rawJSON],
                    in: nil,
                    contentWorld: .page
                )
            } catch {
                self.logger.error("agent-feed: deliver failed: \(String(describing: error), privacy: .public)")
            }
        }
    }

    private func flushPending() {
        let queued = pendingJSON
        pendingJSON = []
        for json in queued {
            callDeliverJS(json)
        }
    }

    func resumeAfterSessionReconnect() {
        guard !torn else {
            logger.notice("agent-feed: reconnect resume skipped, surface torn")
            return
        }
        guard isLoaded else {
            logger.notice("agent-feed: reconnect resume skipped, page not loaded")
            return
        }
        if let resumeAfterReconnectForTesting {
            resumeAfterReconnectForTesting()
            return
        }
        webView?.evaluateJavaScript(Self.resumeAfterReconnectScript) { [logger] _, error in
            if let error {
                logger.error("agent-feed: reconnect resume failed: \(String(describing: error), privacy: .public)")
            }
        }
    }

    private static let resumeAfterReconnectScript = """
    (function () {
      if (window.__agentFeedBridge &&
          typeof window.__agentFeedBridge.resumeAfterSessionReconnect === 'function') {
        window.__agentFeedBridge.resumeAfterSessionReconnect();
        return;
      }
      window.location.reload();
    })();
    """

    // MARK: - Lifecycle

    func teardown() {
        torn = true
        // Stop the navigation delegate so a didFinish firing after teardown cannot
        // re-set isLoaded and re-flush (navigationDelegate is weak, so this is not a
        // leak fix, just an ordering guard).
        webView?.navigationDelegate = nil
        // Remove all message handlers so the content controller no longer holds the proxy.
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "agentFeed")
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "agentLog")
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
            self?.logger.info("AgentFeedSurface: navigation didFinish")
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
                "AgentFeedSurface: navigation didFail: \(String(describing: error), privacy: .public)"
            )
        }
    }

    nonisolated func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        Task { @MainActor [weak self] in
            self?.logger.error(
                "AgentFeedSurface: provisional navigation didFail: \(String(describing: error), privacy: .public)"
            )
        }
    }

    // Exposed for testing: mark the surface as loaded and flush pending payloads.
    // In production this is called from the nonisolated WKNavigationDelegate callback.
    func markLoaded() {
        guard !torn else { return }
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
        // Route by handler name. agentLog carries {kind, message} from the
        // diagnostics shim; agentFeed carries {t, ...} for bridge protocol.
        if message.name == "agentLog" {
            guard let body = message.body as? [String: Any],
                  let kind = body["kind"] as? String,
                  let text = body["message"] as? String else { return }
            Task { @MainActor [weak self] in
                guard let self else { return }
                if kind == "error" {
                    self.logger.error("JS \(kind, privacy: .public): \(text, privacy: .public)")
                } else {
                    self.logger.warning("JS \(kind, privacy: .public): \(text, privacy: .public)")
                }
            }
            return
        }

        // agentFeed bridge messages.
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
            // The phone subscribes by sessionId alone; projectPath is optional
            // (the host falls back to it only when sessionId is absent). Requiring
            // `pp` here would drop every phone thread-sub. Require at least one
            // identifier so an empty request is still rejected.
            let projectPath = body["pp"] as? String
            let source = body["src"] as? String
            let sessionId = body["sid"] as? String
            guard projectPath != nil || sessionId != nil else { return nil }
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
