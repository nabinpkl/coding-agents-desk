import Foundation
import WebKit

/// Serves a panel's bundled web assets over its custom scheme, backed by
/// `WebPanelAssetResolver`. No HTTP server; the WKWebView talks to the bundle.
public final class WebPanelSchemeHandler: NSObject, WKURLSchemeHandler {
    private let resolver: WebPanelAssetResolver?
    private var activeTasks = Set<ObjectIdentifier>()

    public init(rootDirectory: URL?) {
        if let rootDirectory {
            resolver = WebPanelAssetResolver(rootDirectory: rootDirectory)
        } else {
            resolver = nil
        }
        super.init()
    }

    public func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
        let key = ObjectIdentifier(urlSchemeTask)
        activeTasks.insert(key)

        guard let resolver, let url = urlSchemeTask.request.url else {
            finish(urlSchemeTask, key: key, failure: WebPanelAssetResolver.ResolveError.notFound)
            return
        }

        switch resolver.resolve(requestPath: url.path) {
        case .success(let resolved):
            guard activeTasks.contains(key) else {
                return
            }
            let response = HTTPURLResponse(
                url: url,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: [
                    "Content-Type": resolved.mimeType,
                    "Content-Length": String(resolved.data.count),
                    "Access-Control-Allow-Origin": "*",
                    "Cache-Control": "no-cache",
                ]
            )
            guard let response else {
                finish(urlSchemeTask, key: key, failure: WebPanelAssetResolver.ResolveError.unreadable)
                return
            }
            urlSchemeTask.didReceive(response)
            urlSchemeTask.didReceive(resolved.data)
            urlSchemeTask.didFinish()
            activeTasks.remove(key)
        case .failure(let error):
            finish(urlSchemeTask, key: key, failure: error)
        }
    }

    public func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {
        activeTasks.remove(ObjectIdentifier(urlSchemeTask))
    }

    private func finish(_ task: any WKURLSchemeTask, key: ObjectIdentifier, failure: Error) {
        guard activeTasks.contains(key) else {
            return
        }
        activeTasks.remove(key)
        task.didFailWithError(failure)
    }
}
