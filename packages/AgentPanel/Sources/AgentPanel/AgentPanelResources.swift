import Foundation
import WebPanelKit

public struct AgentPanelJavaScriptContract: Equatable, Sendable {
    public static let agentFeed = AgentPanelJavaScriptContract()

    public let scheme: String
    public let host: String
    public let indexPath: String
    public let messageHandlerName: String
    public let deliveryFunctionName: String

    public init(
        scheme: String = "agentfeed",
        host: String = "app",
        indexPath: String = "index.html",
        messageHandlerName: String = "agentFeed",
        deliveryFunctionName: String = "__agentFeedDeliver"
    ) {
        self.scheme = scheme
        self.host = host
        self.indexPath = indexPath
        self.messageHandlerName = messageHandlerName
        self.deliveryFunctionName = deliveryFunctionName
    }

    public var indexRequestURL: URL? {
        URL(string: "\(scheme)://\(host)/\(indexPath)")
    }

    /// The generic contract WebPanelKit's controller consumes. AgentPanel's
    /// bridge global is always `__agentFeedBridge`.
    public var webPanelContract: WebPanelContract {
        WebPanelContract(
            scheme: scheme,
            host: host,
            indexPath: indexPath,
            messageHandlerName: messageHandlerName,
            deliveryFunctionName: deliveryFunctionName,
            bridgeGlobalName: "__agentFeedBridge"
        )
    }
}

/// Which of the two bundled resource trees the panel resolved. The distinction is load-bearing:
/// `AgentPanelWebview` is the Vite build output (gitignored, produced by `just build-agent-webview`),
/// while `AgentPanelFixture` is a checked-in stub whose only job is to let the package compile and
/// declare valid resources on a clean checkout. The fixture renders the literal text
/// "AgentPanel fixture" and stubs `__agentFeedDeliver` to a no-op, so serving it to a user is an
/// inert blank panel that swallows every host push. It must never reach a real surface, which is why
/// resolution reports the kind instead of returning an anonymous URL.
public enum AgentPanelResourceRoot: Equatable, Sendable {
    case builtWebview(URL)
    case fixture(URL)

    public var url: URL {
        switch self {
        case .builtWebview(let url), .fixture(let url):
            return url
        }
    }

    public var isFixture: Bool {
        if case .fixture = self { return true }
        return false
    }
}

public struct AgentPanelResourceLocator {
    public let bundle: Bundle
    public let contract: AgentPanelJavaScriptContract

    public init(contract: AgentPanelJavaScriptContract = .agentFeed) {
        self.init(bundle: .module, contract: contract)
    }

    public init(bundle: Bundle, contract: AgentPanelJavaScriptContract = .agentFeed) {
        self.bundle = bundle
        self.contract = contract
    }

    // The build output location is deliberately a package resource directory: the Vite step
    // populates it before the app build, and the runtime only resolves Bundle resources rather than
    // a sibling checkout or source path.
    public func resolve() -> AgentPanelResourceRoot? {
        resolve(indexPath: contract.indexPath)
    }

    /// Both candidates are checked for the index file itself, not just directory existence. A
    /// directory that exists but carries no index would otherwise hand the scheme handler a root it
    /// can never serve.
    public func resolve(indexPath: String) -> AgentPanelResourceRoot? {
        if let buildOutput = directory(named: "AgentPanelWebview"),
           FileManager.default.fileExists(atPath: buildOutput.appendingPathComponent(indexPath).path) {
            return .builtWebview(buildOutput)
        }
        if let fixture = directory(named: "AgentPanelFixture"),
           FileManager.default.fileExists(atPath: fixture.appendingPathComponent(indexPath).path) {
            return .fixture(fixture)
        }
        return nil
    }

    public func indexURL() -> URL? {
        resolve()?.url.appendingPathComponent(contract.indexPath)
    }

    public func requestURL() -> URL? {
        contract.indexRequestURL
    }

    private func directory(named name: String) -> URL? {
        bundle.url(forResource: name, withExtension: nil)
    }
}
