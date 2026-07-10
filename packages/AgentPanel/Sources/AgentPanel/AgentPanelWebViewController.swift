import Foundation
import WebKit

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

    public init(
        transport: (any AgentPanelTransport)?,
        resources: AgentPanelResourceLocator = AgentPanelResourceLocator(),
        contract: AgentPanelJavaScriptContract = .agentFeed
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
        contentController.add(
            AgentPanelWeakScriptMessageProxy(target: self),
            name: contract.messageHandlerName
        )
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
        webView.evaluateJavaScript("window.__agentFeedBridge?.destroy?.()") { _, _ in }
    }

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
