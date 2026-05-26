import AppKit

@MainActor
protocol SpaceAgentViewControllerDelegate: AnyObject {
    func spaceAgentViewControllerDidToggle(_ controller: SpaceAgentViewController)
    func spaceAgentViewController(_ controller: SpaceAgentViewController, didSelectStepDelta delta: Int)
}

@MainActor
final class SpaceAgentViewController: NSViewController {
    weak var delegate: SpaceAgentViewControllerDelegate?

    private let handleSize = CGSize(width: 52, height: 52)
    private let expandedHeight: CGFloat = 104
    private let tileSize = CGSize(width: 128, height: 80)
    private let tileSpacing: CGFloat = 8
    private let rootView = SpaceAgentRootView()
    private let handleView = SpaceAgentHandleView()
    private let tileScrollView = NSScrollView()
    private let tileHost = SpaceAgentTileHostView()
    private var tiles: [SpaceAgentTile] = []

    var isExpanded: Bool = false {
        didSet {
            guard oldValue != isExpanded else { return }
            applyVisibility()
        }
    }

    var preferredPanelSize: NSSize {
        if !isExpanded {
            return NSSize(width: handleSize.width, height: handleSize.height)
        }
        let tileWidth = CGFloat(max(1, tiles.count)) * tileSize.width
            + CGFloat(max(0, tiles.count - 1)) * tileSpacing
        return NSSize(
            width: min(handleSize.width + 12 + tileWidth, handleSize.width + 588),
            height: expandedHeight
        )
    }

    override func loadView() {
        view = rootView
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        configure()
        applyVisibility()
    }

    func render(tiles: [SpaceAgentTile]) {
        self.tiles = tiles
        tileHost.render(tiles: tiles)
        tileHost.onSelectDelta = { [weak self] delta in
            guard let self else { return }
            delegate?.spaceAgentViewController(self, didSelectStepDelta: delta)
        }
        rootView.needsLayout = true
        preferredContentSize = preferredPanelSize
    }

    private func configure() {
        rootView.handleView = handleView
        rootView.tileHost = tileScrollView
        rootView.handleSize = handleSize
        rootView.expandedHeight = expandedHeight
        rootView.translatesAutoresizingMaskIntoConstraints = false

        handleView.image = NSImage(named: "SpaceAgentSpaceship")
        handleView.onToggle = { [weak self] in
            guard let self else { return }
            delegate?.spaceAgentViewControllerDidToggle(self)
        }

        tileScrollView.drawsBackground = false
        tileScrollView.borderType = .noBorder
        tileScrollView.hasVerticalScroller = false
        tileScrollView.hasHorizontalScroller = true
        tileScrollView.autohidesScrollers = true
        tileScrollView.scrollerStyle = .overlay
        tileScrollView.horizontalScrollElasticity = .allowed
        tileScrollView.verticalScrollElasticity = .none
        tileScrollView.documentView = tileHost

        tileHost.tileSize = tileSize
        tileHost.tileSpacing = tileSpacing
    }

    private func applyVisibility() {
        rootView.isExpanded = isExpanded
        tileHost.isHidden = !isExpanded
        preferredContentSize = preferredPanelSize
        rootView.needsLayout = true
    }
}

private final class SpaceAgentRootView: NSView {
    var handleView: NSView? {
        didSet {
            oldValue?.removeFromSuperview()
            if let handleView { addSubview(handleView) }
        }
    }
    var tileHost: NSView? {
        didSet {
            oldValue?.removeFromSuperview()
            if let tileHost { addSubview(tileHost) }
        }
    }
    var isExpanded: Bool = false
    var handleSize = CGSize(width: 52, height: 52)
    var expandedHeight: CGFloat = 104

    override var isFlipped: Bool { true }

