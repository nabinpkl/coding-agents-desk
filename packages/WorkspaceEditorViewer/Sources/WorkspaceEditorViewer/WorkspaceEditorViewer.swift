import Foundation

/// The vendored WKWebView editor SPA, bundled as a package `.copy` resource so the `viewer/`
/// directory structure is preserved (ADR-0054). The host's `FileViewer`/`AppSchemeHandler` serve
/// files under this root over the `app://` scheme.
public enum WorkspaceEditorViewer {
    /// The bundled `viewer/` directory (contains `index.html`, `viewer.css`, and `dist/`).
    public static var viewerRootURL: URL {
        guard let url = Bundle.module.url(forResource: "viewer", withExtension: nil) else {
            fatalError("WorkspaceEditorViewer: bundled viewer/ resource missing")
        }
        return url
    }
}
