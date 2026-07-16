// swift-tools-version: 6.0
import PackageDescription

// WorkspaceEditorViewer: the shared file web viewer (ADR-0054). The authored web project lives in
// `Viewer/`; only its runtime entry files and committed `dist/` output are package resources. Both
// the macOS shell and iOS Files surface host this one SPA, so DOCX, Markdown, notebook, and source
// rendering share one implementation while their surrounding native chrome remains platform-owned.
let package = Package(
    name: "WorkspaceEditorViewer",
    platforms: [.macOS("26.0"), .iOS("26.0")],
    products: [
        .library(name: "WorkspaceEditorViewer", targets: ["WorkspaceEditorViewer"]),
    ],
    dependencies: [
        .package(path: "../WorkspaceKit"),
    ],
    targets: [
        .target(
            name: "WorkspaceEditorViewer",
            dependencies: [
                .product(name: "WorkspaceKit", package: "WorkspaceKit"),
            ],
            resources: [
                .copy("Resources/viewer/index.html"),
                .copy("Resources/viewer/viewer.css"),
                .copy("Resources/viewer/dist"),
            ]
        ),
        .testTarget(
            name: "WorkspaceEditorViewerTests",
            dependencies: ["WorkspaceEditorViewer", "WorkspaceKit"]
        ),
    ]
)
