import AgentDeskWire
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
    var onBatchForTesting: ((Data) -> Void)?

    override init(window: NSWindow?) {
        let projectionWindow = window ?? NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1_180, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        projectionWindow.title = "Browser Projection"
        projectionWindow.minSize = NSSize(width: 640, height: 420)
        projectionWindow.collectionBehavior = [.moveToActiveSpace, .fullScreenPrimary]
        projectionWindow.isReleasedWhenClosed = false
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

    func receive(_ payload: Data) {
        guard (try? JSONDecoder().decode(DomBatchEnvelope.self, from: payload)) != nil,
              let rawJSON = String(data: payload, encoding: .utf8) else { return }
        onBatchForTesting?(payload)
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

final class BrowserProjectionLocalLane: DomLaneSending, @unchecked Sendable {
    private struct State {
        var controller: BrowserProjectionWindowController?
        var pending: [Data] = []
        var nextIndex = 0
        var isDraining = false
    }

    private let lock: OSAllocatedUnfairLock<State>

    init(controller: BrowserProjectionWindowController) {
        lock = OSAllocatedUnfairLock(initialState: State(controller: controller))
    }

    func send(_ payload: Data) {
        let shouldStartDrain = lock.withLock { state in
            guard state.controller != nil else { return false }
            state.pending.append(payload)
            guard !state.isDraining else { return false }
            state.isDraining = true
            return true
        }
        guard shouldStartDrain else { return }
        Task { @MainActor [weak self] in self?.drain() }
    }

    func close() {
        lock.withLock { state in
            state.controller = nil
            state.pending = []
            state.nextIndex = 0
            state.isDraining = false
        }
    }

    @MainActor
    private func drain() {
        while let next = lock.withLock({ state -> (BrowserProjectionWindowController, Data)? in
            guard let controller = state.controller,
                  state.nextIndex < state.pending.count else {
                state.pending = []
                state.nextIndex = 0
                state.isDraining = false
                return nil
            }
            let payload = state.pending[state.nextIndex]
            state.nextIndex += 1
            return (controller, payload)
        }) {
            next.0.receive(next.1)
        }
    }
}
