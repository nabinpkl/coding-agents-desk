import AppKit
import os
import AgentDeskWire

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

// Session keyboard tap that turns "Hyper (remapped Caps Lock) + a character"
// into a desktop quick-switch. The tap runs on the main run loop, so its
// callback is on the main thread and can hand the character straight to the
// controller. onChar returns true when the keystroke drove a switch, in which
// case the tap swallows it; a non-matching Hyper+letter is passed through so
// other Hyper shortcuts still fire. Hyper here is Control+Option+Command held
// together (a Shift on top is fine); adjust `hyper` if your remap differs.
private final class HyperKeyCharTap {
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private let hyper: CGEventFlags = [.maskControl, .maskAlternate, .maskCommand]
    private let onChar: (Character) -> Bool
    private let log = Logger(subsystem: Config.logSubsystem, category: "spaceagent-hyper")

    init(onChar: @escaping (Character) -> Bool) {
        self.onChar = onChar
    }

    func start() {
        guard tap == nil else { return }
        let mask = CGEventMask(1 << CGEventType.keyDown.rawValue)
        let callback: CGEventTapCallBack = { _, type, event, info in
            guard let info else { return Unmanaged.passUnretained(event) }
            let tap = Unmanaged<HyperKeyCharTap>.fromOpaque(info).takeUnretainedValue()
            return tap.handle(type: type, event: event)
        }
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: mask,
            callback: callback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else {
            log.error("hyper tap: CGEvent.tapCreate returned nil (Accessibility not granted?)")
            return
        }
        log.notice("hyper tap: installed")
        self.tap = tap
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        self.source = source
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
    }

    func stop() {
        if let source {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
        }
        if let tap {
            CGEvent.tapEnable(tap: tap, enable: false)
            CFMachPortInvalidate(tap)
        }
        source = nil
        tap = nil
    }

    // Main thread (main run loop). Returns nil to swallow, the event to pass.
    private func handle(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return Unmanaged.passUnretained(event)
        }
        guard type == .keyDown else { return Unmanaged.passUnretained(event) }
        let flags = event.flags
        // Diagnostic: log any modified keypress so we can see what the remapped
        // Caps Lock actually sends and whether it matches the Hyper set.
        if flags.contains(.maskControl) || flags.contains(.maskAlternate) || flags.contains(.maskCommand) {
            let raw = NSEvent(cgEvent: event)?.charactersIgnoringModifiers ?? "?"
            log.notice("""
                hyper tap keyDown ctrl=\(flags.contains(.maskControl), privacy: .public) \
                opt=\(flags.contains(.maskAlternate), privacy: .public) \
                cmd=\(flags.contains(.maskCommand), privacy: .public) \
                shift=\(flags.contains(.maskShift), privacy: .public) \
                char=\(raw, privacy: .public) hyperMatch=\(flags.contains(self.hyper), privacy: .public)
                """)
        }
        guard flags.contains(hyper),
              let chars = NSEvent(cgEvent: event)?.charactersIgnoringModifiers,
              let character = chars.lowercased().first,
              character.isLetter || character.isNumber
        else { return Unmanaged.passUnretained(event) }
        return onChar(character) ? nil : Unmanaged.passUnretained(event)
    }
}

@MainActor
final class SpaceAgentController: NSObject {
    private enum DefaultsKey {
        // Keys are versioned so a default-placement change (right edge ->
        // top center) drops the stale parked origin instead of pinning the
        // panel to its old spot. Future drags persist under the new keys.
        static let originX = "SpaceAgent.origin.v2.x"
        static let originY = "SpaceAgent.origin.v2.y"
    }

