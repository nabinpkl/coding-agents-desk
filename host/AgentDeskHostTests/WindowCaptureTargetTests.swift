import Testing
import CoreGraphics
import AgentDeskWire

// The store the phone's window selection lands in. Its two jobs beyond holding an id are the
// cursor's clamp rect and the Desktop owed back to the user on exit.
struct WindowCaptureTargetTests {
    private func window(
        id: CGWindowID,
        spaceId: UInt64? = 7,
        bounds: CGRect = CGRect(x: 100, y: 200, width: 800, height: 600)
    ) -> WatchedWindow {
        WatchedWindow(
            id: id,
            pid: 4242,
            spaceId: spaceId,
            displayId: "d1",
            bounds: bounds,
            title: "Build log",
            appName: "Terminal"
        )
    }

    @Test func reportsOnlyRealTargetChanges() {
        let store = CaptureTargetStore()
        #expect(store.select(window(id: 41)))
        #expect(!store.select(window(id: 41)))
        #expect(store.select(window(id: 42)))
        #expect(store.select(nil))
        #expect(!store.select(nil))
    }

    // A window that moved is the same target: restarting capture would rebuild the encoder and
    // force a keyframe for nothing. But the clamp has to follow it, or the trackpad keeps
    // aiming at where the window used to be.
    @Test func aMovedWindowUpdatesTheClampWithoutRestartingCapture() {
        let store = CaptureTargetStore()
        store.select(window(id: 41, bounds: CGRect(x: 0, y: 0, width: 400, height: 300)))
        let moved = window(id: 41, bounds: CGRect(x: 900, y: 50, width: 400, height: 300))
        #expect(!store.select(moved))
        #expect(store.cursorBounds == moved.bounds)
    }

    @Test func noWatchedWindowMeansNoClampAndTheDisplayBoundsApply() {
        let store = CaptureTargetStore()
        #expect(store.cursorBounds == nil)
        store.select(window(id: 41))
        #expect(store.cursorBounds != nil)
        store.select(nil)
        #expect(store.cursorBounds == nil)
    }

    // Hopping between windows stays inside window mode, so the Desktop to return to must be
    // the one the user came from, not the one the previous window happened to sit on.
    @Test func windowToWindowHopsKeepTheOriginalDesktop() {
        let store = CaptureTargetStore()
        store.rememberDesktopIfEnteringWindowMode(spaceId: 1, displayId: "d1")
        store.rememberDesktopIfEnteringWindowMode(spaceId: 9, displayId: "d1")
        let restored = store.takeDesktopToRestore()
        #expect(restored?.spaceId == 1)
    }

    // Handed back once. A second exit must not yank the Mac away from wherever the user has
    // navigated since.
    @Test func theRememberedDesktopIsConsumedByTheFirstExit() {
        let store = CaptureTargetStore()
        store.rememberDesktopIfEnteringWindowMode(spaceId: 3, displayId: "d1")
        #expect(store.takeDesktopToRestore()?.spaceId == 3)
        #expect(store.takeDesktopToRestore() == nil)
    }

    @Test func exitingAndReenteringRemembersTheNewDesktop() {
        let store = CaptureTargetStore()
        store.rememberDesktopIfEnteringWindowMode(spaceId: 1, displayId: "d1")
        _ = store.takeDesktopToRestore()
        store.rememberDesktopIfEnteringWindowMode(spaceId: 5, displayId: "d2")
        let restored = store.takeDesktopToRestore()
        #expect(restored?.spaceId == 5)
        #expect(restored?.displayId == "d2")
    }
}
