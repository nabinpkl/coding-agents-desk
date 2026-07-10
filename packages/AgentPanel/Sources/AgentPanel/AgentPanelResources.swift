import Foundation

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

    // The build output location is deliberately a package resource directory. A
    // future Vite step can populate it before the app build, and the runtime only
    // resolves Bundle resources rather than a sibling checkout or source path.
    public func rootDirectory() -> URL? {
        rootDirectory(indexPath: contract.indexPath)
    }

    public func rootDirectory(indexPath: String) -> URL? {
        if let buildOutput = directory(named: "AgentPanelWebview"),
           FileManager.default.fileExists(atPath: buildOutput.appendingPathComponent(indexPath).path) {
            return buildOutput
        }
        return directory(named: "AgentPanelFixture")
    }

    public func indexURL() -> URL? {
        rootDirectory()?.appendingPathComponent(contract.indexPath)
    }

    public func requestURL() -> URL? {
        contract.indexRequestURL
    }

    private func directory(named name: String) -> URL? {
        bundle.url(forResource: name, withExtension: nil)
    }
}
