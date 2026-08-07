import CoreGraphics
import Foundation

// The host-global answer to "which window, if any, is the phone watching".
//
// Separate from DisplaySelectionStore because the two are additive, not alternatives: the
// selected display keeps owning input coordinates, DesktopState, and thumbnail refresh even
// while a window is on screen. Only the capture filter moves.
//
// Read from the non-MainActor input loop on every event, so it is lock-based rather than
// MainActor-isolated. The read is the view-only gate: while a window is selected the host
// drops input rather than posting global CGEvents onto a display the viewer cannot see.
//
// Host-global and last-writer-wins, matching DisplaySelectionStore. Two clients watching one
// host already share a display selection; sharing a window selection is the same bargain.
final class CaptureTargetStore: @unchecked Sendable {
    private let lock = NSLock()
    private var window: CGWindowID?

    var selectedWindowId: CGWindowID? {
        lock.lock()
        defer { lock.unlock() }
        return window
    }

    var isWatchingWindow: Bool {
        selectedWindowId != nil
    }

    // True when the selection actually moved, so callers can restart capture and log a
    // target change without doing it on every config push.
    @discardableResult
    func select(windowId: CGWindowID?) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard window != windowId else { return false }
        window = windowId
        return true
    }
}
