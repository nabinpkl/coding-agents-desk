import CoreGraphics
import Foundation

// Everything the host needs about the window the phone is watching, resolved once at selection
// time rather than re-derived per event.
//
// The screen rect is here because it is the cursor's clamp: while a window is watched, the
// trackpad's relative motion is bounded by the window instead of the display, so the pointer
// cannot wander off into pixels the viewer is not being shown. That read happens on every
// cursor event from the non-MainActor input loop, which is why this is lock-based rather than
// MainActor-isolated.
struct WatchedWindow: Equatable, Sendable {
    let id: CGWindowID
    let pid: pid_t
    // Where the window lives, so exiting window mode can put the Mac back on the Desktop it
    // was showing before. nil means SkyLight declined to place it.
    let spaceId: UInt64?
    let displayId: String?
    // Global screen rect in points, as CoreGraphics reports it.
    let bounds: CGRect
    // Carried for the focus path, which re-checks the live window by pid plus title-or-bounds
    // before touching it, so it refuses to act on a recycled window id.
    let title: String
    let appName: String
}

// A window the phone resized to fit its viewport, and the geometry owed back when it stops
// being the watched one. The window travels with the frame because putting it back means
// finding it again through Accessibility, which needs the pid and title, not just an id.
struct FittedWindow: Equatable, Sendable {
    let window: WatchedWindow
    let frame: CGRect
}

extension DockWindowFocusRequest {
    // The phone's picker reuses the Dock strip's focus path (ADR-0055) rather than growing a
    // second way to raise a window. An extension keeps that reuse one-directional: nothing in
    // the Dock has to know the phone exists.
    //
    // role and subrole are the ordinary-window values. The executor matches Accessibility
    // candidates against the live CGWindow it re-reads, not against these, so they are here to
    // satisfy the type rather than to be believed.
    init(watching window: WatchedWindow) {
        pid = window.pid
        appName = window.appName
        windowID = window.id
        title = window.title
        role = "AXWindow"
        subrole = "AXStandardWindow"
        isFocused = false
        isMinimized = false
        bounds = window.bounds
        spaceIDs = window.spaceId.map { [$0] } ?? []
        targetSpaceID = window.spaceId
        targetDisplayID = window.displayId
    }
}

// The host-global answer to "which window, if any, is the phone watching".
//
// Separate from DisplaySelectionStore because the two are additive, not alternatives: the
// selected display keeps owning DesktopState and thumbnail refresh even while a window is on
// screen. The capture filter and the cursor's clamp are what move.
//
// Host-global and last-writer-wins, matching DisplaySelectionStore. Two clients watching one
// host already share a display selection; sharing a window selection is the same bargain.
final class CaptureTargetStore: @unchecked Sendable {
    private let lock = NSLock()
    private var window: WatchedWindow?
    // The Desktop that was showing when window mode was entered. Selecting a window switches
    // the Mac to that window's Space, so leaving window mode owes the user their Desktop back.
    // Held across window-to-window changes: only entering and leaving window mode move it.
    private var desktopBeforeWindowMode: (spaceId: UInt64, displayId: String)?
    // Window id -> what is owed back. Keyed by window rather than holding a single value
    // because a restore can be owed for a window that is no longer the target, which is
    // exactly what happens when the user picks the next one.
    private var fittedWindows: [CGWindowID: FittedWindow] = [:]

    var watchedWindow: WatchedWindow? {
        lock.lock()
        defer { lock.unlock() }
        return window
    }

    var selectedWindowId: CGWindowID? {
        watchedWindow?.id
    }

    var isWatchingWindow: Bool {
        selectedWindowId != nil
    }

    // The rect the cursor is confined to, or nil when no window is watched and the display's
    // own bounds should apply.
    var cursorBounds: CGRect? {
        watchedWindow?.bounds
    }

    // True when the selection actually moved, so callers can restart capture and log a target
    // change without doing it on every config push.
    @discardableResult
    func select(_ next: WatchedWindow?) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard window?.id != next?.id else {
            // Same window, but its rect may have moved since. Keep the clamp honest without
            // reporting a target change that would needlessly restart capture.
            window = next
            return false
        }
        window = next
        return true
    }

    // Records where to return to, but only on the way in: a window-to-window hop inside window
    // mode must not overwrite the Desktop the user actually came from.
    func rememberDesktopIfEnteringWindowMode(spaceId: UInt64, displayId: String) {
        lock.lock()
        defer { lock.unlock() }
        guard desktopBeforeWindowMode == nil else { return }
        desktopBeforeWindowMode = (spaceId, displayId)
    }

    // Hands back the remembered Desktop exactly once, so a second exit cannot yank the Mac
    // away from wherever the user has since navigated.
    func takeDesktopToRestore() -> (spaceId: UInt64, displayId: String)? {
        lock.lock()
        defer { lock.unlock() }
        let remembered = desktopBeforeWindowMode
        desktopBeforeWindowMode = nil
        return remembered
    }

    // Records the frame a window had before the phone resized it to fit. Unlike the Desktop
    // memory above, this is per window and is owed back on every change of target, not only
    // on leaving window mode: picking a different window must put the previous one back.
    //
    // Set once per window for the same reason the Desktop memory is: a second fit of an
    // already-fitted window would otherwise overwrite the user's real geometry with the
    // fitted one and make the restore a no-op.
    func rememberFrameBeforeFit(_ frame: CGRect, window: WatchedWindow) {
        lock.lock()
        defer { lock.unlock() }
        guard fittedWindows[window.id] == nil else { return }
        fittedWindows[window.id] = FittedWindow(window: window, frame: frame)
    }

    // Every window owed a restore, handed back exactly once. Callers put them back and the
    // store forgets them, so a failed restore is not retried forever against a window whose
    // app may have quit.
    func takeFramesToRestore(excluding keep: CGWindowID? = nil) -> [CGWindowID: FittedWindow] {
        lock.lock()
        defer { lock.unlock() }
        var owed = fittedWindows
        if let keep, let kept = owed.removeValue(forKey: keep) {
            fittedWindows = [keep: kept]
        } else {
            fittedWindows = [:]
        }
        return owed
    }

    func isFitted(_ id: CGWindowID) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return fittedWindows[id] != nil
    }
}
