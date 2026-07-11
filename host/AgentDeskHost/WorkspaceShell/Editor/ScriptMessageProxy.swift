import WebKit

/// Bridge for `WKScriptMessageHandler`. `WKUserContentController` retains its handler, so each web
/// surface registers this small proxy rather than itself and keeps ownership explicit.
final class ScriptMessageProxy: NSObject, WKScriptMessageHandler {
    private let onMessage: (Any) -> Void

    init(_ onMessage: @escaping (Any) -> Void) {
        self.onMessage = onMessage
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        onMessage(message.body)
    }
}

/// Mutable sink used while constructing a `WKWebView`: script handlers must be installed on the
/// configuration before the web view is created, but the owning surface is not available until
/// after `super.init()`.
final class ScriptMessageSink {
    var onMessage: ((Any) -> Void)?

    func handle(_ body: Any) {
        onMessage?(body)
    }
}
