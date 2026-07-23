// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "InteractionPanel",
    platforms: [
        .macOS("26.0"),
        .iOS("26.0"),
    ],
    products: [
        .library(name: "InteractionPanel", targets: ["InteractionPanel"]),
    ],
    dependencies: [
        .package(path: "../WebPanelKit"),
    ],
    targets: [
        .target(
            name: "InteractionPanel",
            dependencies: [
                .product(name: "WebPanelKit", package: "WebPanelKit"),
            ],
            resources: [
                .copy("Resources/InteractionPanelFixture"),
                .copy("Resources/InteractionPanelWebview"),
            ]
        ),
        .testTarget(name: "InteractionPanelTests", dependencies: ["InteractionPanel"]),
    ]
)
