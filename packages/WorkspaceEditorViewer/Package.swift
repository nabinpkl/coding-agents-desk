// swift-tools-version: 6.0
import PackageDescription

// WorkspaceEditorViewer: the shared file web viewer (ADR-0054, Phase G). The WKWebView SPA
// (CodeMirror + markdown-it + mermaid, vendored from the agent-workspace-ide donor, served offline
// over the app:// scheme) PLUS the cross-platform `WorkspaceFileWebSurface` that hosts it and speaks
// its `window.fileSurface` JS contract. Both the macOS shell (FileViewer window) and the iOS Files
// surface render files through this one viewer, so markdown/mermaid/code render identically on both;
// only the surrounding chrome differs. Cross-platform: the 5MB SPA now ships in the iOS client too.
let package = Package(
    name: "WorkspaceEditorViewer",
    platforms: [.macOS("26.0"), .iOS("26.0")],
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
