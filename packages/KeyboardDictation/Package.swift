// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "KeyboardDictation",
    products: [
        .library(name: "KeyboardDictation", targets: ["KeyboardDictation"])
    ],
    targets: [
        .target(name: "KeyboardDictation"),
        .testTarget(
            name: "KeyboardDictationTests",
            dependencies: ["KeyboardDictation"]
        )
    ]
)
