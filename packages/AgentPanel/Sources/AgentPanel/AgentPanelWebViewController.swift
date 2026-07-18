import Foundation
import WebKit
import os

@MainActor
public final class AgentPanelWebViewController: NSObject {
    public enum InitializationError: Error, Equatable {
        case missingResourceRoot
        case invalidRequestURL
    }

    public let webView: WKWebView
    public weak var transport: (any AgentPanelTransport)?

    private let contract: AgentPanelJavaScriptContract
    private var deliveryQueue: AgentPanelDeliveryQueue?
    private var serialDelivery: AgentPanelSerialDelivery?
    private var tornDown = false

    /// Script-message handler name the diagnostics shim posts JS errors/warnings to. Distinct from
    /// `contract.messageHandlerName` (which carries agent requests) so a blank or erroring panel is
    /// never debugged blind on either platform.
    static let diagnosticsHandlerName = "agentPanelLog"
    private static let logger = Logger(subsystem: "com.example.agentdesk.AgentPanel", category: "agent-panel-js")

    public init(
        transport: (any AgentPanelTransport)?,
        resources: AgentPanelResourceLocator = AgentPanelResourceLocator(),
        contract: AgentPanelJavaScriptContract = .agentFeed,
        additionalUserScripts: [WKUserScript] = []
    ) throws {
        guard let rootDirectory = resources.rootDirectory(indexPath: contract.indexPath) else {
            throw InitializationError.missingResourceRoot
        }
        guard let requestURL = contract.indexRequestURL else {
            throw InitializationError.invalidRequestURL
        }

        let contentController = WKUserContentController()
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = contentController
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        for script in additionalUserScripts {
            contentController.addUserScript(script)
        }
        configuration.setURLSchemeHandler(
            AgentPanelSchemeHandler(rootDirectory: rootDirectory),
            forURLScheme: contract.scheme
        )
        let createdWebView = WKWebView(frame: .zero, configuration: configuration)

        self.webView = createdWebView
        self.transport = transport
        self.contract = contract
        super.init()

        serialDelivery = AgentPanelSerialDelivery { [weak self] rawJSON in
            guard let self, !self.tornDown else {
                return
            }
            do {
                _ = try await self.webView.callAsyncJavaScript(
                    "window.\(self.contract.deliveryFunctionName)(JSON.parse(payload))",
                    arguments: ["payload": rawJSON],
                    in: nil,
                    contentWorld: .page
                )
            } catch {
                // Navigation cancellation and a torn-down webview are expected.
            }
        }
        deliveryQueue = AgentPanelDeliveryQueue { [weak self] rawJSON in
            self?.serialDelivery?.enqueue(rawJSON: rawJSON)
        }
        let proxy = AgentPanelWeakScriptMessageProxy(target: self)
        contentController.add(proxy, name: contract.messageHandlerName)
        // JS-error bridge: forward window.onerror, unhandledrejection, and console.error/warn to
        // native os_log (category agent-panel-js), injected at documentStart so early errors are
        // caught. Shared by the iOS agent feed and the macOS Agents window.
        contentController.add(proxy, name: Self.diagnosticsHandlerName)
        contentController.addUserScript(WKUserScript(
            source: Self.diagnosticsShimSource,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        ))
        createdWebView.navigationDelegate = self
        createdWebView.load(URLRequest(url: requestURL))
    }

    public func deliver(rawJSON: String) {
        deliveryQueue?.enqueue(rawJSON: rawJSON)
    }

    public func resumeAfterSessionReconnect() {
        guard !tornDown else {
            return
        }
        webView.evaluateJavaScript(
            """
            (function () {
              if (window.__agentFeedBridge &&
                  typeof window.__agentFeedBridge.resumeAfterSessionReconnect === 'function') {
                window.__agentFeedBridge.resumeAfterSessionReconnect();
                return;
              }
              window.location.reload();
            })();
            """
        ) { _, _ in }
    }

    public func teardown() {
        guard !tornDown else {
            return
        }
        tornDown = true
        deliveryQueue?.teardown()
        serialDelivery?.cancel()
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.configuration.userContentController.removeScriptMessageHandler(forName: contract.messageHandlerName)
        webView.configuration.userContentController.removeScriptMessageHandler(forName: Self.diagnosticsHandlerName)
        webView.evaluateJavaScript("window.__agentFeedBridge?.destroy?.()") { _, _ in }
    }

    /// Forwards JS errors and console.error/warn to the native diagnostics handler so they surface
    /// in os_log. Injected at documentStart so it catches early errors before the app bundle runs.
    private static let diagnosticsShimSource = """
    (function () {
      function post(kind, args) {
        try {
          window.webkit.messageHandlers.\(diagnosticsHandlerName).postMessage({
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
}

extension AgentPanelWebViewController: WKNavigationDelegate {
    nonisolated public func webView(
        _ webView: WKWebView,
        didStartProvisionalNavigation navigation: WKNavigation!
    ) {
        Task { @MainActor [weak self] in
            self?.deliveryQueue?.markNotReady()
        }
    }

    nonisolated public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Task { @MainActor [weak self] in
            self?.deliveryQueue?.markReady()
        }
    }
}

extension AgentPanelWebViewController: WKScriptMessageHandler {
    public func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        if message.name == Self.diagnosticsHandlerName {
            handleDiagnostics(message.body)
            return
        }
        guard message.name == contract.messageHandlerName,
              let body = message.body as? [String: Any],
              let tag = body["t"] as? String,
              let request = AgentPanelRequest.decode(tag: tag, body: body) else {
            return
        }
        Task { @MainActor [weak self] in
            self?.transport?.sendAgentPanelRequest(request)
        }
    }

    private func handleDiagnostics(_ body: Any) {
        guard let dict = body as? [String: Any],
              let text = dict["message"] as? String else {
            return
        }
        let kind = dict["kind"] as? String ?? "error"
        if kind == "warn" {
            Self.logger.warning("js: \(text, privacy: .public)")
        } else {
            Self.logger.error("js: \(text, privacy: .public)")
        }
    }
}

private final class AgentPanelWeakScriptMessageProxy: NSObject, WKScriptMessageHandler {
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
