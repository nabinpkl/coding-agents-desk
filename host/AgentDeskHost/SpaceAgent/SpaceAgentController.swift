import AppKit

// Non-activating floating panel that can still take key focus while the
// desktop search palette is open, so its NSSearchField receives typing. The
// app is never activated (nonactivatingPanel), so the menu bar stays with the
// user's frontmost app; key returns to that app on collapse.
private final class SpaceAgentPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

// Detects a clean double-tap of a modifier key: two press/release cycles of
// the modifier alone, within `window`, with no other key pressed in between.
// Binds double-Command to the desktop palette. The "clean" rule is what keeps
// Cmd+key combos (a key pressed while Command is held) from reading as a
// Command tap. Plain class, only touched from the main thread via the monitors.
private final class DoubleTapDetector {
    private let modifier: NSEvent.ModifierFlags
    private let window: TimeInterval
    private var isDown = false
    private var holdClean = false
    private var lastCleanReleaseAt: TimeInterval = -.greatestFiniteMagnitude

    init(modifier: NSEvent.ModifierFlags = .control, window: TimeInterval = 0.4) {
        self.modifier = modifier
        self.window = window
    }

    // Returns true exactly once, on the release that completes a double-tap.
    func handle(_ event: NSEvent) -> Bool {
        switch event.type {
        case .keyDown:
            // Any key press dirties the current hold and breaks the chain.
            holdClean = false
            lastCleanReleaseAt = -.greatestFiniteMagnitude
            return false
        case .flagsChanged:
            let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            let down = flags.contains(modifier)
            let modifierOnly = flags.subtracting(modifier).isEmpty
            if down && !isDown {
                isDown = true
                holdClean = modifierOnly
                return false
            }
            if !down && isDown {
                isDown = false
                guard holdClean else {
                    lastCleanReleaseAt = -.greatestFiniteMagnitude
                    return false
                }
                if event.timestamp - lastCleanReleaseAt <= window {
                    lastCleanReleaseAt = -.greatestFiniteMagnitude
                    return true
                }
                lastCleanReleaseAt = event.timestamp
                return false
            }
            if down {
                // Another modifier joined while held: no longer a clean tap.
                if !modifierOnly { holdClean = false }
            } else if !flags.isEmpty {
                // A different modifier toggled between taps: break the chain.
                lastCleanReleaseAt = -.greatestFiniteMagnitude
            }
            return false
        default:
            return false
        }
    }
}

@MainActor
final class SpaceAgentController: NSObject {
    private enum DefaultsKey {
        static let originX = "SpaceAgent.origin.x"
        static let originY = "SpaceAgent.origin.y"
    }

    private let spacesProvider: SpacesProvider
    private let thumbnailProvider: SpaceThumbnailProvider
    private let commitStep: (Int) -> Void
    private let userDefaults: UserDefaults
    private let viewController = SpaceAgentViewController()
    private var panel: NSPanel?
    private var latestState: DesktopState?
    private var latestThumbnails: [UInt64: Data] = [:]
    private var thumbnailsTask: Task<Void, Never>?
    private var spaceChangeObserver: NSObjectProtocol?
    private var pendingHandleScreenOrigin: CGPoint?
    private var collapsedPanelOrigin: CGPoint?
    private var outsideClickMonitor: Any?
    private var commandTapMonitors: [Any] = []
    private let commandTapDetector = DoubleTapDetector(modifier: .command)

    // Fired whenever the handle's screen position changes (user drag, expand
    // or collapse resize) so a sibling overlay can keep clear of it.
    var onHandleFrameDidChange: (() -> Void)?

    init(
        spacesProvider: SpacesProvider,
        thumbnailProvider: SpaceThumbnailProvider,
        userDefaults: UserDefaults = .standard,
        commitStep: @escaping (Int) -> Void
    ) {
        self.spacesProvider = spacesProvider
        self.thumbnailProvider = thumbnailProvider
        self.userDefaults = userDefaults
        self.commitStep = commitStep
        super.init()
        viewController.delegate = self
    }

    // The handle's current rect in screen coordinates, for a sibling overlay
    // to avoid. Nil before the panel is on screen.
    func currentHandleScreenFrame() -> CGRect? {
        viewController.handleScreenFrame()
    }

