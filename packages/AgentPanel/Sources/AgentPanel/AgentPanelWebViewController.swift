import Foundation
import WebKit
import WebPanelKit

/// AgentPanel's typed webview controller. A thin adapter over the shared
/// `WebPanelWebViewController`: it owns the same public surface AgentDesk's host
/// and client already use, and decodes the generic `(tag, body)` messages into
/// `AgentPanelRequest` before handing them to the transport.
@MainActor
public final class AgentPanelWebViewController: NSObject, WebPanelMessageSink {
    public enum InitializationError: Error, Equatable {
        case missingResourceRoot
        case invalidRequestURL
    }

    private let core: WebPanelWebViewController

    public var webView: WKWebView { core.webView }
    public weak var transport: (any AgentPanelTransport)?

    public init(
        transport: (any AgentPanelTransport)?,
        resources: AgentPanelResourceLocator = AgentPanelResourceLocator(),
        contract: AgentPanelJavaScriptContract = .agentFeed,
        additionalUserScripts: [WKUserScript] = []
    ) throws {
        guard let rootDirectory = resources.rootDirectory(indexPath: contract.indexPath) else {
            throw InitializationError.missingResourceRoot
        }
        do {
            core = try WebPanelWebViewController(
                contract: contract.webPanelContract,
                resourceRootDirectory: rootDirectory,
                messageSink: nil,
                additionalUserScripts: additionalUserScripts,
                logSubsystem: "com.example.agentdesk.AgentPanel"
            )
        } catch {
            throw InitializationError.invalidRequestURL
        }
        self.transport = transport
        super.init()
        core.messageSink = self
    }

    public func deliver(rawJSON: String) {
        core.deliver(rawJSON: rawJSON)
    }

    public func resumeAfterSessionReconnect() {
        core.resumeAfterSessionReconnect()
    }

    public func teardown() {
        core.teardown()
    }

    // MARK: WebPanelMessageSink

    public func webPanel(didReceiveTag tag: String, body: [String: Any]) {
        guard let request = AgentPanelRequest.decode(tag: tag, body: body) else {
            return
        }
        transport?.sendAgentPanelRequest(request)
    }
}
