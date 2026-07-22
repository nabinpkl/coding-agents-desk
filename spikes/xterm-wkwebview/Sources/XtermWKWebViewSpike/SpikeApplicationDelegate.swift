import AppKit

final class SpikeApplicationDelegate: NSObject, NSApplicationDelegate {
    private let configuration: SpikeConfiguration
    private var terminalWindowController: XtermSpikeWindowController?

    init(configuration: SpikeConfiguration) {
        self.configuration = configuration
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let controller = XtermSpikeWindowController(
            configuration: configuration,
            foregroundPIDAtLaunch: NSWorkspace.shared.frontmostApplication?.processIdentifier
        )
        terminalWindowController = controller
        controller.showWithoutActivating()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        terminalWindowController?.shutdown()
        terminalWindowController = nil
    }
}
