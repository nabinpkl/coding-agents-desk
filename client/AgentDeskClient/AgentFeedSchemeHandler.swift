import Foundation
import OSLog
import WebKit

// Serves the bundled AgentFeedWebview/ directory under a custom scheme
// (agentfeed://app/...). file:// gives the page a null/opaque origin, under which
// WKWebView CORS-blocks the Vite ES-module entry script and its dynamic imports,
// so the React app never mounts (blank page). A custom scheme is a real origin,
// so the module script, dynamic imports, fetch, CSS, and KaTeX fonts all load.

// MARK: - Pure asset resolution (unit-testable without a WKURLSchemeTask)

// Maps a request URL to a bundled file under a root directory, reads its bytes,
// and infers a MIME type. Denies path traversal outside the root. Pure value
// logic so tests can exercise it with a fake root directory.
struct AgentFeedAssetResolver {
    let rootDirectory: URL

    enum ResolveError: Error, Equatable {
        case notInRoot      // path traversal or escapes the bundle dir
        case notFound       // no such file under the root
        case unreadable     // file exists but could not be read
    }

    struct Resolved: Equatable {
        let data: Data
        let mimeType: String
    }

    // The path component of agentfeed://app/<path>. A request to the host root
    // (empty or "/") serves index.html.
    func resolve(requestPath rawPath: String) -> Result<Resolved, ResolveError> {
        var path = rawPath
        // Drop the leading slash so appending is relative to the root.
        while path.hasPrefix("/") { path.removeFirst() }
        if path.isEmpty { path = "index.html" }

        // Reject any traversal segment before touching the filesystem.
        let segments = path.split(separator: "/", omittingEmptySubsequences: false)
        if segments.contains("..") {
            return .failure(.notInRoot)
        }

        let canonicalRoot = rootDirectory.standardizedFileURL
        let candidate = canonicalRoot.appendingPathComponent(path).standardizedFileURL

        // Defense in depth: the resolved path must stay inside the root.
        let rootPrefix = canonicalRoot.path.hasSuffix("/")
            ? canonicalRoot.path
            : canonicalRoot.path + "/"
        guard candidate.path == canonicalRoot.path || candidate.path.hasPrefix(rootPrefix) else {
            return .failure(.notInRoot)
        }

        guard FileManager.default.fileExists(atPath: candidate.path) else {
            return .failure(.notFound)
        }
        guard let data = try? Data(contentsOf: candidate) else {
            return .failure(.unreadable)
        }
        return .success(Resolved(data: data, mimeType: Self.mimeType(forExtension: candidate.pathExtension)))
    }

    // Infers a MIME type from a file extension. Covers the asset kinds the Vite
    // bundle ships (HTML, ES-module JS, CSS, KaTeX fonts, images, JSON, maps).
    static func mimeType(forExtension ext: String) -> String {
        switch ext.lowercased() {
        case "html", "htm": return "text/html"
        case "js", "mjs": return "text/javascript"
        case "css": return "text/css"
        case "json", "map": return "application/json"
        case "woff2": return "font/woff2"
        case "woff": return "font/woff"
        case "ttf": return "font/ttf"
        case "otf": return "font/otf"
        case "eot": return "application/vnd.ms-fontobject"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "ico": return "image/x-icon"
        case "wasm": return "application/wasm"
        case "txt": return "text/plain"
        default: return "application/octet-stream"
        }
    }
}

// MARK: - WKURLSchemeHandler

final class AgentFeedSchemeHandler: NSObject, WKURLSchemeHandler {
    private let logger = Logger(subsystem: Config.logSubsystem, category: "agent-surface")
    private let resolver: AgentFeedAssetResolver?
    // Tracks in-flight tasks so a stop() after we have already finished is a no-op
    // and we never message a cancelled task.
    private var activeTasks = Set<ObjectIdentifier>()

    init(rootDirectory: URL?) {
        if let rootDirectory {
            resolver = AgentFeedAssetResolver(rootDirectory: rootDirectory)
        } else {
            resolver = nil
        }
        super.init()
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
        let key = ObjectIdentifier(urlSchemeTask)
        activeTasks.insert(key)

        guard let resolver else {
            finish(urlSchemeTask, key: key, failure: AgentFeedAssetResolver.ResolveError.notFound)
            return
        }
        guard let url = urlSchemeTask.request.url else {
            finish(urlSchemeTask, key: key, failure: AgentFeedAssetResolver.ResolveError.notFound)
            return
        }

        let path = url.path
        switch resolver.resolve(requestPath: path) {
        case .success(let resolved):
            guard activeTasks.contains(key) else { return }  // cancelled meanwhile
            let response = HTTPURLResponse(
                url: url,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: [
                    "Content-Type": resolved.mimeType,
                    "Content-Length": String(resolved.data.count),
                    // The page is a single-origin local bundle; allow same-origin use.
                    "Access-Control-Allow-Origin": "*",
                    "Cache-Control": "no-cache"
                ]
            )
            if let response {
                urlSchemeTask.didReceive(response)
                urlSchemeTask.didReceive(resolved.data)
                urlSchemeTask.didFinish()
            } else {
                finish(urlSchemeTask, key: key, failure: AgentFeedAssetResolver.ResolveError.unreadable)
            }
            activeTasks.remove(key)

        case .failure(let error):
            logger.error(
                "AgentFeedSchemeHandler: \(path, privacy: .public) -> \(String(describing: error), privacy: .public)"
            )
            finish(urlSchemeTask, key: key, failure: error)
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {
        // The page cancelled the load (e.g. navigated away). Drop the key so any
        // late completion attempt no-ops; WebKit forbids messaging a stopped task.
        activeTasks.remove(ObjectIdentifier(urlSchemeTask))
    }

    private func finish(_ task: any WKURLSchemeTask, key: ObjectIdentifier, failure: Error) {
        guard activeTasks.contains(key) else { return }
        activeTasks.remove(key)
        task.didFailWithError(failure)
    }
}
