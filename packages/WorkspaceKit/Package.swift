// swift-tools-version: 6.0
import PackageDescription

// WorkspaceKit: the shared workspace + files data model (ADR-0054). Pure value/domain
// types (workspace identity, directory entries, file revision, contents, preview kind,
// editor/save state) reconciled with AgentDeskWire, imported by both the macOS host and
// the iOS client so the data shape has one home. It holds no navigation, no AppKit/UIKit,
// no reveal/layout: macOS renders the donor tree over it, iOS renders its drill-down list.
let package = Package(
    name: "WorkspaceKit",
    platforms: [
        .macOS("26.0"),
        .iOS("26.0"),
    ],
    products: [
        .library(name: "WorkspaceKit", targets: ["WorkspaceKit"]),
    ],
    dependencies: [
        .package(path: "../AgentDeskWire"),
    ],
    targets: [
        .target(
            name: "WorkspaceKit",
            dependencies: [
                .product(name: "AgentDeskWire", package: "AgentDeskWire"),
            ]
        ),
        .testTarget(name: "WorkspaceKitTests", dependencies: ["WorkspaceKit"]),
    ]
)
