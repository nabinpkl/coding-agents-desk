// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "WindowPlacement",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "WindowPlacement", targets: ["WindowPlacement"]),
    ],
    targets: [
        .target(name: "WindowPlacement"),
        .testTarget(name: "WindowPlacementTests", dependencies: ["WindowPlacement"]),
    ]
)
