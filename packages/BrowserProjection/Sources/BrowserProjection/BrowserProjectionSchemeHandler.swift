import Foundation
import WebKit

final class BrowserProjectionSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "browserprojection"

    enum Failure: Error {
        case missingResourceRoot
        case badURL
        case traversal(String)
        case notFound(String)
        case responseCreationFailed(String)
    }

    private let root: URL?

    init(root: URL?) {
        self.root = root
    }

    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        guard let root else {
            task.didFailWithError(Failure.missingResourceRoot)
            return
        }
        guard let url = task.request.url else {
            task.didFailWithError(Failure.badURL)
            return
        }
        let rawSegments = url.path.split(separator: "/", omittingEmptySubsequences: false)
        guard !rawSegments.contains(where: { $0 == ".." }) else {
            task.didFailWithError(Failure.traversal(url.path))
            return
        }
        var relative = (url.path as NSString).standardizingPath
        if relative.hasPrefix("/") { relative.removeFirst() }
        if relative.isEmpty { relative = "index.html" }
        let canonicalRoot = root.standardizedFileURL
        let fileURL = canonicalRoot.appendingPathComponent(relative).standardizedFileURL
        guard fileURL.path.hasPrefix(canonicalRoot.path + "/") else {
            task.didFailWithError(Failure.traversal(url.path))
            return
        }
        guard let data = try? Data(contentsOf: fileURL) else {
            task.didFailWithError(Failure.notFound(relative))
            return
        }
        guard let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type": Self.mimeType(forExtension: fileURL.pathExtension),
                "Content-Length": String(data.count),
                "Cache-Control": "no-cache",
            ]
        ) else {
            task.didFailWithError(Failure.responseCreationFailed(relative))
            return
        }
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {}

    private static func mimeType(forExtension fileExtension: String) -> String {
        switch fileExtension.lowercased() {
        case "html": "text/html"
        case "js", "mjs": "text/javascript"
        case "css": "text/css"
        case "json", "map": "application/json"
        default: "application/octet-stream"
        }
    }
}
