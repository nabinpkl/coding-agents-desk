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
    private let tileSize = CGSize(width: 140, height: 84)
    private let tileSpacing: CGFloat = 10
    private let stripInset: CGFloat = 10
    private let tileStripHeight: CGFloat = 164
    private let tailHeight: CGFloat = 0
    private let popoverToAnchorGap: CGFloat = 6
    private let popoverScreenMargin: CGFloat = 0
    private let rootView = SpaceAgentRootView()
    private let handleView = SpaceAgentHandleView()
    private let tileBackdrop = SpaceAgentTileBackdropView()
    private let tileScrollView = NSScrollView()
    private let tileHost = SpaceAgentTileHostView()
    private var tiles: [SpaceAgentTile] = []

    /// Hard cap on the popover's outer width. Set to a positive value to
    /// override the screen-derived default (used by tests).
    var popoverMaxWidth: CGFloat = 0 {
        didSet { preferredContentSize = preferredPanelSize }
    }

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
        let idealWidth = tileWidth + stripInset * 2
        let maxWidth = resolvedPopoverMaxWidth
        let popoverWidth = min(max(handleSize.width, idealWidth), maxWidth)
        let height = tileStripHeight + tailHeight + popoverToAnchorGap + handleSize.height
        return NSSize(width: popoverWidth, height: height)
    }

    private var resolvedPopoverMaxWidth: CGFloat {
        if popoverMaxWidth > 0 {
            return popoverMaxWidth
        }
        let visible = view.window?.screen?.visibleFrame
            ?? NSScreen.main?.visibleFrame
            ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        return max(handleSize.width, visible.width - popoverScreenMargin * 2)
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

    func handleScreenOrigin() -> CGPoint? {
        handleScreenFrame()?.origin
    }

    // The handle's rect in screen coordinates. Used both for the pin-on-resize
    // math and for keeping the dictation bar clear of the handle.
    func handleScreenFrame() -> CGRect? {
        guard let window = view.window else { return nil }
        view.layoutSubtreeIfNeeded()
        let inWindow = handleView.convert(handleView.bounds, to: nil)
        return window.convertToScreen(inWindow)
    }

    private func configure() {
        // The expanded tile strip is a dark-glass HUD: captions are drawn
        // white over a .hudWindow backdrop, tile backgrounds and borders are
        // white-alpha tints. The only appearance-sensitive piece is that
        // backdrop material, which renders light under the system light
        // appearance and strands the white captions on a white strip. Pin
        // just the backdrop to darkAqua so the expanded strip stays dark in
        // both system modes. The root view is intentionally left unpinned so
        // the collapsed handle can follow the system appearance (a white pill
        // in light mode, near-black in dark mode); the handle draws its own
        // per-appearance colours in SpaceAgentHandleView.draw.
        tileBackdrop.appearance = NSAppearance(named: .darkAqua)

        rootView.handleView = handleView
        rootView.tileBackdrop = tileBackdrop
        rootView.tileHost = tileScrollView
        rootView.handleSize = handleSize
        rootView.tileStripHeight = tileStripHeight
        rootView.stripInset = stripInset
        rootView.tailHeight = tailHeight
        rootView.popoverToAnchorGap = popoverToAnchorGap
        rootView.translatesAutoresizingMaskIntoConstraints = false

        tileBackdrop.tailHeight = tailHeight

        handleView.image = NSImage(named: "SpaceAgentSpaceship")
        handleView.onToggle = { [weak self] in
            guard let self else { return }
            delegate?.spaceAgentViewControllerDidToggle(self)
        }

        tileScrollView.drawsBackground = false
        tileScrollView.borderType = .noBorder
        tileScrollView.hasVerticalScroller = false
        tileScrollView.hasHorizontalScroller = false
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
        tileBackdrop.isHidden = !isExpanded
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
    var tileBackdrop: SpaceAgentTileBackdropView? {
        didSet {
            oldValue?.removeFromSuperview()
            if let tileBackdrop {
                addSubview(tileBackdrop, positioned: .below, relativeTo: tileHost)
            }
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
    var tileStripHeight: CGFloat = 116
    var stripInset: CGFloat = 8
    var tailHeight: CGFloat = 8
    var popoverToAnchorGap: CGFloat = 2

    override var isFlipped: Bool { true }

    override func layout() {
        super.layout()
        let handleX = max(0, (bounds.width - handleSize.width) / 2)
        if !isExpanded {
            let handleY = max(0, (bounds.height - handleSize.height) / 2)
            handleView?.frame = CGRect(x: handleX, y: handleY, width: handleSize.width, height: handleSize.height)
            tileBackdrop?.frame = .zero
            tileHost?.frame = .zero
            return
        }

        let popoverWidth = bounds.width
        let backdropHeight = tileStripHeight + tailHeight
        let backdropFrame = CGRect(x: 0, y: 0, width: popoverWidth, height: backdropHeight)
        tileBackdrop?.frame = backdropFrame

        let bodyFrame = CGRect(
            x: stripInset,
            y: stripInset,
            width: max(0, popoverWidth - stripInset * 2),
            height: max(0, tileStripHeight - stripInset * 2)
        )
        tileHost?.frame = bodyFrame

        let handleY = backdropHeight + popoverToAnchorGap
        handleView?.frame = CGRect(x: handleX, y: handleY, width: handleSize.width, height: handleSize.height)

        let rocketCenter = handleX + handleSize.width / 2
        tileBackdrop?.tailCenterX = rocketCenter
    }
}

private final class SpaceAgentTileBackdropView: NSVisualEffectView {
    var tailHeight: CGFloat = 0 { didSet { needsLayout = true } }
    var tailWidth: CGFloat = 18 { didSet { needsLayout = true } }
    var cornerRadius: CGFloat = 0 { didSet { needsLayout = true } }
    var tailCenterX: CGFloat = 0 {
        didSet {
            guard oldValue != tailCenterX else { return }
            needsLayout = true
        }
    }

    private let maskLayer = CAShapeLayer()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        commonInit()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        commonInit()
    }

    private func commonInit() {
        material = .hudWindow
        blendingMode = .behindWindow
        state = .active
        wantsLayer = true
        layer?.masksToBounds = false
        maskLayer.fillRule = .nonZero
        layer?.mask = maskLayer
    }

    override func layout() {
        super.layout()
        updatePaths()
    }

    private func updatePaths() {
        guard let layer else { return }
        maskLayer.frame = layer.bounds
        guard bounds.width > 0, bounds.height > tailHeight else {
            maskLayer.path = nil
            return
        }
        maskLayer.path = makePath(in: bounds, tailCenterX: clampedTailCenter(in: bounds))
    }

    private func clampedTailCenter(in rect: CGRect) -> CGFloat {
        let minX = rect.minX + cornerRadius + tailWidth / 2
        let maxX = rect.maxX - cornerRadius - tailWidth / 2
        guard minX <= maxX else { return rect.midX }
        return min(max(tailCenterX, minX), maxX)
    }

    private func makePath(in rect: CGRect, tailCenterX cx: CGFloat) -> CGPath {
        // Layer coordinates: y increases upward. When tailHeight > 0 a small
        // triangle pokes out of the bottom (y = rect.minY); otherwise the
        // mask is just the body rectangle (with optional corner radius).
        let body = CGRect(
            x: rect.minX,
            y: rect.minY + tailHeight,
            width: rect.width,
            height: max(0, rect.height - tailHeight)
        )
        let path = CGMutablePath()
        if cornerRadius > 0 {
            path.addRoundedRect(in: body, cornerWidth: cornerRadius, cornerHeight: cornerRadius)
        } else {
            path.addRect(body)
        }
        if tailHeight > 0 {
            path.move(to: CGPoint(x: cx + tailWidth / 2, y: body.minY))
            path.addLine(to: CGPoint(x: cx, y: rect.minY))
            path.addLine(to: CGPoint(x: cx - tailWidth / 2, y: body.minY))
            path.closeSubpath()
        }
        return path
    }
}

private final class SpaceAgentHandleView: NSControl {
    var image: NSImage?
    var onToggle: (() -> Void)?
    private var mouseDownScreenPoint: CGPoint = .zero
    private var mouseDownWindowOrigin: CGPoint = .zero
    private var didDrag = false

    override var isFlipped: Bool { true }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.clear.setFill()
        dirtyRect.fill()

        // The collapsed handle follows the system appearance: a white pill in
        // light mode, a near-black pill in dark mode. The root view is left
        // unpinned (only the expanded backdrop is pinned dark) so this view's
        // effectiveAppearance tracks the system here.
        let isDark = effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua

        let circle = bounds.insetBy(dx: 2, dy: 2)
        (isDark
            ? NSColor(calibratedWhite: 0.06, alpha: 0.72)
            : NSColor(calibratedWhite: 1.0, alpha: 0.95)).setFill()
        NSBezierPath(roundedRect: circle, xRadius: 14, yRadius: 14).fill()

        (isDark
            ? NSColor(calibratedWhite: 1.0, alpha: 0.16)
            : NSColor.separatorColor).setStroke()
        let border = NSBezierPath(roundedRect: circle, xRadius: 14, yRadius: 14)
        border.lineWidth = 1
        border.stroke()

        // In light mode the rocket sits in a gray disc on the white pill, to
        // match the dictation bar's mic (white pill, gray circle, icon on
        // top). In dark mode the pill is already dark, so the rocket draws on
        // it directly.
        if !isDark {
            let disc = bounds.insetBy(dx: 7, dy: 7)
            NSColor.systemGray.withAlphaComponent(0.25).setFill()
            NSBezierPath(ovalIn: disc).fill()
        }

        if let image {
            image.draw(in: bounds.insetBy(dx: 8, dy: 8), from: .zero, operation: .sourceOver, fraction: 1)
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
            view.frame = CGRect(
                x: x,
                y: 0,
                width: tileSize.width,
                height: tileSize.height + SpaceAgentTileView.labelHeight
            )
            x += tileSize.width + tileSpacing
        }
    }

    private func resizeDocument(for tileCount: Int) {
        let width = CGFloat(tileCount) * tileSize.width
            + CGFloat(max(0, tileCount - 1)) * tileSpacing
        let height = tileSize.height + SpaceAgentTileView.labelHeight
        frame = CGRect(origin: .zero, size: CGSize(width: max(0, width), height: height))
    }

    private func scrollActiveTileToVisible() {
        guard let activeIndex = tileViews.firstIndex(where: { $0.tile?.isActive == true }) else { return }
        layoutSubtreeIfNeeded()
        scrollToVisible(tileViews[activeIndex].frame)
    }
}

private final class SpaceAgentTileView: NSControl {
    // Caption laid out Spotify-style: 8pt gap from thumbnail, 17pt
    // bold title, 4pt gap, 14pt regular dim subtitle, 6pt tail
    // padding. Adds up to 49pt of caption. Font sizes are held while
    // the tile shrinks so the labels stay legible at high desktop
    // counts; only the surrounding insets give.
    static let labelHeight: CGFloat = 49
    static let imageCornerRadius: CGFloat = 6
    static let captionLeadingInset: CGFloat = 10
    static let captionTopInset: CGFloat = 8
    static let primaryRowHeight: CGFloat = 17
    static let primaryToSecondaryGap: CGFloat = 4
    static let secondaryRowHeight: CGFloat = 14

    var tile: SpaceAgentTile? {
        didSet {
            toolTip = [tile?.title, tile?.secondary]
                .compactMap { $0 }
                .filter { !$0.isEmpty }
                .joined(separator: " \u{2014} ")
            needsDisplay = true
        }
    }
    var onSelectDelta: ((Int) -> Void)?

    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        guard let tile else { return }
        drawTileBackground(in: bounds, active: tile.isActive)

        let imageRect = CGRect(
            x: 0,
            y: 0,
            width: bounds.width,
            height: max(0, bounds.height - Self.labelHeight)
        )
        let path = NSBezierPath(
            roundedRect: imageRect,
            xRadius: Self.imageCornerRadius,
            yRadius: Self.imageCornerRadius
        )
        NSColor(calibratedWhite: 0.10, alpha: 1.0).setFill()
        path.fill()

        if let data = tile.thumbnail, let image = NSImage(data: data) {
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current?.imageInterpolation = .high
            path.addClip()
            image.draw(in: imageRect, from: .zero, operation: .sourceOver, fraction: 1)
            NSGraphicsContext.restoreGraphicsState()
        } else {
            drawPlaceholder(in: imageRect, active: tile.isActive)
        }

        let borderColor: NSColor = tile.isActive ? .controlAccentColor : NSColor(calibratedWhite: 1, alpha: 0.10)
        borderColor.setStroke()
        path.lineWidth = tile.isActive ? 2 : 0.5
        path.stroke()

        drawCaption(in: bounds, imageRect: imageRect, tile: tile)
    }

    private func drawTileBackground(in bounds: CGRect, active: Bool) {
        // Subtle inset bg gives the caption a "card" feel without
        // competing with the thumbnail's own contrast. Active tile
        // gets a faint accent tint instead of just a thicker border.
        let bg = NSBezierPath(roundedRect: bounds, xRadius: 8, yRadius: 8)
        if active {
            NSColor.controlAccentColor.withAlphaComponent(0.10).setFill()
        } else {
            NSColor(calibratedWhite: 1, alpha: 0.03).setFill()
        }
        bg.fill()
    }

    private func drawCaption(in bounds: CGRect, imageRect: CGRect, tile: SpaceAgentTile) {
        let captionLeft = Self.captionLeadingInset
        let captionWidth = bounds.width - Self.captionLeadingInset * 2

        let leftPara = NSMutableParagraphStyle()
        leftPara.alignment = .left
        leftPara.lineBreakMode = .byTruncatingTail

        let primaryAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 13, weight: .bold),
            .foregroundColor: NSColor.white.withAlphaComponent(tile.isActive ? 1.0 : 0.95),
            .paragraphStyle: leftPara,
            .kern: -0.1
        ]
        let secondaryAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 11, weight: .regular),
            .foregroundColor: NSColor.white.withAlphaComponent(tile.isActive ? 0.70 : 0.62),
            .paragraphStyle: leftPara
        ]

        let primaryRect = CGRect(
            x: captionLeft,
            y: imageRect.maxY + Self.captionTopInset,
            width: captionWidth,
            height: Self.primaryRowHeight
        )
        NSAttributedString(string: tile.title, attributes: primaryAttrs).draw(in: primaryRect)

        guard !tile.secondary.isEmpty else { return }
        let secondaryRect = CGRect(
            x: captionLeft,
            y: primaryRect.maxY + Self.primaryToSecondaryGap,
            width: captionWidth,
            height: Self.secondaryRowHeight
        )
        NSAttributedString(string: tile.secondary, attributes: secondaryAttrs).draw(in: secondaryRect)
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
