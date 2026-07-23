// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "WebPanelKit",
    platforms: [
        .macOS("26.0"),
        .iOS("26.0"),
    ],
    products: [
        .library(name: "WebPanelKit", targets: ["WebPanelKit"]),
    ],
    targets: [
        .target(name: "WebPanelKit"),
        .testTarget(name: "WebPanelKitTests", dependencies: ["WebPanelKit"]),
    ]
)
