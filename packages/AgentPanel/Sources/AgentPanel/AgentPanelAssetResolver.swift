import Foundation

public struct AgentPanelAssetResolver {
    public enum ResolveError: Error, Equatable {
        case notInRoot
        case notFound
        case unreadable
    }

    public struct Resolved: Equatable {
        public let data: Data
        public let mimeType: String

        public init(data: Data, mimeType: String) {
            self.data = data
            self.mimeType = mimeType
        }
    }

    public let rootDirectory: URL

    public init(rootDirectory: URL) {
        self.rootDirectory = rootDirectory
    }

    public func resolve(requestPath rawPath: String) -> Result<Resolved, ResolveError> {
        var path = rawPath
        while path.hasPrefix("/") {
            path.removeFirst()
        }
        if path.isEmpty {
            path = "index.html"
        }

        let segments = path.split(separator: "/", omittingEmptySubsequences: false)
        guard !segments.contains("..") else {
            return .failure(.notInRoot)
        }

        let canonicalRoot = rootDirectory.standardizedFileURL
        let candidate = canonicalRoot.appendingPathComponent(path).standardizedFileURL
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

    public static func mimeType(forExtension ext: String) -> String {
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
