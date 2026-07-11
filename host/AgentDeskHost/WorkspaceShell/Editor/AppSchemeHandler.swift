import Foundation
import WebKit
import os

/// Serves the bundled viewer SPA over a custom `app://` scheme. We use a scheme handler rather
/// than `file://` because WKWebView blocks ES modules, `fetch`, and wasm under `file://`;
/// `app://` gives the page a real origin so the viewer's module + Shiki wasm load. Every asset
/// is read from one `root` directory (the bundled `viewer/`).
///
/// Fail loud: a request for a missing asset fails the task with an error — a blank 200 would
/// silently hide a packaging bug. Path traversal (`..`) outside `root` is rejected.
public final class AppSchemeHandler: NSObject, WKURLSchemeHandler {
    public static let scheme = "app"

    public enum Failure: Error {
        case badURL(String)
        case traversal(String)
        case notFound(String)
    }

    private let root: URL
    private let logger = Logger(subsystem: "com.example.agentdesk.AgentDeskHost", category: "viewer")

    /// `root` is the directory every `app://` path resolves under (the bundled `viewer/`).
    public init(root: URL) {
        self.root = root
    }

    public func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else {
            task.didFailWithError(Failure.badURL("nil"))
            return
        }
        // app://app/dist/viewer.js -> path "/dist/viewer.js"; index for the bare host.
        var relative = (url.path as NSString).standardizingPath
        if relative.hasPrefix("/") { relative.removeFirst() }
        if relative.isEmpty { relative = "index.html" }
        guard !relative.contains("..") else {
            task.didFailWithError(Failure.traversal(relative))
            return
        }
        let fileURL = root.appendingPathComponent(relative)
        guard let data = try? Data(contentsOf: fileURL) else {
            logger.error("app:// asset missing: \(relative, privacy: .public)")
            task.didFailWithError(Failure.notFound(relative))
            return
        }
        let response = URLResponse(
            url: url,
            mimeType: Self.mimeType(forExtension: fileURL.pathExtension.lowercased()),
            expectedContentLength: data.count,
            textEncodingName: nil
        )
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    public func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        // Reads are synchronous and complete in `start`; nothing to cancel.
    }

    private static func mimeType(forExtension ext: String) -> String {
        switch ext {
        case "html": return "text/html"
        case "css": return "text/css"
        case "js", "mjs": return "text/javascript"
        case "json": return "application/json"
        case "wasm": return "application/wasm"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "woff2": return "font/woff2"
        case "map": return "application/json"
        default: return "application/octet-stream"
        }
    }
}
