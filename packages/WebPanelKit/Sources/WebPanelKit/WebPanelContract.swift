import Foundation

/// The JS-facing contract for a webview panel: the custom scheme it loads under,
/// the message-handler name it posts requests to, the delivery function native
/// calls to push data in, and the bridge global native calls to resume/destroy.
///
/// Panels supply their own instance (AgentPanel's `.agentFeed`, the interaction
/// panel's `.interaction`), so one `WebPanelWebViewController` serves them all.
public struct WebPanelContract: Equatable, Sendable {
    public let scheme: String
    public let host: String
    public let indexPath: String
    public let messageHandlerName: String
    public let deliveryFunctionName: String
    /// JS global (e.g. `__agentFeedBridge`) the controller calls for
    /// resume-after-reconnect and destroy. Panel-specific by design.
    public let bridgeGlobalName: String

    public init(
        scheme: String,
        host: String = "app",
        indexPath: String = "index.html",
        messageHandlerName: String,
        deliveryFunctionName: String,
        bridgeGlobalName: String
    ) {
        self.scheme = scheme
        self.host = host
        self.indexPath = indexPath
        self.messageHandlerName = messageHandlerName
        self.deliveryFunctionName = deliveryFunctionName
        self.bridgeGlobalName = bridgeGlobalName
    }

    public var indexRequestURL: URL? {
        URL(string: "\(scheme)://\(host)/\(indexPath)")
    }
}