    func stop() {
        thumbnailsTask?.cancel()
        thumbnailsTask = nil
        if let spaceChangeObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(spaceChangeObserver)
            self.spaceChangeObserver = nil
        }
        uninstallOutsideClickMonitor()
        uninstallCommandTapMonitor()
        thumbnailProvider.setDemand(owner: .spaceAgent, enabled: false)
        panel?.close()
        panel = nil
    }

    func start() {
        guard panel == nil else { return }
        let size = viewController.preferredPanelSize
        let origin = restoredOrigin(size: size) ?? SpaceAgentPanelPlacement.defaultOrigin(
            size: size,
            visibleFrames: visibleFrames()
        )
        let panel = SpaceAgentPanel(
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
        panel.contentViewController = viewController
        panel.delegate = self
        self.panel = panel

        installSpaceObserver()
        installCommandTapMonitor()
        refreshState()
        resizePanel()
        panel.orderFrontRegardless()
    }

    // Double-tap Command, from anywhere, toggles the palette. A global monitor
    // catches the taps while another app is frontmost (the common open case);
    // a local monitor catches them while our panel is key (so it also closes).
    // Both feed one detector; events are non-consuming so other Command
    // shortcuts are unaffected.
    private func installCommandTapMonitor() {
        guard commandTapMonitors.isEmpty else { return }
        let process: (NSEvent) -> Void = { [weak self] event in
            Task { @MainActor in
                guard let self else { return }
                if self.commandTapDetector.handle(event) {
                    self.setExpanded(!self.viewController.isExpanded)
                }
            }
        }
        if let global = NSEvent.addGlobalMonitorForEvents(
            matching: [.flagsChanged, .keyDown],
            handler: process
        ) {
            commandTapMonitors.append(global)
        }
        if let local = NSEvent.addLocalMonitorForEvents(
            matching: [.flagsChanged, .keyDown]
        ) { event in
            process(event)
            return event
        } {
            commandTapMonitors.append(local)
        }
    }

    private func uninstallCommandTapMonitor() {
        for monitor in commandTapMonitors {
            NSEvent.removeMonitor(monitor)
        }
        commandTapMonitors.removeAll()
    }

    private func installSpaceObserver() {
        guard spaceChangeObserver == nil else { return }
        spaceChangeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.activeSpaceDidChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.refreshState()
            }
        }
    }

    private func refreshState() {
        latestState = spacesProvider.current()
        render()
    }

    private func render() {
        viewController.render(tiles: SpaceAgentModel.tiles(
            state: latestState,
            thumbnails: latestThumbnails,
            topWindows: thumbnailProvider.latestTopWindows
        ))
        resizePanel()
    }

    private func setExpanded(_ expanded: Bool) {
        guard viewController.isExpanded != expanded else { return }
        if expanded {
            // Save the spaceship's resting (collapsed) panel origin so
            // we can return to it on collapse. The expand-time clamp
            // can shift the panel toward the screen interior to fit
            // the popover; without this restore, the spaceship would
            // stay at that shifted position after collapse instead of
            // returning to the user's parked corner.
            collapsedPanelOrigin = panel?.frame.origin
            pendingHandleScreenOrigin = viewController.handleScreenOrigin()
        } else {
            // On collapse we do not pin the handle to its current
            // (mid-screen) position; we restore the parked corner
            // origin we saved at expand time.
            pendingHandleScreenOrigin = nil
        }
        viewController.isExpanded = expanded
        if expanded {
            latestState = spacesProvider.current()
            thumbnailProvider.setDemand(owner: .spaceAgent, enabled: true)
            startThumbnailTask()
            installOutsideClickMonitor()
        } else {
            thumbnailsTask?.cancel()
            thumbnailsTask = nil
            thumbnailProvider.setDemand(owner: .spaceAgent, enabled: false)
            uninstallOutsideClickMonitor()
        }
        render()
        if expanded {
            // Become key (without activating the app) and focus the search
            // field so typing filters desktops immediately.
            viewController.resetSearch()
            panel?.makeKeyAndOrderFront(nil)
            viewController.focusSearchField()
        } else {
            restoreCollapsedOrigin()
            relinquishKey()
        }
    }

    // Returning keyboard focus to the app that was active before the palette
    // opened: ordering the key panel out lets the window server promote that
    // app's window, then we re-show the collapsed handle without taking key
    // again. Skipped when the panel is no longer key (e.g. an outside click
    // already moved key to another app), which avoids a needless flicker.
    private func relinquishKey() {
        guard let panel, panel.isKeyWindow else { return }
        panel.makeFirstResponder(nil)
        panel.orderOut(nil)
        panel.orderFrontRegardless()
    }

    private func restoreCollapsedOrigin() {
        guard let panel, let saved = collapsedPanelOrigin else { return }
        collapsedPanelOrigin = nil
        let size = viewController.preferredPanelSize
        let clamped = SpaceAgentPanelPlacement.clampedOrigin(
            proposed: saved,
            size: size,
            visibleFrames: visibleFrames()
        )
        guard clamped != panel.frame.origin else { return }
        panel.setFrame(CGRect(origin: clamped, size: size), display: true)
        save(origin: clamped)
    }

    // Global monitors only fire for events outside the receiving process,
    // so any click this picks up while the popover is expanded is by
    // definition outside our panel. That makes it the right hook for a
    // "tap-outside-to-dismiss" affordance without having to compute hit
    // rects against the panel's frame ourselves.
    private func installOutsideClickMonitor() {
        guard outsideClickMonitor == nil else { return }
        outsideClickMonitor = NSEvent.addGlobalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]
        ) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.viewController.isExpanded else { return }
                self.setExpanded(false)
            }
        }
    }

    private func uninstallOutsideClickMonitor() {
        guard let monitor = outsideClickMonitor else { return }
        NSEvent.removeMonitor(monitor)
        outsideClickMonitor = nil
    }

    private func startThumbnailTask() {
        thumbnailsTask?.cancel()
        let stream = thumbnailProvider.thumbnails
        thumbnailsTask = Task { @MainActor [weak self] in
            for await thumbnails in stream {
                guard let self else { return }
                self.latestThumbnails = thumbnails
                self.render()
            }
        }
    }

    private func resizePanel() {
        guard let panel else { return }
        let size = viewController.preferredPanelSize
        let origin = resizedPanelOrigin(
            panel: panel,
            size: size,
            pinnedHandleScreenOrigin: pendingHandleScreenOrigin
        )
        pendingHandleScreenOrigin = nil
        panel.setFrame(CGRect(origin: origin, size: size), display: true)
        save(origin: origin)
        onHandleFrameDidChange?()
    }

    private func resizedPanelOrigin(
        panel: NSPanel,
        size: CGSize,
        pinnedHandleScreenOrigin: CGPoint?
    ) -> CGPoint {
        let visibleFrames = visibleFrames()
        guard let pinnedHandleScreenOrigin else {
            return SpaceAgentPanelPlacement.clampedOrigin(
                proposed: panel.frame.origin,
                size: size,
                visibleFrames: visibleFrames
            )
        }

        let originalOrigin = panel.frame.origin
        panel.setFrame(CGRect(origin: originalOrigin, size: size), display: false)
        viewController.view.layoutSubtreeIfNeeded()
        guard let resizedHandleScreenOrigin = viewController.handleScreenOrigin() else {
            return SpaceAgentPanelPlacement.clampedOrigin(
                proposed: originalOrigin,
                size: size,
                visibleFrames: visibleFrames
            )
        }
        let correctedOrigin = CGPoint(
            x: originalOrigin.x + pinnedHandleScreenOrigin.x - resizedHandleScreenOrigin.x,
            y: originalOrigin.y + pinnedHandleScreenOrigin.y - resizedHandleScreenOrigin.y
        )
        return SpaceAgentPanelPlacement.clampedOrigin(
            proposed: correctedOrigin,
            size: size,
            visibleFrames: visibleFrames
        )
    }

    private func restoredOrigin(size: CGSize) -> CGPoint? {
        guard userDefaults.object(forKey: DefaultsKey.originX) != nil,
              userDefaults.object(forKey: DefaultsKey.originY) != nil
        else { return nil }
        return SpaceAgentPanelPlacement.clampedOrigin(
            proposed: CGPoint(
                x: userDefaults.double(forKey: DefaultsKey.originX),
                y: userDefaults.double(forKey: DefaultsKey.originY)
            ),
            size: size,
            visibleFrames: visibleFrames()
        )
    }

    private func save(origin: CGPoint) {
        userDefaults.set(Double(origin.x), forKey: DefaultsKey.originX)
        userDefaults.set(Double(origin.y), forKey: DefaultsKey.originY)
    }

    private func visibleFrames() -> [CGRect] {
        NSScreen.screens.map(\.visibleFrame)
    }
}

