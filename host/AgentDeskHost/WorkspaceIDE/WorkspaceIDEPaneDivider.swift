import AppKit

@MainActor
final class WorkspaceIDEPaneDivider: NSView {
    enum Axis {
        case vertical
        case horizontal
    }

    var onDrag: ((CGFloat) -> Void)?
    var onIncrement: (() -> Void)?
    var onDecrement: (() -> Void)?

    private let axis: Axis
    private var lastPoint: NSPoint?

    init(axis: Axis, identifier: String, label: String) {
        self.axis = axis
        super.init(frame: .zero)
        setAccessibilityElement(true)
        setAccessibilityRole(.splitter)
        setAccessibilityIdentifier(identifier)
        setAccessibilityLabel(label)
        setAccessibilityHelp("Drag to resize, or use the increment and decrement accessibility actions.")
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("WorkspaceIDEPaneDivider is code-only") }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: axis == .vertical ? .resizeLeftRight : .resizeUpDown)
    }

    override func mouseDown(with event: NSEvent) {
        lastPoint = convert(event.locationInWindow, from: nil)
    }

    override func mouseDragged(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        guard let lastPoint else { self.lastPoint = point; return }
        onDrag?(axis == .vertical ? point.x - lastPoint.x : point.y - lastPoint.y)
        self.lastPoint = point
    }

    override func mouseUp(with event: NSEvent) {
        lastPoint = nil
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.separatorColor.setFill()
        switch axis {
        case .vertical:
            NSRect(x: bounds.midX, y: bounds.minY, width: 1, height: bounds.height).fill()
        case .horizontal:
            NSRect(x: bounds.minX, y: bounds.midY, width: bounds.width, height: 1).fill()
        }
    }

    override func accessibilityPerformIncrement() -> Bool {
        onIncrement?()
        return true
    }

    override func accessibilityPerformDecrement() -> Bool {
        onDecrement?()
        return true
    }
}
