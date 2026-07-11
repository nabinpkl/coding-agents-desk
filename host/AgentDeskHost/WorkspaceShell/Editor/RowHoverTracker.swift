import AppKit

/// Hover-highlight logic for an `NSTableView`'s rows — and an `NSOutlineView`'s, since that
/// is an `NSTableView` subclass, so the file tree and the Source Control list share it. The
/// owning table view drives it (feeding pointer moves and owning the tracking area, because
/// the table rebuilds its own tracking areas on layout and would otherwise wipe an external
/// one). The tracker just decides which row is hovered and tints it full width.
public final class RowHoverTracker: NSObject {
    private weak var table: NSTableView?
    private var hoveredRow = -1

    public init(table: NSTableView) {
        self.table = table
        super.init()
    }

    /// Hover the row under a window-space point.
    public func hover(atWindowPoint point: NSPoint) {
        guard let table else { return }
        setHover(table.row(at: table.convert(point, from: nil)))
    }

    public func clear() { setHover(-1) }

    /// Re-evaluate hover at the current pointer — used after a tracking-area refresh or a
    /// reload, when no move event will fire but the highlight needs to reflect reality.
    /// Clears only when the pointer is genuinely outside the view, so a stray exit from one
    /// of the table's internal tracking areas doesn't drop a still-valid hover.
    public func refreshHover(in view: NSView) {
        guard let window = view.window else { clear(); return }
        let point = window.mouseLocationOutsideOfEventStream
        view.bounds.contains(view.convert(point, from: nil)) ? hover(atWindowPoint: point) : clear()
    }

    private func setHover(_ row: Int) {
        guard row != hoveredRow else { return }
        style(hoveredRow, hovered: false)
        hoveredRow = row
        style(row, hovered: true)
    }

    private func style(_ row: Int, hovered: Bool) {
        guard row >= 0, let rowView = table?.rowView(atRow: row, makeIfNecessary: false) as? HoverRowView else { return }
        rowView.isHovered = hovered
    }
}

/// A row view that paints its own full-width hover wash. Drawing it (rather than setting
/// `NSTableRowView.backgroundColor`, which the table resets on every redraw) makes the
/// highlight survive reloads/redraws and span the entire row width. Vended by the file tree
/// and Source Control list so `RowHoverTracker` only has to flip `isHovered`.
public final class HoverRowView: NSTableRowView {
    var isHovered = false {
        didSet { if isHovered != oldValue { needsDisplay = true } }
    }

    public override var isSelected: Bool {
        didSet {
            guard isSelected != oldValue else { return }
            updateSelectionAwareSubviews()
        }
    }

    public override func drawBackground(in dirtyRect: NSRect) {
        super.drawBackground(in: dirtyRect)
        guard isHovered else { return }
        HoverButton.subtleFill.setFill()
        bounds.fill()
    }

    /// Paint selection in the app accent, full width — replacing AppKit's inset blue. Keep
    /// it emphasized even when the non-activating sidebar panel isn't key (otherwise the
    /// selection would dim to grey).
    public override var isEmphasized: Bool {
        get { true }
        set {}
    }

    public override func drawSelection(in dirtyRect: NSRect) {
        guard isSelected else { return }
        AppTheme.accent.setFill()
        bounds.fill()
    }

    private func updateSelectionAwareSubviews() {
        for subview in subviews {
            (subview as? RowSelectionTinting)?.rowSelectionDidChange(isSelected: isSelected)
        }
    }
}

@MainActor
protocol RowSelectionTinting: AnyObject {
    func rowSelectionDidChange(isSelected: Bool)
}

/// A table/outline view that highlights the row under the pointer, persistently. Re-adds its
/// hover tracking area whenever the system rebuilds tracking areas (so it never silently
/// loses it), and clears only when the pointer truly leaves. The list views below adopt this
/// by assigning a `RowHoverTracker`.
protocol RowHovering: NSTableView {
    var rowHover: RowHoverTracker? { get set }
    var hoverArea: NSTrackingArea? { get set }
}

extension RowHovering {
    func ensureHoverArea() {
        if let hoverArea, trackingAreas.contains(hoverArea) { return }
        let area = NSTrackingArea(
            rect: .zero,
            options: [.mouseEnteredAndExited, .mouseMoved, .activeAlways, .inVisibleRect],
            owner: self
        )
        addTrackingArea(area)
        hoverArea = area
        rowHover?.refreshHover(in: self)
    }
}
