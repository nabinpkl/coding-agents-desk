import AppKit

let app = NSApplication.shared
// Top-level code runs on the main thread; AppDelegate is main-actor isolated.
let delegate = MainActor.assumeIsolated {
    AppDelegate(config: DeskZoomConfig.parse(CommandLine.arguments))
}
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
