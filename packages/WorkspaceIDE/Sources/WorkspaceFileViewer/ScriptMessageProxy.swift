import WebKit

/// Bridge for `WKScriptMessageHandler`. `WKUserContentController` retains its handler, so each web
/// surface registers this small proxy rather than itself and keeps ownership explicit.
public final class ScriptMessageProxy: NSObject, WKScriptMessageHandler {
    private let onMessage: (Any) -> Void

    public init(_ onMessage: @escaping (Any) -> Void) {
        self.onMessage = onMessage
    }

    public func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        onMessage(message.body)
    }
}

/// Mutable sink used while constructing a `WKWebView`: script handlers must be installed on the
/// configuration before the web view is created, but the owning surface is not available until
/// after `super.init()`.
public final class ScriptMessageSink {
    public var onMessage: ((Any) -> Void)?

    public init() {}

    public func handle(_ body: Any) {
        onMessage?(body)
    }
}
