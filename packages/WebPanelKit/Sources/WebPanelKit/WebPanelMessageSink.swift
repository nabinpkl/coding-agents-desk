import Foundation

/// Receives raw JS-to-native messages from a `WebPanelWebViewController`. The
/// controller stays request-agnostic: it forwards the message tag and body, and
/// each panel decodes its own request type in its sink implementation.
@MainActor
public protocol WebPanelMessageSink: AnyObject {
    func webPanel(didReceiveTag tag: String, body: [String: Any])
}
