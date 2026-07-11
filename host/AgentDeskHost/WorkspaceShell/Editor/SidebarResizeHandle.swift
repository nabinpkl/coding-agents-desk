import AppKit

/// Invisible full-height hit target over the sidebar's right edge. The visible divider
/// stays in `ShellOverlay`; this view only turns drags into proposed sidebar widths.
final class SidebarResizeHandle: NSView {
    var onBeginResize: (() -> Void)?
    var onProposeWidth: ((CGFloat) -> Void)?
    var onEndResize: (() -> Void)?
    private var trackingArea: NSTrackingArea?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setAccessibilityElement(true)
        setAccessibilityRole(.splitter)
        setAccessibilityIdentifier("sidebar-resize-handle")
        setAccessibilityLabel("Sidebar resize handle")
        setAccessibilityHelp("Drag to resize the sidebar. Use the accessibility sidebar width controls for button-driven resizing.")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("SidebarResizeHandle is code-only") }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .resizeLeftRight)
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingArea { removeTrackingArea(trackingArea) }
        let next = NSTrackingArea(
            rect: bounds,
            options: [.activeAlways, .mouseEnteredAndExited, .mouseMoved, .inVisibleRect],
            owner: self,
            userInfo: nil
        )
        trackingArea = next
        addTrackingArea(next)
    }

    override func mouseEntered(with event: NSEvent) {
        setResizeCursor()
    }

    override func mouseMoved(with event: NSEvent) {
        setResizeCursor()
    }

    override func mouseExited(with event: NSEvent) {
        NSCursor.arrow.set()
    }

    override func mouseDown(with event: NSEvent) {
        setResizeCursor()
        onBeginResize?()
        proposeWidth(from: event)
    }

    override func mouseDragged(with event: NSEvent) {
        setResizeCursor()
        proposeWidth(from: event)
    }

    override func mouseUp(with event: NSEvent) {
        setResizeCursor()
        onEndResize?()
    }

    private func proposeWidth(from event: NSEvent) {
        onProposeWidth?(event.locationInWindow.x)
    }

    private func setResizeCursor() {
        NSCursor.resizeLeftRight.set()
    }
}
