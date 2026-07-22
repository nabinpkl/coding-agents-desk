// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "XtermWKWebViewSpike",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(path: "../../terminal/pty-client-swift"),
    ],
    targets: [
        .executableTarget(
            name: "XtermWKWebViewSpike",
            dependencies: [
                .product(name: "PtyClientSwift", package: "pty-client-swift"),
                .product(name: "PtyTerminalSession", package: "pty-client-swift"),
            ],
            resources: [.copy("Resources/Web")]
        ),
    ]
)
