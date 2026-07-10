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
    targets: [
        .target(
            name: "AgentPanel",
            resources: [
                .copy("Resources/AgentPanelFixture"),
                .copy("Resources/AgentPanelWebview"),
            ]
        ),
        .testTarget(name: "AgentPanelTests", dependencies: ["AgentPanel"]),
    ]
)
