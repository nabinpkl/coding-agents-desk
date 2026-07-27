import Foundation

/// The shared WKWebView viewer SPA runtime (ADR-0054). Authored sources and build dependencies live
/// outside the Swift target; only `index.html`, its stylesheets, and `dist/` are bundled here.
public enum WorkspaceFileViewer {
    /// The package resource root containing `index.html`, `viewer.css`, `file-content.css`, and
    /// `dist/`. `viewer.css` is this document's own layout; `file-content.css` is the file-rendering
    /// stylesheet the IDE shares, and is the only one of the two that may be loaded elsewhere.
    public static var viewerRootURL: URL {
        guard let url = Bundle.module.resourceURL else {
            fatalError("WorkspaceFileViewer: package resource root missing")
        }
        return url
    }
}
