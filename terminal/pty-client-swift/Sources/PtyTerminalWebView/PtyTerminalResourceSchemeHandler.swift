import Foundation
import WebKit

final class PtyTerminalResourceSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "agentdesk-terminal"
    static var bundledRoot: URL? {
        let index = Bundle.module.url(
            forResource: "index",
            withExtension: "html",
            subdirectory: "Web"
        ) ?? Bundle.module.url(forResource: "index", withExtension: "html")
        return index?.deletingLastPathComponent()
    }
    private let root: URL?

    init(root: URL?) { self.root = root }

    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        guard let root, let url = task.request.url else { return task.didFailWithError(URLError(.badURL)) }
        let components = url.path.split(separator: "/", omittingEmptySubsequences: false)
        guard !components.contains(where: { $0 == ".." }) else { return task.didFailWithError(URLError(.noPermissionsToReadFile)) }
        var relative = (url.path as NSString).standardizingPath
        if relative.hasPrefix("/") { relative.removeFirst() }
        if relative.isEmpty { relative = "index.html" }
        let canonicalRoot = root.standardizedFileURL.resolvingSymlinksInPath()
        let file = canonicalRoot.appendingPathComponent(relative).standardizedFileURL.resolvingSymlinksInPath()
        guard file.path.hasPrefix(canonicalRoot.path + "/"),
              let mimeType = Self.mimeType(file.pathExtension),
              let attributes = try? FileManager.default.attributesOfItem(atPath: file.path),
              let byteCount = attributes[.size] as? NSNumber,
              byteCount.intValue <= 16 * 1024 * 1024,
              let data = try? Data(contentsOf: file, options: .mappedIfSafe) else {
            return task.didFailWithError(URLError(.fileDoesNotExist))
        }
        let response = HTTPURLResponse(
            url: url, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": mimeType, "Content-Length": "\(data.count)", "Cache-Control": "no-store"]
        )!
        task.didReceive(response); task.didReceive(data); task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {}

    private static func mimeType(_ ext: String) -> String? {
        switch ext.lowercased() {
        case "html": "text/html; charset=utf-8"
        case "js": "text/javascript; charset=utf-8"
        case "css": "text/css; charset=utf-8"
        case "ttf": "font/ttf"
        case "map", "json": "application/json"
        default: nil
        }
    }
}
