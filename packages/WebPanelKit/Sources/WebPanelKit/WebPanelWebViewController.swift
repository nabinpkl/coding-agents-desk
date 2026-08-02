import Foundation
import WebKit
import os

/// Hosts a panel's bundled webview: serves assets over the contract's scheme,
/// buffers + serializes native-to-JS delivery, bridges JS errors to os_log, and
/// forwards JS-to-native messages as raw `(tag, body)` to a sink.
///
/// Request-agnostic by design — each panel decodes its own request type in its
/// `WebPanelMessageSink`, so one controller serves AgentPanel, the interaction
/// panel, and any future panel.
@MainActor
public final class WebPanelWebViewController: NSObject {
    public enum InitializationError: Error, Equatable {
        case missingResourceRoot
        case invalidRequestURL
    }

    public let webView: WKWebView
    public weak var messageSink: (any WebPanelMessageSink)?

    private let contract: WebPanelContract
    private let logger: Logger
    private var deliveryQueue: WebPanelDeliveryQueue?
    private var serialDelivery: WebPanelSerialDelivery?
    private var tornDown = false

    /// Script-message handler name the diagnostics shim posts JS errors/warnings
    /// to. Distinct from `contract.messageHandlerName` (which carries requests)
    /// so a blank or erroring panel is never debugged blind.
    static let diagnosticsHandlerName = "webPanelLog"

    public init(
        contract: WebPanelContract,
        resourceRootDirectory: URL?,
        messageSink: (any WebPanelMessageSink)?,
        additionalUserScripts: [WKUserScript] = [],
        logSubsystem: String = "com.example.agentdesk.WebPanelKit"
    ) throws {
        guard let rootDirectory = resourceRootDirectory else {
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
            WebPanelSchemeHandler(rootDirectory: rootDirectory),
            forURLScheme: contract.scheme
        )
        let createdWebView = WebPanelWebView(frame: .zero, configuration: configuration)

        self.webView = createdWebView
        self.messageSink = messageSink
        self.contract = contract
        self.logger = Logger(subsystem: logSubsystem, category: "web-panel-js")
        super.init()

        serialDelivery = WebPanelSerialDelivery { [weak self] rawJSON in
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
        deliveryQueue = WebPanelDeliveryQueue { [weak self] rawJSON in
            self?.serialDelivery?.enqueue(rawJSON: rawJSON)
        }
        let proxy = WebPanelWeakScriptMessageProxy(target: self)
        contentController.add(proxy, name: contract.messageHandlerName)
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
              if (window.\(contract.bridgeGlobalName) &&
                  typeof window.\(contract.bridgeGlobalName).resumeAfterSessionReconnect === 'function') {
                window.\(contract.bridgeGlobalName).resumeAfterSessionReconnect();
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
        webView.evaluateJavaScript("window.\(contract.bridgeGlobalName)?.destroy?.()") { _, _ in }
    }

    /// Forwards JS errors and console.error/warn to the native diagnostics
    /// handler so they surface in os_log. Injected at documentStart so it
    /// catches early errors before the app bundle runs.
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

extension WebPanelWebViewController: WKNavigationDelegate {
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

extension WebPanelWebViewController: WKScriptMessageHandler {
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
              let tag = body["t"] as? String else {
            return
        }
        messageSink?.webPanel(didReceiveTag: tag, body: Self.payload(from: body))
    }

    /// JS posts the tag inside the same dictionary it labels. Dropping it here
    /// gives that key exactly one owner, so a panel's decoder sees payload
    /// fields only and can reject an unexpected one without also having to know
    /// about the envelope. A decoder that counts its keys is otherwise wrong by
    /// exactly one, and its request is dropped with no error anywhere.
    static func payload(from body: [String: Any]) -> [String: Any] {
        var payload = body
        payload.removeValue(forKey: "t")
        return payload
    }

    private func handleDiagnostics(_ body: Any) {
        guard let dict = body as? [String: Any],
              let text = dict["message"] as? String else {
            return
        }
        let kind = dict["kind"] as? String ?? "error"
        if kind == "warn" {
            logger.warning("js: \(text, privacy: .public)")
        } else {
            logger.error("js: \(text, privacy: .public)")
        }
    }
}

private final class WebPanelWeakScriptMessageProxy: NSObject, WKScriptMessageHandler {
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
