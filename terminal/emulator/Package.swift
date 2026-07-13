// swift-tools-version:5.9
import PackageDescription

// TerminalEmulator: the in-app SwiftTerm terminal window (ADR-0054, Phase H / R55), moved verbatim
// from the agent-workspace-ide donor's terminal/emulator. It renders a pty-manager session in a
// titled NSWindow (SwiftTerm TerminalView + the PtyTerminalSwiftTerm bridge), driven over the local
// pty socket via pty-client-swift. The host links only this library and injects a PtyClient bound to
// AgentDesk's own socket (Config.ptyManagerSocketURL); the donor's executable + test targets are
// dropped. Kept at swift-tools 5.9 so it builds in Swift 5 language mode (no strict-concurrency port).
let package = Package(
    name: "TerminalEmulator",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "TerminalEmulator", targets: ["TerminalEmulator"]),
    ],
    dependencies: [
        .package(path: "../pty-client-swift"),
    ],
    targets: [
        .target(
            name: "TerminalEmulator",
            dependencies: [
                .product(name: "PtyClientSwift", package: "pty-client-swift"),
                .product(name: "PtyTerminalSwiftTerm", package: "pty-client-swift"),
            ],
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("Foundation"),
            ]
        ),
    ]
)
