// swift-tools-version: 6.0
import PackageDescription

// WorkspaceIDE owns the shared embedded workspace presentation (ADR-0062). The authored web project
// lives in `Web/`. WorkspaceFileViewer keeps the existing single-file surfaces alive during the
// parallel rollout, while WorkspaceIDE owns the paired sidebar/editor coordinator.
let package = Package(
    name: "WorkspaceIDE",
    platforms: [.macOS("26.0"), .iOS("26.0")],
    products: [
        .library(name: "WorkspaceFileViewer", targets: ["WorkspaceFileViewer"]),
        .library(name: "WorkspaceIDE", targets: ["WorkspaceIDE"]),
    ],
    dependencies: [
        .package(path: "../AgentDeskWire"),
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
        .target(
            name: "WorkspaceIDE",
            dependencies: [
                "WorkspaceFileViewer",
                .product(name: "AgentDeskWire", package: "AgentDeskWire"),
                .product(name: "WorkspaceKit", package: "WorkspaceKit"),
            ],
            resources: [
                .copy("Resources/ide/index.html"),
                .copy("Resources/ide/assets"),
            ]
        ),
        .testTarget(
            name: "WorkspaceFileViewerTests",
            dependencies: ["WorkspaceFileViewer", "WorkspaceKit"]
        ),
        .testTarget(
            name: "WorkspaceIDETests",
            dependencies: ["WorkspaceIDE", "WorkspaceKit", "AgentDeskWire"]
        ),
    ]
)
