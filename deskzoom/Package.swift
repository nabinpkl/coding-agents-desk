// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "DeskZoom",
    platforms: [.macOS(.v14)],
    targets: [
        .target(
            name: "CGVirtualDisplayPrivate",
            path: "Sources/CGVirtualDisplayPrivate"
        ),
        .executableTarget(
            name: "DeskZoom",
            dependencies: ["CGVirtualDisplayPrivate"],
            path: "Sources/DeskZoom",
            exclude: ["Info.plist"],
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("ScreenCaptureKit"),
            ]
        ),
        .testTarget(
            name: "DeskZoomTests",
            dependencies: ["DeskZoom"],
            path: "Tests/DeskZoomTests"
        ),
    ]
)
