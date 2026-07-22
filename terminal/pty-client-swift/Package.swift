// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "PtyClientSwift",
    platforms: [.macOS(.v13), .iOS(.v15)],
    products: [
        .library(name: "PtyClientSwift", targets: ["PtyClientSwift"]),
        .library(name: "PtyTerminalSession", targets: ["PtyTerminalSession"]),
        .library(name: "PtyTerminalWebView", targets: ["PtyTerminalWebView"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-protobuf.git", from: "1.30.0"),
    ],
    targets: [
        .target(
            name: "PtyClientSwift",
            dependencies: [
                .product(name: "SwiftProtobuf", package: "swift-protobuf"),
            ]
        ),
        .target(
            name: "PtyTerminalSession",
            dependencies: ["PtyClientSwift"]
        ),
        .target(
            name: "PtyTerminalWebView",
            dependencies: [
                "PtyClientSwift",
                "PtyTerminalSession",
            ],
            resources: [.process("Resources")]
        ),
        .testTarget(name: "PtyClientSwiftTests", dependencies: ["PtyClientSwift"]),
        .testTarget(
            name: "PtyTerminalSessionTests",
            dependencies: ["PtyTerminalSession", "PtyClientSwift"]
        ),
        .testTarget(
            name: "PtyTerminalWebViewTests",
            dependencies: [
                "PtyClientSwift",
                "PtyTerminalSession",
                "PtyTerminalWebView",
            ]
        ),
    ]
)
