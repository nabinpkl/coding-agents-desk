// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "BrowserProjection",
    platforms: [.macOS("26.0"), .iOS("26.0")],
    products: [
        .library(name: "BrowserProjection", targets: ["BrowserProjection"]),
    ],
    targets: [
        .target(
            name: "BrowserProjection",
            resources: [.copy("Resources/BrowserProjectionWebview")]
        ),
        .testTarget(name: "BrowserProjectionTests", dependencies: ["BrowserProjection"]),
    ]
)
