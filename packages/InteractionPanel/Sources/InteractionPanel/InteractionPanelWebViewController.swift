import Foundation
import WebKit
import WebPanelKit

/// The interaction panel's typed webview controller. A thin adapter over the
/// shared `WebPanelWebViewController`: decodes the generic `(tag, body)` message
/// into an `InteractionPanelRequest` and hands it to the transport.
@MainActor
public final class InteractionPanelWebViewController: NSObject, WebPanelMessageSink {
    public static let maximumReferenceSpeechStateUTF8Bytes = 256 * 1024

    public enum InitializationError: Error, Equatable {
        case missingResourceRoot
        case invalidRequestURL
    }

    public enum DeliveryError: Error, Equatable {
        case invalidUTF8
        case payloadTooLarge
    }

    private let core: WebPanelWebViewController

    public var webView: WKWebView { core.webView }
    public weak var transport: (any InteractionPanelTransport)?

    public init(
        transport: (any InteractionPanelTransport)?,
        contract: WebPanelContract = .interaction,
        additionalUserScripts: [WKUserScript] = []
    ) throws {
        let locator = WebPanelResourceLocator(
            bundle: .module,
            webviewDirectoryName: InteractionPanelResources.webviewDirectoryName,
            fixtureDirectoryName: InteractionPanelResources.fixtureDirectoryName,
            indexPath: contract.indexPath
        )
        guard let rootDirectory = locator.rootDirectory() else {
            throw InitializationError.missingResourceRoot
        }
        do {
            core = try WebPanelWebViewController(
                contract: contract,
                resourceRootDirectory: rootDirectory,
                messageSink: nil,
                additionalUserScripts: additionalUserScripts,
                logSubsystem: "com.example.agentdesk.InteractionPanel"
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

    public func deliver(referenceSpeechState state: ReferenceSpeechState) throws {
        core.deliver(rawJSON: try Self.referenceSpeechDeliveryJSON(state))
    }

    static func referenceSpeechDeliveryJSON(_ state: ReferenceSpeechState) throws -> String {
        let data = try JSONEncoder().encode(ReferenceSpeechStateDelivery(payload: state))
        guard data.count <= maximumReferenceSpeechStateUTF8Bytes else {
            throw DeliveryError.payloadTooLarge
        }
        guard let delivery = String(data: data, encoding: .utf8) else {
            throw DeliveryError.invalidUTF8
        }
        return delivery
    }

    public func resumeAfterSessionReconnect() {
        core.resumeAfterSessionReconnect()
    }

    public func teardown() {
        core.teardown()
    }

    // MARK: WebPanelMessageSink

    public func webPanel(didReceiveTag tag: String, body: [String: Any]) {
        guard let request = InteractionPanelRequest.decode(tag: tag, body: body) else {
            return
        }
        transport?.sendInteractionRequest(request)
    }
}

private struct ReferenceSpeechStateDelivery: Encodable {
    let type = "referenceSpeechState"
    let payload: ReferenceSpeechState
}
