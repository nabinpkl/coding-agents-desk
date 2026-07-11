// swift-tools-version: 6.0
import PackageDescription

// WorkspaceEditorViewer: the macOS workspace editor's WKWebView SPA (CodeMirror + markdown-it +
// mermaid), vendored from the agent-workspace-ide donor and served offline over the app:// scheme
// (ADR-0054). macOS-only so the 5MB viewer bundle never ships in the iOS client. A `.copy` resource
// preserves the viewer/ directory structure (the host's buildable folder flattens subdirectories);
// FileViewer resolves `WorkspaceEditorViewer.viewerRootURL` from Bundle.module.
let package = Package(
    name: "WorkspaceEditorViewer",
    platforms: [.macOS("26.0")],
    products: [
        .library(name: "WorkspaceEditorViewer", targets: ["WorkspaceEditorViewer"]),
    ],
    targets: [
        .target(
            name: "WorkspaceEditorViewer",
            resources: [.copy("Resources/viewer")]
        ),
    ]
)
