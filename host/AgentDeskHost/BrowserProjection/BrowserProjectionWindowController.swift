import AppKit
import BrowserProjection
import os

@MainActor
final class BrowserProjectionWindowController: NSWindowController, NSWindowDelegate {
    private let logger = Logger(subsystem: Config.logSubsystem, category: "browser-projection")
    private let projectionController = BrowserProjectionController()
    private var hasBeenShown = false
    private var isStopping = false

    var projectionViewForTesting: NSView { projectionController.view }
    var onPayloadForTesting: ((Data) -> Void)?

    override init(window: NSWindow?) {
        let projectionWindow = window ?? NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1_180, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        projectionWindow.title = "Browser Projection"
        projectionWindow.collectionBehavior = [.moveToActiveSpace, .fullScreenPrimary]
        projectionWindow.isReleasedWhenClosed = false
        projectionWindow.setAccessibilityIdentifier("browser-projection-window")
        projectionWindow.contentView = projectionController.view
        super.init(window: projectionWindow)
        projectionWindow.delegate = self
        projectionController.onLog = { [weak self] message in
            self?.logger.error("browser projection: \(message, privacy: .public)")
        }
    }

    convenience init() {
        self.init(window: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("BrowserProjectionWindowController is code-only") }

    func toggle() {
        guard let window else { return }
        if window.isVisible {
            window.orderOut(nil)
        } else {
            showWindow(nil)
            if !hasBeenShown {
                window.center()
                hasBeenShown = true
            }
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    func bindIntents(
        onSelectWindow: @escaping (Int, Int) -> Void,
        onSelectTab: @escaping (Int, Int, Int) -> Void,
        onTap: @escaping (Double, Double) -> Void,
        onScroll: @escaping (Double, Double, Double, Double) -> Void
    ) {
        projectionController.onSelectWindow = onSelectWindow
        projectionController.onSelectTab = onSelectTab
        projectionController.onTap = onTap
        projectionController.onScroll = onScroll
    }

    func receive(_ payload: Data) {
        guard let rawJSON = String(data: payload, encoding: .utf8) else { return }
        onPayloadForTesting?(payload)
        projectionController.deliver(rawJSON: rawJSON)
    }

    func stop() {
        guard !isStopping else { return }
        isStopping = true
        projectionController.teardown()
        window?.delegate = nil
        window?.close()
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }
}
