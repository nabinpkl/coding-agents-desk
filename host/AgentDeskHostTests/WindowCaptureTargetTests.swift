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

// The fit memory, which is per window rather than per session because a restore is owed the
// moment a window stops being the watched one, not only when window mode ends.
@Suite("Window fit memory")
struct WindowFitMemoryTests {
    private func window(id: CGWindowID) -> WatchedWindow {
        WatchedWindow(
            id: id,
            pid: 4242,
            spaceId: 7,
            displayId: "d1",
            bounds: CGRect(x: 100, y: 200, width: 800, height: 600),
            title: "Build log \(id)",
            appName: "Terminal"
        )
    }

    @Test("picking the next window owes the previous one its frame back")
    func pickingTheNextWindowOwesThePreviousOneItsFrameBack() {
        let store = CaptureTargetStore()
        let first = window(id: 1)
        let original = CGRect(x: 10, y: 20, width: 900, height: 700)
        store.rememberFrameBeforeFit(original, window: first)

        let owed = store.takeFramesToRestore(excluding: 2)
        #expect(owed.count == 1)
        #expect(owed[1]?.frame == original)
        // The window travels with the frame: putting it back means finding it through
        // Accessibility again, which needs the pid and title.
        #expect(owed[1]?.window == first)
    }

    // The window still on screen must not be handed back mid-session, or the fit the user is
    // looking at would be undone the moment anything else triggers a release.
    @Test("the window still being watched is kept")
    func theWindowStillBeingWatchedIsKept() {
        let store = CaptureTargetStore()
        store.rememberFrameBeforeFit(CGRect(x: 0, y: 0, width: 100, height: 100), window: window(id: 1))
        store.rememberFrameBeforeFit(CGRect(x: 5, y: 5, width: 200, height: 200), window: window(id: 2))

        let owed = store.takeFramesToRestore(excluding: 2)
        #expect(owed.keys.sorted() == [1])
        #expect(store.isFitted(2))
        #expect(!store.isFitted(1))
    }

    // A second fit of an already-fitted window would otherwise overwrite the user's real
    // geometry with the fitted one, making the restore a no-op that silently keeps the
    // window at the phone's size forever.
    @Test("the first frame is the one owed back, not the fitted one")
    func theFirstFrameIsTheOneOwedBackNotTheFittedOne() {
        let store = CaptureTargetStore()
        let real = CGRect(x: 10, y: 20, width: 900, height: 700)
        store.rememberFrameBeforeFit(real, window: window(id: 1))
        store.rememberFrameBeforeFit(CGRect(x: 0, y: 0, width: 603, height: 722), window: window(id: 1))

        #expect(store.takeFramesToRestore()[1]?.frame == real)
    }

    // Handed out once, so a window whose app has quit is dropped rather than retried forever.
    @Test("frames are handed back exactly once")
    func framesAreHandedBackExactlyOnce() {
        let store = CaptureTargetStore()
        store.rememberFrameBeforeFit(CGRect(x: 1, y: 2, width: 3, height: 4), window: window(id: 1))

        #expect(store.takeFramesToRestore().count == 1)
        #expect(store.takeFramesToRestore().isEmpty)
    }
}
