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
    // ADR-0040: a tap in the replayer, mapped to page CSS-pixel coords, to be sent back to Chrome.
    var onTap: ((_ x: Double, _ y: Double) -> Void)?
    // ADR-0047: a scroll drag in the replayer. x/y are the page CSS-pixel anchor, dx/dy the finger
    // movement delta in page CSS px; sent back to Chrome to drive the real tab's scroll.
    var onScroll: ((_ x: Double, _ y: Double, _ dx: Double, _ dy: Double) -> Void)?

    // ADR-0047: forward a mirror scroll drag to the host, UNLESS the view is pinch-zoomed. Once the
    // WKWebView scrollView.zoomScale exceeds 1, a single-finger drag pans the magnified view locally
    // (intrinsic UIScrollView zoom-pan); also driving the host tab from the same drag is a two-input
    // collision, so we suppress the host-scroll and let the native pan own the gesture. The tap is
    // already suppressed JS-side (a drag is a drag), so a zoomed pan drives neither. Model: navigate
    // the page at 1x, inspect locally when zoomed. zoomScale is the authoritative zoom state (JS
    // visualViewport tracking of WKWebView pinch is unreliable), so the gate lives here, not in the JS.
    func handleScroll(x: Double, y: Double, dx: Double, dy: Double) {
        guard (webView?.scrollView.zoomScale ?? 1) <= 1.01 else { return }
        onScroll?(x, y, dx, dy)
    }

    private var webView: WKWebView?
    private var isLoaded = false
    private var torn = false
    private var pendingJSON: [String] = []
    var evaluateScript: ((String) -> Void)?

    // ADR-0046 diagnostic status line (below the surface's top edge, i.e. below the Control | Agent |
    // Browser switcher). The surface owns its status state and re-renders the pills on each update
    // and on a 1s timer (so the "Xs ago" freshness advances even when no batch arrives).
    private let statusBar = UIView()
    private let statusStack = UIStackView()
    private var bridgeConnected = false
    private var recordingTab: Int?
    private var nodeCount: Int?
    private var batchCount = 0
    private var paused = false
    private var lastBatchAt: Date?
    private var ageTimer: Timer?

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

        setupStatusBar()

        let wv = WKWebView(frame: .zero, configuration: config)
        wv.navigationDelegate = self
        wv.translatesAutoresizingMaskIntoConstraints = false
        // ADR-0047: the page is a fixed viewport mirror (index.html #stage is overflow:hidden), so the
        // WKWebView scrollView never scrolls its own content; a scroll drag is captured in JS and sent
        // to Chrome. Kill the pan rubber-band so a drag doesn't bounce the whole mirror.
        wv.scrollView.bounces = false
        // ADR-0047 pinch-zoom for readability: let the user magnify the desktop-captured mirror on the
        // phone. This is a pure VIEW transform (a visual-viewport/scrollView zoom), NOT a page reflow
        // and NOT a host scroll, so it stays inside the pure-mirror invariant. Crucially it does not
        // change the DOM's getBoundingClientRect, so the tap/scroll page-space mapping in index.html is
        // unaffected. The page's own viewport meta is relaxed to maximum-scale=4 to admit the pinch;
        // these scrollView bounds are the belt-and-suspenders half of that (WebKit derives them from
        // the meta). bouncesZoom gives the natural rubber-band at the zoom limits.
        wv.scrollView.minimumZoomScale = 1
        wv.scrollView.maximumZoomScale = 4
        wv.scrollView.bouncesZoom = true
        addSubview(wv) // ADR-0040: interactive -- taps are captured in the replayer and sent back
        NSLayoutConstraint.activate([
            wv.topAnchor.constraint(equalTo: statusBar.bottomAnchor),
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

    // MARK: - ADR-0046 status line

    private func setupStatusBar() {
        statusBar.translatesAutoresizingMaskIntoConstraints = false
        statusBar.backgroundColor = UIColor.black.withAlphaComponent(0.06)
        addSubview(statusBar)
        NSLayoutConstraint.activate([
            statusBar.topAnchor.constraint(equalTo: topAnchor),
            statusBar.leadingAnchor.constraint(equalTo: leadingAnchor),
            statusBar.trailingAnchor.constraint(equalTo: trailingAnchor),
            statusBar.heightAnchor.constraint(equalToConstant: 26)
        ])

        statusStack.translatesAutoresizingMaskIntoConstraints = false
        statusStack.axis = .horizontal
        statusStack.spacing = 6
        statusStack.alignment = .center
        statusBar.addSubview(statusStack)
        NSLayoutConstraint.activate([
            statusStack.leadingAnchor.constraint(equalTo: statusBar.leadingAnchor, constant: 8),
            statusStack.trailingAnchor.constraint(lessThanOrEqualTo: statusBar.trailingAnchor, constant: -8),
            statusStack.centerYAnchor.constraint(equalTo: statusBar.centerYAnchor)
        ])

        renderStatus()
        // Advance the "Xs ago" freshness even when no new batch arrives.
        ageTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.renderStatus() }
        }
    }

    // Granular setters, called by the VC from the wired lane callbacks. Each re-renders the line.
    func setBridgeStatus(connected: Bool, recordingTab tab: Int?) {
        bridgeConnected = connected; recordingTab = tab; renderStatus()
    }
    func recordBatch() { lastBatchAt = Date(); batchCount += 1; renderStatus() }
    func setNodeCount(_ n: Int) { nodeCount = n; renderStatus() }
    func setPaused(_ p: Bool) { paused = p; renderStatus() }

    private func renderStatus() {
        let ageMs = lastBatchAt.map { Int(Date().timeIntervalSince($0) * 1000) }
        let status = DomMirrorStatus(
            bridgeConnected: bridgeConnected, recordingTab: recordingTab,
            lastBatchAgeMs: ageMs, nodeCount: nodeCount, batchCount: batchCount, paused: paused)
        let chips = statusChips(status)
        statusStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for chip in chips { statusStack.addArrangedSubview(Self.makePill(chip)) }
    }

    private static func makePill(_ chip: StatusChip) -> UIView {
        let label = InsetLabel()
        label.text = chip.text
        label.font = .systemFont(ofSize: 11, weight: .semibold)
        label.textColor = .white
        label.backgroundColor = color(for: chip.severity)
        label.layer.cornerRadius = 5
        label.layer.masksToBounds = true
        return label
    }

    private static func color(for severity: StatusSeverity) -> UIColor {
        switch severity {
        case .ok: return UIColor.systemGreen.withAlphaComponent(0.85)
        case .warn: return UIColor.systemOrange.withAlphaComponent(0.9)
        case .off: return UIColor.systemGray
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
        ageTimer?.invalidate()
        ageTimer = nil
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
        // domMirror: either a tap (ADR-0040) or the probe summary of the reconstructed DOM.
        guard let body = message.body as? [String: Any] else { return }
        if (body["kind"] as? String) == "tap" {
            // JSON numbers arrive as NSNumber; coerce to Double.
            let x = (body["x"] as? NSNumber)?.doubleValue ?? 0
            let y = (body["y"] as? NSNumber)?.doubleValue ?? 0
            Task { @MainActor [weak self] in self?.onTap?(x, y) }
            return
        }
        if (body["kind"] as? String) == "scroll" {
            // ADR-0047: a scroll drag. x/y anchor + dx/dy finger delta, all page CSS px.
            let x = (body["x"] as? NSNumber)?.doubleValue ?? 0
            let y = (body["y"] as? NSNumber)?.doubleValue ?? 0
            let dx = (body["dx"] as? NSNumber)?.doubleValue ?? 0
            let dy = (body["dy"] as? NSNumber)?.doubleValue ?? 0
            Task { @MainActor [weak self] in self?.handleScroll(x: x, y: y, dx: dx, dy: dy) }
            return
        }
        guard (body["kind"] as? String) == "probe" else { return }
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

// A UILabel with symmetric content insets, used for the status-line pills.
private final class InsetLabel: UILabel {
    private let insets = UIEdgeInsets(top: 2, left: 6, bottom: 2, right: 6)
    override func drawText(in rect: CGRect) { super.drawText(in: rect.inset(by: insets)) }
    override var intrinsicContentSize: CGSize {
        let s = super.intrinsicContentSize
        return CGSize(width: s.width + insets.left + insets.right,
                      height: s.height + insets.top + insets.bottom)
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
