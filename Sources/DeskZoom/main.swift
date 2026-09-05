import AppKit

let config = DeskZoomConfig.parse(CommandLine.arguments)

// `--display-only` never becomes an application. It creates the display, reports it, and waits:
// the display belongs to the process, so exiting would take it away, and there is nothing to draw.
// Deliberately before NSApplication exists, so no Dock tile, menu bar or window can appear on the
// desktop it just made.
if config.listDisplays {
    runListDisplays()
}
if config.displayOnly {
    runDisplayOnly(config: config)
}

let app = NSApplication.shared
// Top-level code runs on the main thread; AppDelegate is main-actor isolated.
let delegate = MainActor.assumeIsolated { AppDelegate(config: config) }
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