extension SpaceAgentController: SpaceAgentViewControllerDelegate {
    func spaceAgentViewControllerDidToggle(_ controller: SpaceAgentViewController) {
        setExpanded(!controller.isExpanded)
    }

    func spaceAgentViewController(_ controller: SpaceAgentViewController, didSelectStepDelta delta: Int) {
        guard delta != 0 else { return }
        commitStep(delta)
        controller.isExpanded = true
    }

    func spaceAgentViewController(_ controller: SpaceAgentViewController, didOpenStepDelta delta: Int) {
        guard delta != 0 else { setExpanded(false); return }
        commitStep(delta)
        setExpanded(false)
    }

    func spaceAgentViewControllerDidRequestCollapse(_ controller: SpaceAgentViewController) {
        setExpanded(false)
    }
}

extension SpaceAgentController: NSWindowDelegate {
    func windowDidMove(_ notification: Notification) {
        guard let panel else { return }
        save(origin: panel.frame.origin)
        onHandleFrameDidChange?()
    }
}

enum SpaceAgentPanelPlacement {
    static func defaultOrigin(size: CGSize, visibleFrames: [CGRect]) -> CGPoint {
        let frame = visibleFrames.first ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        return CGPoint(
            x: frame.maxX - size.width - 24,
            y: frame.minY + 96
        )
    }