    override func layout() {
        super.layout()
        let handleY = max(0, (bounds.height - handleSize.height) / 2)
        handleView?.frame = CGRect(origin: CGPoint(x: 0, y: handleY), size: handleSize)
        guard isExpanded, let tileHost else { return }
        let x = handleSize.width + 12
        tileHost.frame = CGRect(
            x: x,
            y: max(0, (bounds.height - SpaceThumbnailProvider.thumbnailHeight.cgFloat) / 2),
            width: max(0, bounds.width - x),
            height: SpaceThumbnailProvider.thumbnailHeight.cgFloat + 20
        )
    }
}

private final class SpaceAgentHandleView: NSControl {
    var image: NSImage?
    var onToggle: (() -> Void)?
    private var mouseDownScreenPoint: CGPoint = .zero
    private var mouseDownWindowOrigin: CGPoint = .zero
    private var didDrag = false

    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.clear.setFill()
        dirtyRect.fill()
        let circle = bounds.insetBy(dx: 2, dy: 2)
        NSColor(calibratedWhite: 0.06, alpha: 0.72).setFill()
        NSBezierPath(roundedRect: circle, xRadius: 14, yRadius: 14).fill()
        NSColor(calibratedWhite: 1.0, alpha: 0.16).setStroke()
        let border = NSBezierPath(roundedRect: circle, xRadius: 14, yRadius: 14)
        border.lineWidth = 1
        border.stroke()

        if let image {
            image.draw(in: bounds.insetBy(dx: 7, dy: 7), from: .zero, operation: .sourceOver, fraction: 1)
        } else {
            drawFallbackShip(in: bounds.insetBy(dx: 11, dy: 9))
        }
    }

    override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        mouseDownScreenPoint = window.convertPoint(toScreen: event.locationInWindow)
        mouseDownWindowOrigin = window.frame.origin
        didDrag = false
    }

    override func mouseDragged(with event: NSEvent) {
        guard let window else { return }
        let current = window.convertPoint(toScreen: event.locationInWindow)
        let dx = current.x - mouseDownScreenPoint.x
        let dy = current.y - mouseDownScreenPoint.y
        if abs(dx) > 2 || abs(dy) > 2 {
            didDrag = true
        }
        window.setFrameOrigin(CGPoint(
            x: mouseDownWindowOrigin.x + dx,
            y: mouseDownWindowOrigin.y + dy
        ))
    }

    override func mouseUp(with event: NSEvent) {
        if !didDrag {
            onToggle?()
        }
    }

    private func drawFallbackShip(in rect: CGRect) {
        NSColor.white.setFill()
        let body = NSBezierPath(ovalIn: rect.insetBy(dx: rect.width * 0.2, dy: rect.height * 0.18))
        body.fill()
        NSColor.systemBlue.setFill()
        NSBezierPath(ovalIn: CGRect(x: rect.midX - 5, y: rect.minY + 8, width: 10, height: 7)).fill()
    }
}

private final class SpaceAgentTileHostView: NSView {
    var tileSize = CGSize(width: 128, height: 80)
    var tileSpacing: CGFloat = 8
    var onSelectDelta: ((Int) -> Void)?
    private var tileViews: [SpaceAgentTileView] = []
    private var renderedSpaceIds: [UInt64] = []
    private var renderedActiveSpaceId: UInt64?

    override var isFlipped: Bool { true }

    func render(tiles: [SpaceAgentTile]) {
        let nextSpaceIds = tiles.map(\.spaceId)
        let nextActiveSpaceId = tiles.first(where: \.isActive)?.spaceId
        let shouldScrollActiveTile = nextSpaceIds != renderedSpaceIds
            || nextActiveSpaceId != renderedActiveSpaceId
        renderedSpaceIds = nextSpaceIds
        renderedActiveSpaceId = nextActiveSpaceId

        while tileViews.count < tiles.count {
            let view = SpaceAgentTileView()
            view.onSelectDelta = { [weak self] delta in
                self?.onSelectDelta?(delta)
            }
            tileViews.append(view)
            addSubview(view)
        }
        while tileViews.count > tiles.count {
            tileViews.removeLast().removeFromSuperview()
        }
        for (idx, tile) in tiles.enumerated() {
            tileViews[idx].tile = tile
        }
        resizeDocument(for: tiles.count)
        needsLayout = true
        if shouldScrollActiveTile {
            scrollActiveTileToVisible()
        }
    }

