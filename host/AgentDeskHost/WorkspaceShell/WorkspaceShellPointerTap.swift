import AppKit
@preconcurrency import CoreFoundation
import CoreGraphics
import os

/// The real-world pointer source for the workspace shell's edge reveal (ADR-0054), ported from the
/// agent-workspace-ide donor. It is a listen-only `.cgSessionEventTap` on its own thread, not an
/// `NSEvent` global monitor: a hidden all-Spaces panel still has an owning Space, and AppKit event
/// monitors miss pointer movement on Desktops the app does not own, so the auto-hide reveal would not
/// fire after a Space switch. A session-level CGEvent tap sees pointer motion across every Space.
///
/// The tap is listen-only (never modifies or blocks events) and non-consuming. It requires Input
/// Monitoring; `start()` returns false when the tap cannot be created (grant absent), and the
/// presenter degrades to pinned bars rather than silently doing nothing.
///
/// Restartable: `start()` creates the tap and enables it on a dedicated CFRunLoop thread; `stop()`
/// tears it down. A `start()` after a `stop()` builds a fresh tap, so the same instance can be
/// cycled. All shared mutable state is guarded by `lock`.
final class WorkspaceShellPointerTap: @unchecked Sendable {
    enum EventKind: Equatable {
        case movement
        case primaryClick
        case ignored
    }

    private let lock = NSLock()
    private let onPointer: (CGPoint) -> Void
    private let onPrimaryClick: (CGPoint) -> Void
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var runLoop: CFRunLoop?
    private var thread: Thread?
    private var running = false

    /// The tap keeps the donor's movement coverage and also observes primary clicks so an active Dock
    /// interaction can cancel when the user clicks outside the all-Spaces surface.
    static let eventMask =
        CGEventMask(1) << CGEventType.mouseMoved.rawValue |
        CGEventMask(1) << CGEventType.leftMouseDown.rawValue |
        CGEventMask(1) << CGEventType.leftMouseDragged.rawValue |
        CGEventMask(1) << CGEventType.rightMouseDragged.rawValue |
        CGEventMask(1) << CGEventType.otherMouseDragged.rawValue

    static func eventKind(for type: CGEventType) -> EventKind {
        if type == .leftMouseDown { return .primaryClick }
        if type == .mouseMoved ||
            type == .leftMouseDragged ||
            type == .rightMouseDragged ||
            type == .otherMouseDragged {
            return .movement
        }
        return .ignored
    }

    /// Callbacks deliver Quartz coordinates (top-left origin, y-down). AppKit is bottom-left origin,
    /// y-up, so callers flip through the primary (menu-bar) display height.
    init(
        onPointer: @escaping (CGPoint) -> Void,
        onPrimaryClick: @escaping (CGPoint) -> Void = { _ in }
    ) {
        self.onPointer = onPointer
        self.onPrimaryClick = onPrimaryClick
    }

    deinit {
        stop()
    }

    /// Creates and enables the tap on a dedicated thread. Returns false when the tap cannot be created
    /// (Input Monitoring absent). A no-op that returns true when already running.
    @discardableResult
    func start() -> Bool {
        lock.lock()
        guard !running else {
            lock.unlock()
            return true
        }
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .tailAppendEventTap,
            options: .listenOnly,
            eventsOfInterest: WorkspaceShellPointerTap.eventMask,
            callback: WorkspaceShellPointerTap.eventTapCallback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else {
            lock.unlock()
            return false
        }
        guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
            CFMachPortInvalidate(tap)
            lock.unlock()
            return false
        }
        self.tap = tap
        self.source = source
        running = true
        // Bind this run to the exact tap/source it was created for, so a rapid stop() + start() that
        // replaces them cannot make this thread register a newer cycle's tap on its own run loop.
        let nextThread = Thread { [weak self] in self?.run(tap: tap, source: source) }
        nextThread.name = "\(Config.dispatchQueuePrefix).workspace-shell-pointer-tap"
        thread = nextThread
        lock.unlock()
        nextThread.start()
        return true
    }

    func stop() {
        lock.lock()
        guard running else {
            lock.unlock()
            return
        }
        running = false
        let currentTap = tap
        let currentRunLoop = runLoop
        lock.unlock()

        if let currentTap {
            CGEvent.tapEnable(tap: currentTap, enable: false)
            CFMachPortInvalidate(currentTap)
        }
        if let currentRunLoop {
            CFRunLoopStop(currentRunLoop)
        }
    }

    private func run(tap: CFMachPort, source: CFRunLoopSource) {
        // `self?.run(...)` from the spawning thread block holds a strong reference to self for the
        // duration of this call, so the unretained refcon in `eventTapCallback` stays valid for the
        // whole lifetime of the run loop even though the presenter may have already dropped its
        // reference and called stop() on the main thread.
        autoreleasepool {
            lock.lock()
            // Only run if this thread's own tap/source are still the current ones. A stop() (or a
            // newer start()) that raced ahead of this thread's first execution replaces them, and this
            // thread must not adopt the newer cycle's tap.
            guard running, self.tap === tap, self.source === source else {
                lock.unlock()
                return
            }
            let currentRunLoop = CFRunLoopGetCurrent()
            runLoop = currentRunLoop
            lock.unlock()

            CFRunLoopAddSource(currentRunLoop, source, .commonModes)
            CGEvent.tapEnable(tap: tap, enable: true)
            CFRunLoopRun()

            CGEvent.tapEnable(tap: tap, enable: false)
            CFRunLoopRemoveSource(currentRunLoop, source, .commonModes)

            lock.lock()
            // Only clear the slots this run owns. If a newer start() already replaced them, do not
            // stomp the new tap: compare identity.
            if self.runLoop === currentRunLoop { self.runLoop = nil }
            if self.tap === tap { self.tap = nil }
            if self.source === source { self.source = nil }
            if self.thread === Thread.current { self.thread = nil }
            lock.unlock()
        }
    }

    private func handle(type: CGEventType, event: CGEvent) {
        // macOS disables a tap that times out or is interrupted by user input; re-enable it so the
        // reveal keeps working rather than going dead after the first heavy input burst.
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            lock.lock()
            let currentTap = tap
            lock.unlock()
            if let currentTap {
                CGEvent.tapEnable(tap: currentTap, enable: true)
            }
            return
        }
        switch WorkspaceShellPointerTap.eventKind(for: type) {
        case .movement:
            onPointer(event.location)
        case .primaryClick:
            onPrimaryClick(event.location)
        case .ignored:
            break
        }
    }

    private static let eventTapCallback: CGEventTapCallBack = { _, type, event, refcon in
        guard let refcon else { return Unmanaged.passUnretained(event) }
        let pointerTap = Unmanaged<WorkspaceShellPointerTap>.fromOpaque(refcon).takeUnretainedValue()
        pointerTap.handle(type: type, event: event)
        return Unmanaged.passUnretained(event)
    }

    /// Flips a Quartz event location (top-left origin, y-down) to AppKit global coordinates
    /// (bottom-left origin, y-up) using the primary (menu-bar) display height.
    static func appKitPoint(quartz: CGPoint) -> CGPoint {
        CGPoint(x: quartz.x, y: primaryDisplayHeight() - quartz.y)
    }

    private static func primaryDisplayHeight() -> CGFloat {
        let primary = NSScreen.screens.first { $0.frame.origin == .zero } ?? NSScreen.main
        return primary?.frame.height ?? 0
    }
}