    static func clampedOrigin(
        proposed: CGPoint,
        size: CGSize,
        visibleFrames: [CGRect]
    ) -> CGPoint {
        let candidate = CGRect(origin: proposed, size: size)
        let frame = bestFrame(for: candidate, visibleFrames: visibleFrames)
            ?? CGRect(x: 0, y: 0, width: max(size.width, 1), height: max(size.height, 1))
        let maxX = max(frame.minX, frame.maxX - size.width)
        let maxY = max(frame.minY, frame.maxY - size.height)
        return CGPoint(
            x: min(max(proposed.x, frame.minX), maxX),
            y: min(max(proposed.y, frame.minY), maxY)
        )
    }

    // Slides a panel of `size` placed at `proposed` clear of `avoid`, picking
    // the nearest of four axis-aligned positions that clears it (with a small
    // gap), each clamped back into the visible frames. Returns `proposed`
    // unchanged when it already clears `avoid`. Used to keep the dictation bar
    // out from under the SpaceAgent handle: the two are sibling floating
    // panels, and where they overlap the front one swallows the press, so a
    // grab at the spaceship would otherwise land on the bar's mic button.
    static func nonOverlappingOrigin(
        proposed: CGPoint,
        size: CGSize,
        avoid: CGRect,
        visibleFrames: [CGRect]
    ) -> CGPoint {
        let gap: CGFloat = 8
        guard CGRect(origin: proposed, size: size).intersects(avoid) else { return proposed }
        let candidates = [
            CGPoint(x: avoid.maxX + gap, y: proposed.y),
            CGPoint(x: avoid.minX - size.width - gap, y: proposed.y),
            CGPoint(x: proposed.x, y: avoid.maxY + gap),
            CGPoint(x: proposed.x, y: avoid.minY - size.height - gap)
        ].map { clampedOrigin(proposed: $0, size: size, visibleFrames: visibleFrames) }
        // Prefer candidates that still clear `avoid` after the visible-frame
        // clamp; fall back to the clamped set if none do (handle larger than
        // the free space). Pick whichever moves the bar the least.
        let cleared = candidates.filter { !CGRect(origin: $0, size: size).intersects(avoid) }
        let pool = cleared.isEmpty ? candidates : cleared
        return pool.min {
            hypot($0.x - proposed.x, $0.y - proposed.y)
                < hypot($1.x - proposed.x, $1.y - proposed.y)
        } ?? proposed
    }

    private static func bestFrame(for candidate: CGRect, visibleFrames: [CGRect]) -> CGRect? {
        visibleFrames.max { lhs, rhs in
            lhs.intersection(candidate).area < rhs.intersection(candidate).area
        }
    }
}

private extension CGRect {
    var area: CGFloat {
        guard !isNull, !isEmpty else { return 0 }
        return width * height
    }
}
