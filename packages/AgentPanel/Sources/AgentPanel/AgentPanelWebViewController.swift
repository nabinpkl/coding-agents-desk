import Foundation
import os
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
        /// Only the inert fixture is bundled: the Vite output is missing, so this build would serve a
        /// blank panel that silently drops every host push. Run `just build-agent-webview`.
        case missingWebviewBuild
        case invalidRequestURL
    }

    private static let logSubsystem = "com.example.agentdesk.AgentPanel"

    private let core: WebPanelWebViewController
    private let logger = Logger(subsystem: AgentPanelWebViewController.logSubsystem, category: "agent-panel")

    public var webView: WKWebView { core.webView }
    public weak var transport: (any AgentPanelTransport)?

    public init(
        transport: (any AgentPanelTransport)?,
        resources: AgentPanelResourceLocator = AgentPanelResourceLocator(),
        contract: AgentPanelJavaScriptContract = .agentFeed,
        additionalUserScripts: [WKUserScript] = []
    ) throws {
        let rootDirectory = try Self.servableRoot(resources.resolve(indexPath: contract.indexPath))
        do {
            core = try WebPanelWebViewController(
                contract: contract.webPanelContract,
                resourceRootDirectory: rootDirectory,
                messageSink: nil,
                additionalUserScripts: additionalUserScripts,
                logSubsystem: Self.logSubsystem
            )
        } catch {
            // The typed error keeps the public surface small, so the underlying cause is logged
            // rather than dropped: without this, a core failure reaches the container as a bare
            // "invalidRequestURL" that names the wrong thing.
            Logger(subsystem: Self.logSubsystem, category: "agent-panel").error(
                "agent-panel: web panel init failed: \(String(describing: error), privacy: .public)"
            )
            throw InitializationError.invalidRequestURL
        }
        self.transport = transport
        super.init()
        core.messageSink = self
    }

    /// The one place the fixture is turned away. Kept pure and separate from bundle IO so the
    /// refusal is testable without faking a resource bundle: a fixture-only tree is a build error,
    /// not a degraded panel. Both native containers already render a visible, AX-identified
    /// "unavailable" surface and log the thrown case when this fails, which is the loud failure the
    /// old silent fallback replaced.
    nonisolated static func servableRoot(_ resolved: AgentPanelResourceRoot?) throws -> URL {
        guard let resolved else { throw InitializationError.missingResourceRoot }
        guard !resolved.isFixture else { throw InitializationError.missingWebviewBuild }
        return resolved.url
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
            // A rejected message is dropped, and a dropped request looks identical to a hung one from
            // the panel: the view just never fills. The abbreviated wire keys are mirrored by hand
            // across three codebases (host Swift, this decoder, the web BridgeDataSource), so key
            // drift is the likeliest cause and the keys are what identifies it. Values are omitted;
            // they carry project paths and session ids and add nothing to that diagnosis.
            logger.error(
                "agent-panel: rejected message tag=\(tag, privacy: .public) keys=\(body.keys.sorted().joined(separator: ","), privacy: .public)"
            )
            return
        }
        transport?.sendAgentPanelRequest(request)
    }
}