    private let spacesProvider: SpacesProvider
    private let thumbnailProvider: SpaceThumbnailProvider
    private let commitStep: (Int) -> Void
    private let userDefaults: UserDefaults
    private let renderLogger = Logger(subsystem: Config.logSubsystem, category: "spaceagent-render")
    private let viewController = SpaceAgentViewController()
    private var panel: NSPanel?
    private var latestState: DesktopState?
    private var latestThumbnails: [UInt64: Data] = [:]
    private var thumbnailsTask: Task<Void, Never>?
    private var spaceChangeObserver: NSObjectProtocol?
    private var pendingHandleScreenOrigin: CGPoint?
    private var collapsedPanelOrigin: CGPoint?
    private var commandTapMonitors: [Any] = []
    private let commandTapDetector = DoubleTapDetector(modifier: .command)
    private var hyperTap: HyperKeyCharTap?
    private var pendingSearchQuery: String?

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
        uninstallCommandTapMonitor()
        hyperTap?.stop()
        hyperTap = nil
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
        installHyperKeyTap()
        refreshState()
        // Precompute desktop names up front so the Hyper quick-switch can match
        // them before the panel is ever opened.
        Task { await thumbnailProvider.refreshTopWindows() }
        resizePanel()
        panel.orderFrontRegardless()
        // The panel is a persistent sidebar: open it at launch and leave it
        // open. Only a rocket click (or the keyboard toggles) collapses it;
        // outside clicks do not. It stays non-key so typing goes to the user's
        // frontmost app until they click the search field.
        setExpanded(true)
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
                    // An explicit keyboard invocation: when it opens the
                    // palette, focus the search field so the user can type.
                    let willExpand = !self.viewController.isExpanded
                    self.setExpanded(willExpand, takeKeyFocus: willExpand)
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

    private func installHyperKeyTap() {
        guard hyperTap == nil else { return }
        let tap = HyperKeyCharTap(onChar: { [weak self] character in
            // The tap callback is on the main run loop, so the main actor is
            // already current here; assumeIsolated lets it ask synchronously
            // whether the character drove a switch (and thus should be eaten).
            guard let self else { return false }
            return MainActor.assumeIsolated { self.handleHyperChar(character) }
        })
        tap.start()
        hyperTap = tap
    }

    // Hyper + a character: a first-letter desktop jump. Exactly one match
    // switches to that desktop directly; several open the palette pre-typed
    // with the character; none returns false so the keystroke passes through to
    // whatever other Hyper shortcut the user has bound. Returns true when the
    // keystroke was consumed (the tap then swallows it).
    private func handleHyperChar(_ character: Character) -> Bool {
        let state = spacesProvider.current()
        latestState = state
        let tiles = SpaceAgentModel.tiles(
            state: state,
            thumbnails: latestThumbnails,
            topWindows: thumbnailProvider.latestTopWindows
        )
        let query = String(character)
        let matches = tiles.filter { $0.matchesNamePrefix(query: query) }
        let names = tiles.map(\.searchText).joined(separator: "|")
        let topCount = thumbnailProvider.latestTopWindows.count
        Logger(subsystem: Config.logSubsystem, category: "spaceagent-hyper").notice(
            "handleHyperChar '\(query, privacy: .public)' tiles=\(tiles.count, privacy: .public) topWindows=\(topCount, privacy: .public) matches=\(matches.count, privacy: .public) names=\(names, privacy: .public)"
        )
        guard !matches.isEmpty else { return false }
        if matches.count == 1 {
            if matches[0].stepDelta != 0 { commitStep(matches[0].stepDelta) }
            // Persistent sidebar: switch and stay open, returning to rest
            // instead of collapsing.
            if viewController.isExpanded { returnToRest() }
        } else if viewController.isExpanded {
            viewController.presetSearch(query)
        } else {
            pendingSearchQuery = query
            setExpanded(true, takeKeyFocus: true)
        }
        return true
    }

