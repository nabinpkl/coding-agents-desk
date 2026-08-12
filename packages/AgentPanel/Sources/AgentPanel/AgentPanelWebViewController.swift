import Foundation
import os
import WebKit
import WebPanelKit

/// A native handler for one of the container's own script-message channels.
///
/// Re-exported under AgentPanel's name so a container can register window chrome without also
/// linking WebPanelKit for one type it would otherwise never mention.
public typealias AgentPanelScriptMessageHandler = WebPanelScriptMessageHandler

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
        /// The dev-origin override was set to something that is not an http(s) origin. Loud on
        /// purpose: a typo'd origin that fell back to the bundle would look like a working panel
        /// serving code nobody edited.
        case invalidDevelopmentOrigin(String)
    }

    private static let logSubsystem = "com.example.agentdesk.AgentPanel"

    private let core: WebPanelWebViewController
    private let logger = Logger(subsystem: AgentPanelWebViewController.logSubsystem, category: "agent-panel")

    public var webView: WKWebView { core.webView }
    public weak var transport: (any AgentPanelTransport)?

    /// Fires when the page starts navigating, including a reload. A container holding per-page
    /// state the page named itself uses this to drop it; see `WebPanelWebViewController`.
    public var onNavigationStart: (@MainActor () -> Void)? {
        get { core.onNavigationStart }
        set { core.onNavigationStart = newValue }
    }

    /// Switch the panel between a dev origin and the bundled build. Nil means bundled.
    ///
    /// The phone reaches this from its host rather than from its own environment, because a client
    /// installed by TestFlight has no environment to read and is exactly the install that has to
    /// work (ADR-0096).
    public func loadPanel(origin: URL?) {
        core.loadPanel(origin: origin)
    }

    public init(
        transport: (any AgentPanelTransport)?,
        resources: AgentPanelResourceLocator = AgentPanelResourceLocator(),
        contract: AgentPanelJavaScriptContract = .agentFeed,
        additionalUserScripts: [WKUserScript] = [],
        additionalMessageHandlers: [String: AgentPanelScriptMessageHandler] = [:]
    ) throws {
        let developmentOrigin = try Self.launchDevelopmentOrigin()
        // The bundled tree is resolved even when starting from a dev origin, because the panel can
        // be switched between the two at runtime now (ADR-0096) and the switch has nowhere to go
        // without it. A dev origin still excuses a stale or fixture-only build -- that is what the
        // override is for -- so its absence is only fatal when there is no origin either.
        let rootDirectory: URL?
        do {
            rootDirectory = try Self.servableRoot(resources.resolve(indexPath: contract.indexPath))
        } catch {
            guard developmentOrigin != nil else { throw error }
            Logger(subsystem: Self.logSubsystem, category: "agent-panel").notice(
                "agent-panel: no bundled build to fall back to, dev origin only"
            )
            rootDirectory = nil
        }
        if let developmentOrigin {
            // A fresh Logger, not the instance one: `self` is off limits until `super.init()`.
            Logger(subsystem: Self.logSubsystem, category: "agent-panel").notice(
                "agent-panel: serving from development origin \(developmentOrigin.absoluteString, privacy: .public)"
            )
        }
        do {
            core = try WebPanelWebViewController(
                contract: contract.webPanelContract,
                resourceRootDirectory: rootDirectory,
                messageSink: nil,
                additionalUserScripts: additionalUserScripts,
                additionalMessageHandlers: additionalMessageHandlers,
                logSubsystem: Self.logSubsystem,
                developmentOrigin: developmentOrigin
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

    /// The environment variable that points the panel at a dev server instead of the bundled build.
    ///
    /// One name, here, rather than a literal at each read: this is the only switch that changes
    /// where the panel's code comes from, and a second spelling of it would be a build that looks
    /// live and is not.
    public nonisolated static let developmentOriginVariable = "AGENTDESK_AGENT_PANEL_ORIGIN"

    /// Parses the dev-origin override, refusing anything that is not an http(s) origin.
    ///
    /// Absent means bundled, which is the only thing a Release build should ever see. A value that
    /// is set but unusable throws rather than falling back: an override that silently did nothing
    /// would present the bundled build as the edited one, and the whole reason this exists is to
    /// know which code is running.
    ///
    /// http is accepted here because this parses a MAC-side launch environment, where a hand-run
    /// server without a certificate is a reasonable thing to point at. The phone gets the same
    /// origin over the wire and applies a stricter rule -- https only -- because App Transport
    /// Security refuses cleartext to a tailnet address and no ATS exception is opened for a client
    /// that ships to a daily driver through TestFlight (ADR-0096).
    /// The dev origin this process was launched with, or nil for the bundled build.
    ///
    /// Public because the host does not only build its own panel from it: it states the same origin
    /// to every attached phone over the wire, and the phone must be told by the machine actually
    /// serving that code rather than guess (ADR-0096). One reader, so the two surfaces cannot
    /// disagree about which build is live.
    public nonisolated static func launchDevelopmentOrigin() throws -> URL? {
        try developmentOrigin(ProcessInfo.processInfo.environment[developmentOriginVariable])
    }

    nonisolated static func developmentOrigin(_ raw: String?) throws -> URL? {
        guard let raw, !raw.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        guard
            let url = URL(string: trimmed),
            let scheme = url.scheme?.lowercased(),
            scheme == "http" || scheme == "https",
            url.host != nil
        else {
            throw InitializationError.invalidDevelopmentOrigin(trimmed)
        }
        return url
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
