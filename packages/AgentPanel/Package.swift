// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AgentPanel",
    platforms: [
        .macOS("26.0"),
        .iOS("26.0"),
    ],
    products: [
        .library(name: "AgentPanel", targets: ["AgentPanel"]),
    ],
    dependencies: [
        .package(path: "../WebPanelKit"),
    ],
    targets: [
        .target(
            name: "AgentPanel",
            dependencies: [
                .product(name: "WebPanelKit", package: "WebPanelKit"),
            ],
            resources: [
                .copy("Resources/AgentPanelFixture"),
                .copy("Resources/AgentPanelWebview"),
            ]
        ),
        .testTarget(name: "AgentPanelTests", dependencies: ["AgentPanel"]),
    ]
)
