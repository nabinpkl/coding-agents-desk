import AppKit

/// `just check` runs on the machine someone is working on. A test that needs a
/// real window must therefore take neither the screen, nor the front, nor the
/// keyboard, and most tests here need no window at all: a view hosted in a
/// window that is never ordered in still lays out and still answers the
/// accessibility calls that walk the view tree (`DockEnrichmentSwapInteractionTests`
/// is the example). Reach for the two shapes below only past that point.
///
/// This one is for a test that needs the window server itself, which is what
/// vends the process accessibility tree to `AXUIElementCreateApplication`. Such
/// a window has to be ordered in, so this parks it past the edge of every
/// display and behind everything else. AppKit would normally pull a titled
/// window back to where a person could reach it, which is the whole job of
/// `constrainFrameRect` and exactly wrong here.
@MainActor
final class OffscreenTestWindow: NSWindow {
    /// Outside any plausible display arrangement, including a wall of them.
    private static let parkedOrigin = CGPoint(x: -30_000, y: -30_000)

    convenience init(hosting contentView: NSView, title: String) {
        self.init(
            contentRect: CGRect(origin: Self.parkedOrigin, size: contentView.frame.size),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        self.title = title
        self.contentView = contentView
    }

    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
        frameRect
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    /// Ordered in, because nothing is vended otherwise, but underneath every
    /// real window and nowhere near the visible desktop.
    func orderInOffscreen() {
        setFrameOrigin(Self.parkedOrigin)
        orderBack(nil)
        assert(
            NSScreen.screens.allSatisfy { !$0.frame.intersects(frame) },
            "A test window landed on a display at \(frame); AppKit constrained it back on screen."
        )
    }
}

extension NSWindow {
    /// For a window that production code built and already ordered front. It is
    /// titled, so it cannot be parked outside the displays, and the tests that
    /// need it only care about ordering state rather than about the window
    /// server. Push it behind everything and stop it painting, in the same
    /// run-loop turn that created it so nothing is ever composited.
    @MainActor
    func concealFromTheDesktopUnderTest() {
        alphaValue = 0
        ignoresMouseEvents = true
        orderBack(nil)
    }
}
