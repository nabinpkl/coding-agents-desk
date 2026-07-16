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
    nonisolated public static let scheme = "app"

    public enum Failure: Error {
        case badURL(String)
        case traversal(String)
        case notFound(String)
        case documentTooLarge
    }

    private let root: URL
    private let resourceStore: WorkspaceFileResourceStore
    private let logger = Logger(subsystem: "com.example.agentdesk.AgentDesk.editor-viewer", category: "viewer")

    /// `root` is the directory every `app://` path resolves under (the bundled `viewer/`).
    public convenience init(root: URL) {
        self.init(root: root, resourceStore: WorkspaceFileResourceStore())
    }

    init(root: URL, resourceStore: WorkspaceFileResourceStore) {
        self.root = root
        self.resourceStore = resourceStore
    }

    public func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else {
            task.didFailWithError(Failure.badURL("nil"))
            return
        }
        if url.pathComponents.count == 3, url.pathComponents[1] == "document" {
            serveDocument(token: url.pathComponents[2], url: url, task: task)
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

    private func serveDocument(token: String, url: URL, task: WKURLSchemeTask) {
        guard let resource = resourceStore.resource(for: token) else {
            task.didFailWithError(Failure.notFound("document/\(token)"))
            return
        }
        let data: Data
        do {
            switch resource {
            case .data(let value):
                data = value
            case .file(let fileURL, let maximumBytes):
                let file = try FileHandle(forReadingFrom: fileURL)
                defer { try? file.close() }
                data = try file.read(upToCount: maximumBytes + 1) ?? Data()
                guard data.count <= maximumBytes else { throw Failure.documentTooLarge }
            }
        } catch {
            logger.error("app:// document read failed: \(String(describing: error), privacy: .public)")
            task.didFailWithError(error)
            return
        }
        task.didReceive(URLResponse(
            url: url,
            mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            expectedContentLength: data.count,
            textEncodingName: nil
        ))
        task.didReceive(data)
        task.didFinish()
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
