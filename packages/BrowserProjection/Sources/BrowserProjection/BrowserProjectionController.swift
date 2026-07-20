import Foundation
import WebKit

@MainActor
public final class BrowserProjectionController: NSObject {
    public let view: WKWebView

    public var onProbe: ((_ marker: String, _ nodeCount: Int) -> Void)?
    public var onTap: ((_ x: Double, _ y: Double) -> Void)?
    public var onScroll: ((_ x: Double, _ y: Double, _ dx: Double, _ dy: Double) -> Void)?
    public var onLog: ((_ message: String) -> Void)?

    private var runtimeLoaded = false
    private var tornDown = false
    private var pendingJSON: [String] = []
    var evaluateScript: ((String) -> Void)?

    public override convenience init() {
        self.init(loadsRuntime: true)
    }

    init(loadsRuntime: Bool) {
        let contentController = WKUserContentController()
        contentController.addUserScript(WKUserScript(
            source: Self.diagnosticsShimSource,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        ))
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = contentController
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.setURLSchemeHandler(
            BrowserProjectionSchemeHandler(root: BrowserProjectionResources.rootURL),
            forURLScheme: BrowserProjectionSchemeHandler.scheme
        )
        view = WKWebView(frame: .zero, configuration: configuration)
        super.init()

        let proxy = BrowserProjectionScriptMessageProxy(target: self)
        contentController.add(proxy, name: "domMirror")
        contentController.add(proxy, name: "domLog")
        view.navigationDelegate = self
        view.allowsBackForwardNavigationGestures = false
        evaluateScript = { [weak view] script in
            view?.evaluateJavaScript(script, completionHandler: nil)
        }

        #if os(iOS)
        view.scrollView.bounces = false
        view.scrollView.minimumZoomScale = 1
        view.scrollView.maximumZoomScale = 4
        view.scrollView.bouncesZoom = true
        #endif

        if loadsRuntime {
            let requestURL = URL(string: "\(BrowserProjectionSchemeHandler.scheme)://app/index.html")!
            view.load(URLRequest(url: requestURL))
        }
    }

    public func deliver(rawJSON: String) {
        guard !tornDown else { return }
        if runtimeLoaded {
            callDeliver(rawJSON)
        } else {
            pendingJSON.append(rawJSON)
        }
    }

    public func teardown() {
        guard !tornDown else { return }
        tornDown = true
        view.navigationDelegate = nil
        view.configuration.userContentController.removeScriptMessageHandler(forName: "domMirror")
        view.configuration.userContentController.removeScriptMessageHandler(forName: "domLog")
        view.evaluateJavaScript("window.__domMirrorBridge?.destroy?.()", completionHandler: nil)
        pendingJSON = []
        runtimeLoaded = false
    }

    func markRuntimeLoaded() {
        guard !tornDown else { return }
        runtimeLoaded = true
        let queued = pendingJSON
        pendingJSON = []
        for rawJSON in queued { callDeliver(rawJSON) }
    }

    func handleScriptMessage(_ body: [String: Any]) {
        switch body["kind"] as? String {
        case "tap":
            onTap?(number(body["x"]), number(body["y"]))
        case "scroll":
            onScroll?(
                number(body["x"]),
                number(body["y"]),
                number(body["dx"]),
                number(body["dy"])
            )
        case "probe":
            onProbe?(body["marker"] as? String ?? "", (body["nodes"] as? NSNumber)?.intValue ?? 0)
        default:
            break
        }
    }

    private func callDeliver(_ rawJSON: String) {
        evaluateScript?("window.__domMirrorDeliver(\(rawJSON))")
    }

    private func number(_ value: Any?) -> Double {
        (value as? NSNumber)?.doubleValue ?? 0
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
      var originalError = console.error;
      console.error = function () { post('error', arguments); originalError.apply(console, arguments); };
    })();
    """
}

extension BrowserProjectionController: WKNavigationDelegate {
    nonisolated public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Task { @MainActor [weak self] in self?.markRuntimeLoaded() }
    }

    nonisolated public func webView(
        _ webView: WKWebView,
        didFail navigation: WKNavigation!,
        withError error: any Error
    ) {
        Task { @MainActor [weak self] in self?.onLog?("projection load failed: \(error.localizedDescription)") }
    }

    nonisolated public func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: any Error
    ) {
        Task { @MainActor [weak self] in self?.onLog?("projection load failed: \(error.localizedDescription)") }
    }
}

extension BrowserProjectionController: WKScriptMessageHandler {
    public func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard let body = message.body as? [String: Any] else { return }
        Task { @MainActor [weak self] in
            guard let self else { return }
            if message.name == "domLog" {
                self.onLog?(body["message"] as? String ?? "unknown projection error")
            } else {
                self.handleScriptMessage(body)
            }
        }
    }
}

private final class BrowserProjectionScriptMessageProxy: NSObject, WKScriptMessageHandler {
    private weak var target: (any WKScriptMessageHandler & AnyObject)?

    init(target: any WKScriptMessageHandler & AnyObject) {
        self.target = target
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}