    override func layout() {
        super.layout()
        var x: CGFloat = 0
        for view in tileViews {
            view.frame = CGRect(x: x, y: 0, width: tileSize.width, height: tileSize.height + 18)
            x += tileSize.width + tileSpacing
        }
    }

    private func resizeDocument(for tileCount: Int) {
        let width = CGFloat(tileCount) * tileSize.width
            + CGFloat(max(0, tileCount - 1)) * tileSpacing
        let height = tileSize.height + 18
        frame = CGRect(origin: .zero, size: CGSize(width: max(0, width), height: height))
    }

    private func scrollActiveTileToVisible() {
        guard let activeIndex = tileViews.firstIndex(where: { $0.tile?.isActive == true }) else { return }
        layoutSubtreeIfNeeded()
        scrollToVisible(tileViews[activeIndex].frame)
    }
}

private final class SpaceAgentTileView: NSControl {
    var tile: SpaceAgentTile? {
        didSet {
            toolTip = tile?.title
            needsDisplay = true
        }
    }
    var onSelectDelta: ((Int) -> Void)?

    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        guard let tile else { return }
        let imageRect = CGRect(x: 0, y: 0, width: bounds.width, height: 80)
        let path = NSBezierPath(roundedRect: imageRect, xRadius: 8, yRadius: 8)
        NSColor(calibratedWhite: 0.12, alpha: 0.90).setFill()
        path.fill()

        if let data = tile.thumbnail, let image = NSImage(data: data) {
            NSGraphicsContext.saveGraphicsState()
            path.addClip()
            image.draw(in: imageRect, from: .zero, operation: .sourceOver, fraction: 1)
            NSGraphicsContext.restoreGraphicsState()
        } else {
            drawPlaceholder(in: imageRect, active: tile.isActive)
        }

        let borderColor: NSColor = tile.isActive ? .controlAccentColor : NSColor(calibratedWhite: 1, alpha: 0.20)
        borderColor.setStroke()
        path.lineWidth = tile.isActive ? 2 : 1
        path.stroke()

        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 11, weight: tile.isActive ? .semibold : .regular),
            .foregroundColor: NSColor.white.withAlphaComponent(tile.isActive ? 0.98 : 0.76)
        ]
        NSString(string: tile.title).draw(
            in: CGRect(x: 4, y: 82, width: bounds.width - 8, height: 16),
            withAttributes: attrs
        )
    }

    override func mouseUp(with event: NSEvent) {
        guard let tile, !tile.isActive, tile.stepDelta != 0 else { return }
        onSelectDelta?(tile.stepDelta)
    }

    private func drawPlaceholder(in rect: CGRect, active: Bool) {
        let gradient = NSGradient(colors: [
            NSColor(calibratedRed: 0.12, green: 0.15, blue: 0.19, alpha: 1),
            NSColor(calibratedRed: 0.19, green: 0.23, blue: 0.29, alpha: 1)
        ])
        gradient?.draw(in: NSBezierPath(roundedRect: rect, xRadius: 8, yRadius: 8), angle: 90)
        NSColor.white.withAlphaComponent(active ? 0.28 : 0.18).setStroke()
        let inset = rect.insetBy(dx: 18, dy: 20)
        let line = NSBezierPath()
        line.move(to: CGPoint(x: inset.minX, y: inset.midY))
        line.line(to: CGPoint(x: inset.maxX, y: inset.midY))
        line.move(to: CGPoint(x: inset.midX, y: inset.minY))
        line.line(to: CGPoint(x: inset.midX, y: inset.maxY))
        line.lineWidth = 1
        line.stroke()
    }
}

private extension Int {
    var cgFloat: CGFloat { CGFloat(self) }
}
