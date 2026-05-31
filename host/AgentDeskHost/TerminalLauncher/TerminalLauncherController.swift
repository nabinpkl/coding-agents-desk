import AppKit
import os

// Host-local terminal-launcher overlay. A borderless non-activating NSPanel
// pinned near the SpaceAgent handle, joining all Spaces. Clicking it opens the
// configured terminal app. Sibling of the SpaceAgent handle and the dictation
// bar; it stays clear of both so a press meant for one never lands on another.
@MainActor
final class TerminalLauncherController: NSObject {
    private enum DefaultsKey {
        static let originX = "TerminalLauncher.origin.x"
        static let originY = "TerminalLauncher.origin.y"
    }

    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "terminal")
    private let viewController = TerminalLauncherViewController()
    private let userDefaults: UserDefaults
    private let terminalAppURL: URL
    private let terminalBundleID: String
    // grave/backtick key. The pill synthesizes Cmd-` to toggle Ghostty's quick
    // terminal; the Ghostty config binds the non-global cmd+grave_accent so it
    // needs no Accessibility of its own (the host already holds it).
    private static let graveKeyCode: CGKeyCode = 0x32
    private let eventSource = CGEventSource(stateID: .hidSystemState)

    // Screen rects of the two sibling overlays, so this pill can stay clear of
    // both. Nil before those panels are on screen, in which case the avoid is
    // skipped.
    var spaceAgentHandleFrame: (() -> CGRect?)?
    var dictationBarFrame: (() -> CGRect?)?

    // Fired whenever this pill's screen position changes (user drag, dodge), so
    // a sibling overlay could in turn keep clear of it.
    var onFrameDidChange: (() -> Void)?

    private var panel: NSPanel?
    private var isProgrammaticMove = false

    init(
        userDefaults: UserDefaults = .standard,
        terminalAppURL: URL = Config.terminalAppURL,
        terminalBundleID: String = Config.terminalBundleID
    ) {
        self.userDefaults = userDefaults
        self.terminalAppURL = terminalAppURL
        self.terminalBundleID = terminalBundleID
        super.init()
        viewController.delegate = self
    }

    func start() {
        guard panel == nil else { return }
        let size = viewController.pillSize
        let origin = avoiding(
            origin: restoredOrigin() ?? defaultOrigin(size: size),
            size: size
        )
        let panel = NSPanel(
            contentRect: CGRect(origin: origin, size: size),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.isMovableByWindowBackground = true
        panel.contentViewController = viewController
        panel.delegate = self
        self.panel = panel
        panel.orderFrontRegardless()
    }

    func stop() {
        panel?.close()
        panel = nil
    }

    // This pill's current rect in screen coordinates, for a sibling overlay to
    // avoid. Nil before the panel is on screen.
    func currentScreenFrame() -> CGRect? {
        panel?.frame
    }

    // Re-dodge after a neighbor moves. Mirrors the dictation bar's
    // keepClearOfSpaceAgentHandle, but avoids both neighbors.
    func keepClearOfNeighbors() {
        guard let panel else { return }
        let proposed = panel.frame.origin
        let cleared = avoiding(origin: proposed, size: panel.frame.size)
        guard cleared != proposed else { return }
        withProgrammaticMove {
            panel.setFrameOrigin(cleared)
        }
        onFrameDidChange?()
    }

    // Toggle the terminal's quick window. The host already holds Accessibility,
    // so it drives the keystroke: activate the terminal app, then synthesize the
    // Cmd-` chord its (non-global) config binds to toggle_quick_terminal. A
    // second click while the quick terminal is up sends the same chord, hiding
    // it. On a cold start the app is launched first and the chord is deferred
    // until it is running and frontmost.
    private func toggleQuickTerminal() {
        if let running = runningTerminal() {
            running.activate()
            // Activation is async; give it a beat so the chord lands on the now
            // frontmost terminal rather than the previously active app.
            postChord(after: 0.06)
        } else {
            launchThenToggle()
        }
    }

    private func runningTerminal() -> NSRunningApplication? {
        NSRunningApplication
            .runningApplications(withBundleIdentifier: terminalBundleID)
            .first
    }

    private func launchThenToggle() {
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        NSWorkspace.shared.openApplication(at: terminalAppURL, configuration: config) { [weak self] app, error in
            guard let self else { return }
            if let error {
                self.logger.error("terminal launch failed: \(error.localizedDescription, privacy: .public)")
                return
            }
            // The app object is back, but the window and keybind handler need a
            // moment to come up on a cold start before the chord will register.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                app?.activate()
                self.postChord(after: 0.1)
            }
        }
    }

    private func postChord(after delay: TimeInterval) {
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.sendQuickTerminalChord()
        }
    }

    private func sendQuickTerminalChord() {
        guard let down = CGEvent(keyboardEventSource: eventSource, virtualKey: Self.graveKeyCode, keyDown: true),
              let up = CGEvent(keyboardEventSource: eventSource, virtualKey: Self.graveKeyCode, keyDown: false) else {
            logger.error("failed to build quick-terminal chord events")
            return
        }
        down.flags = .maskCommand
        up.flags = .maskCommand
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }

    // MARK: - Placement

    // Slide clear of each neighbor in turn. Two avoids in sequence: the result
    // of dodging the handle is fed into dodging the dictation bar, so the final
    // origin clears both (or the closest reachable spot when space is tight).
    private func avoiding(origin: CGPoint, size: CGSize) -> CGPoint {
        var result = origin
        let frames = visibleFrames()
        for avoid in [spaceAgentHandleFrame?(), dictationBarFrame?()].compactMap({ $0 }) {
            result = SpaceAgentPanelPlacement.nonOverlappingOrigin(
                proposed: result,
                size: size,
                avoid: avoid,
                visibleFrames: frames
            )
        }
        return result
    }

    private func withProgrammaticMove(_ body: () -> Void) {
        let previous = isProgrammaticMove
        isProgrammaticMove = true
        body()
        isProgrammaticMove = previous
    }

    // Default rest position: just right of where the SpaceAgent handle sits, or
    // bottom-centre-ish if the handle frame is not available yet. The avoiding()
    // pass in start() then pushes it fully clear of both neighbors.
    private func defaultOrigin(size: CGSize) -> CGPoint {
        let screen = NSScreen.main ?? NSScreen.screens.first
        guard let frame = screen?.visibleFrame else { return .zero }
        if let handle = spaceAgentHandleFrame?() {
            return CGPoint(x: handle.maxX + 8, y: handle.minY)
        }
        return CGPoint(x: frame.midX + size.width, y: frame.minY + 24)
    }

    private func restoredOrigin() -> CGPoint? {
        guard userDefaults.object(forKey: DefaultsKey.originX) != nil,
              userDefaults.object(forKey: DefaultsKey.originY) != nil else {
            return nil
        }
        return CGPoint(
            x: userDefaults.double(forKey: DefaultsKey.originX),
            y: userDefaults.double(forKey: DefaultsKey.originY)
        )
    }

    private func visibleFrames() -> [CGRect] {
        NSScreen.screens.map(\.visibleFrame)
    }

    private func save(origin: CGPoint) {
        userDefaults.set(origin.x, forKey: DefaultsKey.originX)
        userDefaults.set(origin.y, forKey: DefaultsKey.originY)
    }
}

extension TerminalLauncherController: TerminalLauncherViewControllerDelegate {
    func terminalLauncherDidActivate(_ controller: TerminalLauncherViewController) {
        toggleQuickTerminal()
    }
}

extension TerminalLauncherController: NSWindowDelegate {
    func windowDidMove(_ notification: Notification) {
        guard let panel else { return }
        guard !isProgrammaticMove else { return }
        save(origin: panel.frame.origin)
        onFrameDidChange?()
    }
}
