import Foundation

/// The shared WKWebView viewer SPA runtime (ADR-0054). Authored sources and build dependencies live
/// outside the Swift target; only `index.html`, `viewer.css`, and `dist/` are bundled here.
public enum WorkspaceFileViewer {
    /// The package resource root containing `index.html`, `viewer.css`, and `dist/`.
    public static var viewerRootURL: URL {
        guard let url = Bundle.module.resourceURL else {
            fatalError("WorkspaceFileViewer: package resource root missing")
        }
        return url
    }
}
