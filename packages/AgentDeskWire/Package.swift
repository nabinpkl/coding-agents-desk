// swift-tools-version: 6.0
import PackageDescription

// AgentDeskWire: the single source of truth for the AgentDesk host<->client wire
// contract (ADR-0050). One library target, themed source files, imported by both
// the macOS host and the iOS client so a divergence on a shared type is a compile
// error rather than a test-time surprise.
let package = Package(
    name: "AgentDeskWire",
    platforms: [
        .macOS("26.0"),
        .iOS("26.0"),
    ],
    products: [
        .library(name: "AgentDeskWire", targets: ["AgentDeskWire"]),
    ],
    targets: [
        .target(name: "AgentDeskWire"),
        .testTarget(name: "AgentDeskWireTests", dependencies: ["AgentDeskWire"]),
    ]
)
