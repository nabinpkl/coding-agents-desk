import AppKit

/// `just check` runs on the machine someone is working on, so no test may put a
/// window in front of that work.
///
/// Most tests need no window at all: a view hosted in a window that is never
/// ordered in still lays out, still hit-tests, and still answers the
/// accessibility calls that walk the view tree.
/// `DockEnrichmentSwapInteractionTests` is the example to copy. This exists for
/// the remaining case, where production code builds and presents the window
/// itself and the test only wants its ordering state back.
extension NSWindow {
    /// Push a window that was just ordered front behind everything and stop it
    /// painting. Called in the same run-loop turn that created it, so nothing
    /// is ever composited. `isVisible` stays true, which is the ordering fact
    /// those tests assert; it cannot instead be parked outside the displays,
    /// because AppKit pulls a titled window back onto one.
    @MainActor
    func concealFromTheDesktopUnderTest() {
        alphaValue = 0
        ignoresMouseEvents = true
        orderBack(nil)
    }
}
