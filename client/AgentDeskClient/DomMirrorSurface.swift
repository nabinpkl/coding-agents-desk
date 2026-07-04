import Foundation
import OSLog
import UIKit
import WebKit

// ADR-0038 DOM mirror: a WKWebView hosting the bundled rrweb replayer. Mirrors AgentFeedSurface's
// structure (custom scheme + documentStart diagnostics shim + retain-cycle-safe proxy), but the
// bridge is one-directional for read-only v1:
//   - Outbound (native -> JS): deliver(rawJSON) -> window.__domMirrorDeliver(batch)
//   - Inbound  (JS -> native): the replayer posts a `domMirror` probe summarizing the reconstructed
//     DOM (marker attribute + node count) so the autonomous harness can assert the mirror worked
//     without a human; `domLog` carries JS errors/console to OSLog.
// Reuses the generic AgentFeedSchemeHandler (it just serves a root directory).
@MainActor
final class DomMirrorSurface: UIView {
    private let logger = Logger(subsystem: Config.logSubsystem, category: "dom-mirror-surface")

    // Observers can watch the probe (e.g. tests); production just logs it.
    var onProbe: ((_ marker: String, _ nodes: Int) -> Void)?

    private var webView: WKWebView?
    private var isLoaded = false
    private var torn = false
    private var pendingJSON: [String] = []
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
        let proxy = WeakDomScriptMessageProxy(target: self)
        contentController.add(proxy, name: "domMirror")
        contentController.add(proxy, name: "domLog")
        contentController.addUserScript(WKUserScript(
            source: Self.diagnosticsShimSource,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        ))

        let config = WKWebViewConfiguration()
        config.userContentController = contentController
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.setURLSchemeHandler(
            AgentFeedSchemeHandler(rootDirectory: Config.domMirrorWebviewRootURL),
            forURLScheme: Config.domMirrorWebviewScheme
        )

        let wv = WKWebView(frame: .zero, configuration: config)
        wv.navigationDelegate = self
        wv.translatesAutoresizingMaskIntoConstraints = false
        wv.isUserInteractionEnabled = false // read-only v1: no taps back to Chrome yet (Phase 5)
        addSubview(wv)
        NSLayoutConstraint.activate([
            wv.topAnchor.constraint(equalTo: topAnchor),
            wv.leadingAnchor.constraint(equalTo: leadingAnchor),
            wv.trailingAnchor.constraint(equalTo: trailingAnchor),
            wv.bottomAnchor.constraint(equalTo: bottomAnchor)
        ])
        webView = wv
        evaluateScript = { [weak wv] js in wv?.evaluateJavaScript(js, completionHandler: nil) }

        if let url = Config.domMirrorWebviewIndexRequestURL {
            wv.load(URLRequest(url: url))
        } else {
            logger.error("DomMirrorSurface: index request URL is nil")
        }
    }

    private static let diagnosticsShimSource = """
    (function () {
      function post(kind, args) {
        try {
          window.webkit.messageHandlers.domLog.postMessage({
            kind: kind,
            message: Array.prototype.map.call(args, function (a) {
              try { return typeof a === 'string' ? a : JSON.stringify(a); } catch (e) { return String(a); }
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
    })();
    """

    // MARK: - Outbound: native -> webview

    // Deliver one raw DOM batch JSON ({t,tb,co,ev,meta}) to the replayer. Queued until loaded.
    func deliver(rawJSON: String) {
        guard !torn else { return }
        if isLoaded { callDeliverJS(rawJSON) } else { pendingJSON.append(rawJSON) }
    }

    private func callDeliverJS(_ rawJSON: String) {
        let js = "window.__domMirrorDeliver(\(rawJSON))"
        if let evaluateScript { evaluateScript(js) } else { webView?.evaluateJavaScript(js, completionHandler: nil) }
    }

    private func flushPending() {
        let queued = pendingJSON
        pendingJSON = []
        for json in queued { callDeliverJS(json) }
    }

    func teardown() {
        torn = true
        webView?.navigationDelegate = nil
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "domMirror")
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "domLog")
        webView?.evaluateJavaScript("window.__domMirrorBridge?.destroy?.()", completionHandler: nil)
        isLoaded = false
        pendingJSON = []
    }

    func markLoaded() {
        guard !torn else { return }
        isLoaded = true
        flushPending()
    }
}

// MARK: - WKNavigationDelegate

extension DomMirrorSurface: WKNavigationDelegate {
    nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Task { @MainActor [weak self] in self?.markLoaded() }
    }

    nonisolated func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        Task { @MainActor [weak self] in
            self?.logger.error("DomMirrorSurface didFail: \(String(describing: error), privacy: .public)")
        }
    }
}

// MARK: - WKScriptMessageHandler (via proxy)

extension DomMirrorSurface: WKScriptMessageHandler {
    nonisolated func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        if message.name == "domLog" {
            guard let body = message.body as? [String: Any],
                  let text = body["message"] as? String else { return }
            Task { @MainActor [weak self] in
                self?.logger.error("dom-mirror JS: \(text, privacy: .public)")
            }
            return
        }
        // domMirror: the probe summary of the reconstructed DOM.
        guard let body = message.body as? [String: Any], (body["kind"] as? String) == "probe" else { return }
        let marker = body["marker"] as? String ?? ""
        let nodes = body["nodes"] as? Int ?? 0
        Task { @MainActor [weak self] in
            guard let self else { return }
            let line = "dom-mirror-probe marker=\(marker) nodes=\(nodes)"
            // os_log for normal diagnostics always. The stderr copy exists only so the autonomous sim
            // harness can grep it (`simctl launch --console` does not capture os_log on stdout); it is
            // gated behind an env flag so a production build never writes it. The payload is
            // masking-safe regardless (marker attribute + node count, never page text).
            self.logger.notice("\(line, privacy: .public)")
            if ProcessInfo.processInfo.environment["AGENTDESK_DOM_MIRROR_PROBE_STDERR"] == "1" {
                FileHandle.standardError.write(Data(("[dom-mirror] " + line + "\n").utf8))
            }
            self.onProbe?(marker, nodes)
        }
    }
}

// Retain-cycle-safe proxy (WKWebView strongly retains the handler; hold only a weak ref).
private final class WeakDomScriptMessageProxy: NSObject, WKScriptMessageHandler {
    private weak var target: (any WKScriptMessageHandler & AnyObject)?
    init(target: any WKScriptMessageHandler & AnyObject) { self.target = target }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        target?.userContentController(c, didReceive: m)
    }
}
