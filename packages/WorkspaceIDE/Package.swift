// swift-tools-version: 6.0
import PackageDescription

// WorkspaceFileViewer is the single-file workspace surface: one WKWebView over the `app://` scheme
// showing one file. The authored web project lives in `Web/`.
//
// The package is named for the paired sidebar/editor coordinator it used to also hold (ADR-0062).
// That is the Agent Panel's `?entry=ide` surface and the sidecar now (ADR-0115), so the name
// outlives its second target; renaming the directory would rewrite the host's project references
// for no behaviour, and is deliberately not being paid for here.
let package = Package(
    name: "WorkspaceIDE",
    platforms: [.macOS("26.0"), .iOS("26.0")],
    products: [
        .library(name: "WorkspaceFileViewer", targets: ["WorkspaceFileViewer"]),
    ],
    dependencies: [
        .package(path: "../WorkspaceKit"),
    ],
    targets: [
        .target(
            name: "WorkspaceFileViewer",
            dependencies: [
                .product(name: "WorkspaceKit", package: "WorkspaceKit"),
            ],
            resources: [
                .copy("Resources/viewer/index.html"),
                .copy("Resources/viewer/assets"),
            ]
        ),
        .testTarget(
            name: "WorkspaceFileViewerTests",
            dependencies: ["WorkspaceFileViewer", "WorkspaceKit"]
        ),
    ]
)