    private func installSpaceObserver() {
        guard spaceChangeObserver == nil else { return }
        spaceChangeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.activeSpaceDidChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.refreshState()
                // While collapsed the thumbnail demand is off, so keep the
                // desktop names current here for the Hyper quick-switch. When
                // expanded the capture loop already refreshes them.
                if !self.viewController.isExpanded {
                    await self.thumbnailProvider.refreshTopWindows()
                }
            }
        }
    }

    private func refreshState() {
        latestState = spacesProvider.current()
        render()
    }

    private func render() {
        let topWindows = thumbnailProvider.latestTopWindows
        let tiles = SpaceAgentModel.tiles(
            state: latestState,
            thumbnails: latestThumbnails,
            topWindows: topWindows
        )
        renderLogger.notice(
            "spaceagent render expanded=\(self.viewController.isExpanded, privacy: .public) tiles=\(tiles.count, privacy: .public) tileThumbnails=\(tiles.filter { $0.thumbnail != nil }.count, privacy: .public) cachedThumbnails=\(self.latestThumbnails.count, privacy: .public) topWindows=\(topWindows.count, privacy: .public) tileIds=\(tiles.map { String($0.spaceId) }.joined(separator: ","), privacy: .public) thumbnailIds=\(self.latestThumbnails.keys.map { String($0) }.sorted().joined(separator: ","), privacy: .public)"
        )
        viewController.render(tiles: tiles)
        resizePanel()
    }

    private func setExpanded(_ expanded: Bool, takeKeyFocus: Bool = false) {
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
        } else {
            thumbnailsTask?.cancel()
            thumbnailsTask = nil
            thumbnailProvider.setDemand(owner: .spaceAgent, enabled: false)
        }
        render()
        if expanded {
            // Become key (without activating the app) and focus the search
            // field so typing filters desktops immediately. A pending query
            // (from a Hyper quick-switch with several matches) pre-fills it.
            if let query = pendingSearchQuery {
                pendingSearchQuery = nil
                viewController.presetSearch(query)
            } else {
                viewController.resetSearch()
            }
            // Only take keyboard focus when the expand was an explicit
            // type-to-search gesture (Hyper + letter with several matches).
            // For the persistent sidebar and the plain toggles we stay
            // non-key so the user's frontmost app keeps the keyboard; a click
            // on the search field makes the panel key on demand.
            if takeKeyFocus {
                panel?.makeKeyAndOrderFront(nil)
                viewController.focusSearchField()
            }
        } else {
            restoreCollapsedOrigin()
            relinquishKey()
        }
    }

    // The panel stays visible (persistent sidebar), so "done interacting"
    // means: clear the search back to a clean palette and hand the keyboard
    // back to the user's frontmost app, without collapsing. Used by the search
    // Enter/Esc paths and the Hyper single-match switch. Only a rocket click
    // actually collapses to the bare handle.
    private func returnToRest() {
        guard viewController.isExpanded else { return }
        viewController.resetSearch()
        relinquishKey()
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

    private func startThumbnailTask() {
        thumbnailsTask?.cancel()
        let stream = thumbnailProvider.thumbnails
        thumbnailsTask = Task { @MainActor [weak self] in
            for await thumbnails in stream {
                guard let self else { return }
                self.latestThumbnails = thumbnails
                self.renderLogger.notice("spaceagent thumbnails received count=\(thumbnails.count, privacy: .public) ids=\(thumbnails.keys.map { String($0) }.sorted().joined(separator: ","), privacy: .public)")
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
        // Enter in the search field: switch (when not already there) and return
        // to rest. The persistent sidebar stays visible; only a rocket click
        // collapses it.
        if delta != 0 { commitStep(delta) }
        returnToRest()
    }

    func spaceAgentViewControllerDidRequestCollapse(_ controller: SpaceAgentViewController) {
        // Esc: clear the search and hand the keyboard back, but stay visible.
        returnToRest()
    }

    func spaceAgentViewControllerDidToggleRail(_ controller: SpaceAgentViewController) {
        // The column width/height changed; pin the rocket in place across the
        // resize so it does not jump, then re-lay out.
        pendingHandleScreenOrigin = viewController.handleScreenOrigin()
        resizePanel()
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
        // Top center of the primary screen. macOS coordinates are bottom-left
        // origin, so the top edge is the high-y side: park the panel just below
        // it and horizontally centered.
        return CGPoint(
            x: frame.midX - size.width / 2,
            y: frame.maxY - size.height - 24
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
