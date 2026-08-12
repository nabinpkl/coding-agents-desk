import Foundation
import WebKit
import os

/// A native handler for one extra script-message channel, keyed by its handler name.
///
/// The container's own chrome talks over these rather than the contract channel: window commands
/// are not panel requests, and a container that owns none of them registers none.
public typealias WebPanelScriptMessageHandler = @MainActor (Any) -> Void

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

    /// Fires when the page starts navigating, including a reload.
    ///
    /// The delivery queue's own `markNotReady` is the same edge, but a container often has
    /// per-page state of its own outside this controller -- in-flight work keyed by ids the
    /// page chose, which a reloaded page will choose again -- and nothing else tells it the
    /// page it was talking to is gone.
    public var onNavigationStart: (@MainActor () -> Void)?

    private let contract: WebPanelContract
    /// Where the bundled build lives, or nil when this panel was built without one.
    private let bundledRequestURL: URL?
    /// What is on screen now, so a switch that changes nothing does not reload the page under a
    /// panel that is mid-conversation with its host.
    private var loadedURL: URL
    private let additionalMessageHandlers: [String: WebPanelScriptMessageHandler]
    private let logger: Logger
    private var deliveryQueue: WebPanelDeliveryQueue?
    private var serialDelivery: WebPanelSerialDelivery?
    private var tornDown = false

    /// Script-message handler name the diagnostics shim posts JS errors/warnings
    /// to. Distinct from `contract.messageHandlerName` (which carries requests)
    /// so a blank or erroring panel is never debugged blind.
    static let diagnosticsHandlerName = "webPanelLog"

    /// - Parameter developmentOrigin: When set, the panel's FIRST load comes from this origin
    ///   instead of the bundled assets. This is how a dev server's page -- and its hot module
    ///   replacement -- reaches the webview: the bridge does not care what origin the page came
    ///   from, because message handlers and `callAsyncJavaScript` are origin-independent and the
    ///   delivery global is installed by the page itself.
    ///
    ///   Which source is live is not fixed at init, because on the phone it cannot be: the client
    ///   starts before it has heard from its host, and the host is the only one that knows whether
    ///   a dev server is up (ADR-0096). So the scheme handler is installed whenever a bundled root
    ///   exists, even when starting from an origin, and `loadPanel(origin:)` switches later.
    public init(
        contract: WebPanelContract,
        resourceRootDirectory: URL?,
        messageSink: (any WebPanelMessageSink)?,
        additionalUserScripts: [WKUserScript] = [],
        additionalMessageHandlers: [String: WebPanelScriptMessageHandler] = [:],
        logSubsystem: String = "com.example.agentdesk.WebPanelKit",
        developmentOrigin: URL? = nil
    ) throws {
        // A dev origin serves its own assets, so a missing bundled root is survivable when one is
        // set -- that is the case the override exists for, a tree whose bundled build is stale or
        // absent. Without an origin there is nothing else to show, so it is an error.
        let rootDirectory = resourceRootDirectory
        let bundledURL = rootDirectory == nil ? nil : contract.indexRequestURL
        guard rootDirectory != nil || developmentOrigin != nil else {
            throw InitializationError.missingResourceRoot
        }
        guard let requestURL = developmentOrigin ?? bundledURL else {
            throw InitializationError.invalidRequestURL
        }
        for name in additionalMessageHandlers.keys {
            // A collision would shadow the shadowed channel's messages silently, and a panel whose
            // requests or diagnostics stop arriving looks exactly like a panel that never sent any.
            precondition(
                name != contract.messageHandlerName && name != Self.diagnosticsHandlerName,
                "Web panel message handler \(name) collides with a reserved channel"
            )
        }

        let contentController = WKUserContentController()
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = contentController
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        for script in additionalUserScripts {
            contentController.addUserScript(script)
        }
        if let rootDirectory {
            configuration.setURLSchemeHandler(
                WebPanelSchemeHandler(rootDirectory: rootDirectory),
                forURLScheme: contract.scheme
            )
        }
        let createdWebView = WebPanelWebView(frame: .zero, configuration: configuration)

        self.webView = createdWebView
        self.messageSink = messageSink
        self.contract = contract
        self.bundledRequestURL = bundledURL
        self.loadedURL = requestURL
        self.additionalMessageHandlers = additionalMessageHandlers
        self.logger = Logger(subsystem: logSubsystem, category: "web-panel-js")
        super.init()

        serialDelivery = WebPanelSerialDelivery { [weak self] rawJSONs in
            guard let self, !self.tornDown else {
                return
            }
            do {
                // One webview round trip per batch: the evaluated script fans the
                // messages out to the panel's own delivery function in order, so
                // the JS contract is unchanged while the batch's updates coalesce
                // into a single render pass on the webview side.
                _ = try await self.webView.callAsyncJavaScript(
                    Self.batchDeliveryScript(deliveryFunctionName: self.contract.deliveryFunctionName),
                    arguments: ["payloads": rawJSONs],
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
        for name in additionalMessageHandlers.keys {
            contentController.add(proxy, name: name)
        }
        contentController.addUserScript(WKUserScript(
            source: Self.diagnosticsShimSource,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        ))
        createdWebView.navigationDelegate = self
        createdWebView.load(URLRequest(url: requestURL))
    }

    /// Point the panel at a dev origin, or back at the bundled build with nil.
    ///
    /// Reloading is the whole mechanism, not a side effect: the page is the panel, so changing
    /// where its code comes from means loading it again. Everything downstream of that already
    /// handles a reload -- the delivery queue marks itself not ready, `onNavigationStart` lets the
    /// container drop per-page state, and the fresh page re-subscribes.
    ///
    /// A request that would change nothing is ignored, because the host re-states the origin on
    /// every attach and a reconnect must not throw away a live thread to arrive at the page it is
    /// already showing.
    public func loadPanel(origin: URL?) {
        guard let target = origin ?? bundledRequestURL else {
            // Asking for bundled when there is no bundled build. Not survivable by navigating
            // somewhere else, so the current page stays and the reason is said out loud.
            logger.error("web panel: asked for the bundled build, which this panel was built without")
            return
        }
        guard target != loadedURL else { return }
        logger.notice("web panel: loading from \(target.absoluteString, privacy: .public)")
        loadedURL = target
        webView.load(URLRequest(url: target))
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
        for name in additionalMessageHandlers.keys {
            webView.configuration.userContentController.removeScriptMessageHandler(forName: name)
        }
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
            self?.onNavigationStart?()
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
        if let handler = additionalMessageHandlers[message.name] {
            handler(message.body)
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

    /// The script that delivers one BATCH of native-to-JS messages in a single
    /// webview round trip. It fans the array out to the panel's own delivery
    /// function in order, so the JS contract is unchanged and React coalesces
    /// the batch into one render pass.
    ///
    /// The batch must arrive as a Swift `[String]` so `callAsyncJavaScript`
    /// converts it to a JS ARRAY of strings; passing the JSON-encoded array
    /// text instead makes `payloads` a string and the loop iterates characters,
    /// failing every delivery.
    static func batchDeliveryScript(deliveryFunctionName: String) -> String {
        """
        (function (payloads) {
          var deliver = window.\(deliveryFunctionName);
          if (typeof deliver !== 'function') return;
          for (var i = 0; i < payloads.length; i++) {
            deliver(JSON.parse(payloads[i]));
          }
        })(payloads)
        """
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
