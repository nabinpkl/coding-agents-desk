import AppKit
import CoreGraphics
import os

/// The real-world pointer source for the workspace shell's edge reveal (ADR-0054), ported from the
/// agent-workspace-ide donor. It is a listen-only `.cgSessionEventTap` on its own thread, not an
/// `NSEvent` global monitor: a hidden all-Spaces panel still has an owning Space, and AppKit event
/// monitors miss pointer movement on Desktops the app does not own, so the auto-hide reveal would not
/// fire after a Space switch. A session-level CGEvent tap sees pointer motion across every Space.
///
/// The tap is listen-only (never modifies or blocks events) and non-consuming. It requires Input
/// Monitoring; `CGPreflightListenEventAccess()` gates creation, and the presenter degrades to pinned
/// bars when the grant is absent rather than silently doing nothing.
final class WorkspaceShellPointerTap {
    private let lock = NSLock()
    private let onPointer: (CGPoint) -> Void
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var runLoop: CFRunLoop?
    private var thread: Thread?
    private var shouldStop = false

    /// The events the tap listens for: pointer movement in every button state. A drag is still a
    /// move, so all three drag types are included, matching the donor.
    fileprivate static let pointerEventMask =
        CGEventMask(1) << CGEventType.mouseMoved.rawValue |
        CGEventMask(1) << CGEventType.leftMouseDragged.rawValue |
        CGEventMask(1) << CGEventType.rightMouseDragged.rawValue |
        CGEventMask(1) << CGEventType.otherMouseDragged.rawValue

    fileprivate static func isPointerMovement(_ type: CGEventType) -> Bool {
        type == .mouseMoved ||
            type == .leftMouseDragged ||
            type == .rightMouseDragged ||
            type == .otherMouseDragged
    }

    /// The pointer callback delivers Quartz coordinates (top-left origin, y-down). AppKit is
    /// bottom-left origin, y-up, so callers flip through the primary (menu-bar) display height.
    init?(onPointer: @escaping (CGPoint) -> Void) {
        self.onPointer = onPointer

        let refcon = Unmanaged.passUnretained(self).toOpaque()
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .tailAppendEventTap,
            options: .listenOnly,
            eventsOfInterest: WorkspaceShellPointerTap.pointerEventMask,
            callback: WorkspaceShellPointerTap.eventTapCallback,
            userInfo: refcon
        ) else {
            return nil
        }
        guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
            CFMachPortInvalidate(tap)
            return nil
        }
        self.tap = tap
        self.source = source
    }

    deinit {
        stop()
    }

    func start() {
        lock.lock()
        guard thread == nil, tap != nil else {
            lock.unlock()
            return
        }
        let nextThread = Thread { [weak self] in self?.run() }
        nextThread.name = "\(Config.dispatchQueuePrefix).workspace-shell-pointer-tap"
        thread = nextThread
        lock.unlock()
        nextThread.start()
    }

    func stop() {
        lock.lock()
        shouldStop = true
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

    private func run() {
        autoreleasepool {
            lock.lock()
            guard !shouldStop, let tap, let source else {
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
            runLoop = nil
            thread = nil
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
        guard WorkspaceShellPointerTap.isPointerMovement(type) else { return }
        onPointer(event.location)
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
