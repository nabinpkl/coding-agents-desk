// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "PtyClientSwift",
    platforms: [.macOS(.v13), .iOS(.v15)],
    products: [
        .library(name: "PtyClientSwift", targets: ["PtyClientSwift"]),
        .library(name: "PtyTerminalSession", targets: ["PtyTerminalSession"]),
        .library(name: "PtyTerminalSwiftTerm", targets: ["PtyTerminalSwiftTerm"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-protobuf.git", from: "1.30.0"),
        .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", from: "1.13.0"),
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
            name: "PtyTerminalSwiftTerm",
            dependencies: [
                .product(name: "SwiftTerm", package: "SwiftTerm"),
            ]
        ),
        .testTarget(name: "PtyClientSwiftTests", dependencies: ["PtyClientSwift"]),
        .testTarget(
            name: "PtyTerminalSessionTests",
            dependencies: ["PtyTerminalSession", "PtyClientSwift"]
        ),
        .testTarget(
            name: "PtyTerminalSwiftTermTests",
            dependencies: ["PtyTerminalSwiftTerm", "SwiftTerm"]
        ),
    ]
)
