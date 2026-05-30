import AppKit

@MainActor
protocol SpaceAgentViewControllerDelegate: AnyObject {
    func spaceAgentViewControllerDidToggle(_ controller: SpaceAgentViewController)
    // A tile was clicked: switch desktops but keep the popover open.
    func spaceAgentViewController(_ controller: SpaceAgentViewController, didSelectStepDelta delta: Int)
    // Enter in the search bar: switch to the selected desktop, then collapse.
    func spaceAgentViewController(_ controller: SpaceAgentViewController, didOpenStepDelta delta: Int)
    // Esc, or Enter on the desktop you are already on: just collapse.
    func spaceAgentViewControllerDidRequestCollapse(_ controller: SpaceAgentViewController)
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
    private let tileClipView = SpaceAgentClipView()
    private let tileHost = SpaceAgentTileHostView()
    private let overflowHintView = SpaceAgentOverflowHintView()
    private let searchField = NSSearchField()
    private let searchFieldHeight: CGFloat = 28
    private let searchToStripGap: CGFloat = 8
    private var tiles: [SpaceAgentTile] = []
    // Live search/filter state for the desktop palette. filterText narrows
    // the strip; selectedSpaceId is the keyboard highlight, opened on Enter.
    private var filterText: String = ""
    private var selectedSpaceId: UInt64?

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
        let searchZone = searchFieldHeight + searchToStripGap
        let height = tileStripHeight + tailHeight + searchZone
            + popoverToAnchorGap + handleSize.height
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

    override func viewDidLayout() {
        super.viewDidLayout()
        updateOverflowHints()
    }

    func render(tiles: [SpaceAgentTile]) {
        self.tiles = tiles
        // Keep the keyboard selection if it still exists; otherwise fall back
        // to the active desktop so something is always highlighted.
        if selectedSpaceId == nil || !tiles.contains(where: { $0.spaceId == selectedSpaceId }) {
            selectedSpaceId = tiles.first(where: \.isActive)?.spaceId
        }
        refreshDisplayedTiles()
        rootView.needsLayout = true
        preferredContentSize = preferredPanelSize
        updateOverflowHints()
    }

    // Applies the live filter and selection highlight to the full tile set,
    // then hands the visible subset to the strip. Panel width stays sized to
    // the full set (preferredPanelSize), so filtering narrows the content
    // without the panel jumping around on every keystroke.
    private func refreshDisplayedTiles() {
        let filtered = tiles.filter(matchesFilter)
        if selectedSpaceId == nil || !filtered.contains(where: { $0.spaceId == selectedSpaceId }) {
            selectedSpaceId = filtered.first?.spaceId
        }
        let displayed = filtered.map { tile -> SpaceAgentTile in
            var copy = tile
            copy.isSelected = tile.spaceId == selectedSpaceId
            return copy
        }
        tileHost.render(tiles: displayed)
    }

    private func matchesFilter(_ tile: SpaceAgentTile) -> Bool {
        let query = filterText.trimmingCharacters(in: .whitespaces).lowercased()
        guard !query.isEmpty else { return true }
        // A purely numeric query also matches the desktop number, so "3" jumps
        // to desktop 3 without the word "Desktop" living in every tile's text.
        if let number = Int(query), tile.desktopNumber == number {
            return true
        }
        // searchText is the full untruncated name (window title + app), so
        // long names stay findable past the display ellipsis.
        return tile.searchText.lowercased().contains(query)
    }

    private func moveSelection(by step: Int) {
        let filtered = tiles.filter(matchesFilter)
        guard !filtered.isEmpty else { return }
        let current = filtered.firstIndex { $0.spaceId == selectedSpaceId } ?? 0
        let next = min(max(current + step, 0), filtered.count - 1)
        selectedSpaceId = filtered[next].spaceId
        refreshDisplayedTiles()
        tileHost.scrollSelectedTileToVisible()
    }

    private func openSelected() {
        let filtered = tiles.filter(matchesFilter)
        guard let id = selectedSpaceId,
              let tile = filtered.first(where: { $0.spaceId == id })
        else { return }
        if tile.stepDelta != 0 {
            delegate?.spaceAgentViewController(self, didOpenStepDelta: tile.stepDelta)
        } else {
            // Already on this desktop; opening it is just a dismiss.
            delegate?.spaceAgentViewControllerDidRequestCollapse(self)
        }
    }

    // Called by the controller once the panel is key, so the field can take
    // first-responder and start receiving keystrokes.
    func focusSearchField() {
        view.window?.makeFirstResponder(searchField)
    }

    // Reset to a clean palette on each expand: empty query, selection on the
    // active desktop.
    func resetSearch() {
        filterText = ""
        searchField.stringValue = ""
        selectedSpaceId = tiles.first(where: \.isActive)?.spaceId
        refreshDisplayedTiles()
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
        rootView.handleView = handleView
        rootView.tileBackdrop = tileBackdrop
        rootView.tileHost = tileScrollView
        rootView.overflowHintView = overflowHintView
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
        tileScrollView.contentView = tileClipView
        tileScrollView.documentView = tileHost
        tileClipView.drawsBackground = false
        tileClipView.onBoundsChanged = { [weak self] in
            self?.updateOverflowHints()
        }

        tileHost.tileSize = tileSize
        tileHost.tileSpacing = tileSpacing
        tileHost.onSelectDelta = { [weak self] delta in
            guard let self else { return }
            delegate?.spaceAgentViewController(self, didSelectStepDelta: delta)
        }

        searchField.placeholderString = "Search desktops"
        searchField.focusRingType = .none
        searchField.delegate = self
        rootView.searchField = searchField
        rootView.searchFieldHeight = searchFieldHeight
        rootView.searchToStripGap = searchToStripGap
    }

    private func applyVisibility() {
        rootView.isExpanded = isExpanded
        tileHost.isHidden = !isExpanded
        tileBackdrop.isHidden = !isExpanded
        overflowHintView.isHidden = !isExpanded
        searchField.isHidden = !isExpanded
        preferredContentSize = preferredPanelSize
        rootView.needsLayout = true
        updateOverflowHints()
    }

    private func updateOverflowHints() {
        guard isExpanded else {
            overflowHintView.setShows(left: false, right: false)
            return
        }

        let viewport = tileScrollView.contentView.bounds
        let documentWidth = tileHost.frame.width
        let maxOffsetX = max(0, documentWidth - viewport.width)
        let currentX = viewport.minX
        let left = currentX > 1
        let right = currentX < maxOffsetX - 1
        overflowHintView.setShows(left: left, right: right)
    }

    var overflowHintState: (left: Bool, right: Bool) {
        updateOverflowHints()
        return (overflowHintView.showsLeft, overflowHintView.showsRight)
    }
}

extension SpaceAgentViewController: NSSearchFieldDelegate {
    func controlTextDidChange(_ obj: Notification) {
        filterText = searchField.stringValue
        // Each edit re-points the selection at the first match so Enter on a
        // narrowed-to-one result opens it without an arrow press.
        selectedSpaceId = tiles.filter(matchesFilter).first?.spaceId
        refreshDisplayedTiles()
        tileHost.scrollSelectedTileToVisible()
    }

    // The strip is horizontal, so Left/Right move the selection; Up/Down are
    // accepted as aliases. Intercepting them costs caret arrow-movement in the
    // (short) query, which is an acceptable trade for keyboard desktop nav.
    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        switch selector {
        case #selector(NSResponder.insertNewline(_:)):
            openSelected()
            return true
        case #selector(NSResponder.moveLeft(_:)), #selector(NSResponder.moveUp(_:)):
            moveSelection(by: -1)
            return true
        case #selector(NSResponder.moveRight(_:)), #selector(NSResponder.moveDown(_:)):
            moveSelection(by: 1)
            return true
        case #selector(NSResponder.cancelOperation(_:)):
            delegate?.spaceAgentViewControllerDidRequestCollapse(self)
            return true
        default:
            return false
        }
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
    var overflowHintView: SpaceAgentOverflowHintView? {
        didSet {
            oldValue?.removeFromSuperview()
            if let overflowHintView { addSubview(overflowHintView) }
        }
    }
    var searchField: NSView? {
        didSet {
            oldValue?.removeFromSuperview()
            if let searchField { addSubview(searchField) }
        }
    }
    var isExpanded: Bool = false
    var handleSize = CGSize(width: 52, height: 52)
    var tileStripHeight: CGFloat = 116
    var stripInset: CGFloat = 8
    var tailHeight: CGFloat = 8
    var popoverToAnchorGap: CGFloat = 2
    var searchFieldHeight: CGFloat = 28
    var searchToStripGap: CGFloat = 8

    override var isFlipped: Bool { true }

    override func layout() {
        super.layout()
        let handleX = max(0, (bounds.width - handleSize.width) / 2)
        if !isExpanded {
            let handleY = max(0, (bounds.height - handleSize.height) / 2)
            handleView?.frame = CGRect(x: handleX, y: handleY, width: handleSize.width, height: handleSize.height)
            tileBackdrop?.frame = .zero
            tileHost?.frame = .zero
            overflowHintView?.frame = .zero
            searchField?.frame = .zero
            return
        }

        let popoverWidth = bounds.width
        let searchZone = searchFieldHeight + searchToStripGap
        let backdropHeight = tileStripHeight + tailHeight + searchZone
        let backdropFrame = CGRect(x: 0, y: 0, width: popoverWidth, height: backdropHeight)
        tileBackdrop?.frame = backdropFrame

        searchField?.frame = CGRect(
            x: stripInset,
            y: stripInset,
            width: max(0, popoverWidth - stripInset * 2),
            height: searchFieldHeight
        )

        let bodyFrame = CGRect(
            x: stripInset,
            y: stripInset + searchZone,
            width: max(0, popoverWidth - stripInset * 2),
            height: max(0, tileStripHeight - stripInset * 2)
        )
        tileHost?.frame = bodyFrame
        overflowHintView?.frame = bodyFrame

        let handleY = backdropHeight + popoverToAnchorGap
        handleView?.frame = CGRect(x: handleX, y: handleY, width: handleSize.width, height: handleSize.height)

        let rocketCenter = handleX + handleSize.width / 2
        tileBackdrop?.tailCenterX = rocketCenter
    }
}

private final class SpaceAgentTileBackdropView: NSView {
    var tailHeight: CGFloat = 0 { didSet { needsLayout = true } }
    var tailWidth: CGFloat = 18 { didSet { needsLayout = true } }
    var cornerRadius: CGFloat = 0 { didSet { needsLayout = true } }
    var tailCenterX: CGFloat = 0 {
        didSet {
            guard oldValue != tailCenterX else { return }
            needsLayout = true
        }
    }

    private let materialView = NSVisualEffectView()
    private let tintView = SpaceAgentPanelTintView()
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
        wantsLayer = true
        layer?.masksToBounds = false
        maskLayer.fillRule = .nonZero
        layer?.mask = maskLayer

        materialView.blendingMode = .behindWindow
        materialView.state = .active
        materialView.wantsLayer = true
        materialView.layer?.masksToBounds = false
        addSubview(materialView)

        tintView.wantsLayer = true
        tintView.layer?.masksToBounds = false
        addSubview(tintView)

        updateMaterial()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        updateMaterial()
        tintView.needsDisplay = true
    }

    override func layout() {
        super.layout()
        materialView.frame = bounds
        tintView.frame = bounds
        updatePaths()
    }

    private func updatePaths() {
        guard let layer else { return }
        let path = makePath(in: layer.bounds, tailCenterX: clampedTailCenter(in: layer.bounds))
        maskLayer.frame = layer.bounds
        maskLayer.path = path
        tintView.tailHeight = tailHeight
        tintView.tailWidth = tailWidth
        tintView.cornerRadius = cornerRadius
        tintView.tailCenterX = tailCenterX
    }

    private func updateMaterial() {
        let palette = SpaceAgentPalette(appearance: effectiveAppearance)
        materialView.material = palette.panelMaterial
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

private final class SpaceAgentPanelTintView: NSView {
    var tailHeight: CGFloat = 0 { didSet { needsDisplay = true } }
    var tailWidth: CGFloat = 18 { didSet { needsDisplay = true } }
    var cornerRadius: CGFloat = 0 { didSet { needsDisplay = true } }
    var tailCenterX: CGFloat = 0 { didSet { needsDisplay = true } }

    override var isFlipped: Bool { true }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        guard bounds.width > 0, bounds.height > tailHeight else { return }
        let path = NSBezierPath(cgPath: makePath(in: bounds, tailCenterX: clampedTailCenter(in: bounds)))
        let palette = SpaceAgentPalette(appearance: effectiveAppearance)
        palette.panelTint.setFill()
        path.fill()
        palette.panelStroke.setStroke()
        path.lineWidth = 1
        path.stroke()
    }

    private func clampedTailCenter(in rect: CGRect) -> CGFloat {
        let minX = rect.minX + cornerRadius + tailWidth / 2
        let maxX = rect.maxX - cornerRadius - tailWidth / 2
        guard minX <= maxX else { return rect.midX }
        return min(max(tailCenterX, minX), maxX)
    }

    private func makePath(in rect: CGRect, tailCenterX cx: CGFloat) -> CGPath {
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

private final class SpaceAgentClipView: NSClipView {
    var onBoundsChanged: (() -> Void)?

    override var bounds: NSRect {
        didSet {
            guard oldValue.origin != bounds.origin || oldValue.size != bounds.size else { return }
            onBoundsChanged?()
        }
    }
}

private final class SpaceAgentOverflowHintView: NSView {
    private(set) var showsLeft = false
    private(set) var showsRight = false

    override var isFlipped: Bool { true }

    override func hitTest(_ point: NSPoint) -> NSView? {
        nil
    }

    func setShows(left: Bool, right: Bool) {
        let changed = showsLeft != left || showsRight != right
        showsLeft = left
        showsRight = right
        isHidden = !left && !right
        if changed {
            needsDisplay = true
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        guard showsLeft || showsRight else { return }
        if showsLeft {
            drawHint(edge: .left)
        }
        if showsRight {
            drawHint(edge: .right)
        }
    }

    private enum Edge {
        case left
        case right
    }

    private func drawHint(edge: Edge) {
        let palette = SpaceAgentPalette(appearance: effectiveAppearance)
        let width: CGFloat = 34
        let fadeRect: CGRect
        let gradient: NSGradient?
        switch edge {
        case .left:
            fadeRect = CGRect(x: bounds.minX, y: bounds.minY, width: width, height: bounds.height)
            gradient = NSGradient(colors: [
                palette.overflowFadeStrong,
                palette.overflowFadeClear
            ])
        case .right:
            fadeRect = CGRect(x: bounds.maxX - width, y: bounds.minY, width: width, height: bounds.height)
            gradient = NSGradient(colors: [
                palette.overflowFadeClear,
                palette.overflowFadeStrong
            ])
        }
        gradient?.draw(in: fadeRect, angle: 0)

        let centerX = edge == .left ? fadeRect.minX + 15 : fadeRect.maxX - 15
        let centerY = bounds.midY - SpaceAgentTileView.labelHeight / 2
        let chevron = NSBezierPath()
        chevron.lineWidth = 2.2
        chevron.lineCapStyle = .round
        chevron.lineJoinStyle = .round
        switch edge {
        case .left:
            chevron.move(to: CGPoint(x: centerX + 4, y: centerY - 8))
            chevron.line(to: CGPoint(x: centerX - 4, y: centerY))
            chevron.line(to: CGPoint(x: centerX + 4, y: centerY + 8))
        case .right:
            chevron.move(to: CGPoint(x: centerX - 4, y: centerY - 8))
            chevron.line(to: CGPoint(x: centerX + 4, y: centerY))
            chevron.line(to: CGPoint(x: centerX - 4, y: centerY + 8))
        }
        palette.overflowChevron.setStroke()
        chevron.stroke()
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
        // Same surface as the dictation bar (DictationPillView.draw) so the
        // two floating overlays share one translucency. Keep these in step.
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

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        tileViews.forEach { $0.needsDisplay = true }
        needsDisplay = true
    }

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
            scrollSelectedTileToVisible()
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

    func scrollSelectedTileToVisible() {
        let index = tileViews.firstIndex { $0.tile?.isSelected == true }
            ?? tileViews.firstIndex { $0.tile?.isActive == true }
        guard let index else { return }
        layoutSubtreeIfNeeded()
        scrollToVisible(tileViews[index].frame)
    }
}

private final class SpaceAgentTileView: NSControl {
    // Card laid out Spotify-style: the thumbnail is cover art filling the
    // card's top edge-to-edge (rounded top corners, square where it meets
    // the caption), with a two-line caption (14pt bold title, 4pt gap,
    // 12pt dim subtitle, tail padding) below on the card surface. Adds up
    // to 49pt of caption. Font sizes hold while the tile shrinks so the
    // labels stay legible at high desktop counts; only the insets give.
    static let labelHeight: CGFloat = 49
    static let cardCornerRadius: CGFloat = 8
    static let captionLeadingInset: CGFloat = 10
    static let captionTopInset: CGFloat = 8
    static let primaryRowHeight: CGFloat = 18
    static let primaryToSecondaryGap: CGFloat = 4
    static let secondaryRowHeight: CGFloat = 15

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
    private var isHovered = false

    override var isFlipped: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        // Layer-backed with masksToBounds off so the hover shadow can cast
        // past the tile's own bounds into the inter-card gap.
        wantsLayer = true
        layer?.masksToBounds = false
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    override func layout() {
        super.layout()
        updateElevation()
    }

    // Spotify-style hover lift: the cursor entering a card lightens its
    // surface (in draw) and raises a soft drop shadow (here). Uses the
    // visible rect so it keeps working as tiles scroll under the clip.
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
            owner: self,
            userInfo: nil
        ))
    }

    override func mouseEntered(with event: NSEvent) {
        guard !isHovered else { return }
        isHovered = true
        updateElevation()
        needsDisplay = true
    }

    override func mouseExited(with event: NSEvent) {
        guard isHovered else { return }
        isHovered = false
        updateElevation()
        needsDisplay = true
    }

    private func updateElevation() {
        guard let layer else { return }
        layer.shadowColor = NSColor.black.cgColor
        layer.shadowOffset = CGSize(width: 0, height: -2)
        layer.shadowRadius = 7
        layer.shadowOpacity = isHovered ? 0.34 : 0
        layer.shadowPath = CGPath(
            roundedRect: bounds,
            cornerWidth: Self.cardCornerRadius,
            cornerHeight: Self.cardCornerRadius,
            transform: nil
        )
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let tile else { return }
        let palette = SpaceAgentPalette(appearance: effectiveAppearance)

        // Card surface. Lightens on hover (paired with the shadow lift in
        // updateElevation); a faint accent wash marks the active desktop.
        let card = NSBezierPath(
            roundedRect: bounds,
            xRadius: Self.cardCornerRadius,
            yRadius: Self.cardCornerRadius
        )
        let surface: NSColor
        if tile.isActive {
            surface = palette.activeTileFill
        } else if tile.isSelected || isHovered {
            surface = palette.tileFillHover
        } else {
            surface = palette.tileFill
        }
        surface.setFill()
        card.fill()

        // Cover art fills the card's top edge-to-edge. Clipping to the card
        // path borrows its rounded top corners while the bottom stays a
        // straight cut where the caption begins, so the art reads as large
        // as the card allows instead of sitting in a frame.
        let imageRect = CGRect(
            x: 0,
            y: 0,
            width: bounds.width,
            height: max(0, bounds.height - Self.labelHeight)
        )
        NSGraphicsContext.saveGraphicsState()
        card.addClip()
        NSBezierPath(rect: imageRect).addClip()
        palette.thumbnailFill.setFill()
        NSBezierPath(rect: imageRect).fill()
        if let data = tile.thumbnail, let image = NSImage(data: data) {
            NSGraphicsContext.current?.imageInterpolation = .high
            image.draw(in: imageRect, from: .zero, operation: .sourceOver, fraction: 1)
        } else {
            drawPlaceholder(in: imageRect, active: tile.isActive, palette: palette)
        }
        NSGraphicsContext.restoreGraphicsState()

        // Ring the whole card: accent for the active desktop, a neutral tone
        // for the keyboard selection. Inset so the 1.5pt stroke sits fully
        // inside the tile bounds.
        if tile.isActive || tile.isSelected {
            let ring = NSBezierPath(
                roundedRect: bounds.insetBy(dx: 0.75, dy: 0.75),
                xRadius: Self.cardCornerRadius,
                yRadius: Self.cardCornerRadius
            )
            (tile.isActive ? NSColor.controlAccentColor : palette.selectionRing).setStroke()
            ring.lineWidth = 1.5
            ring.stroke()
        }

        drawDesktopNumber(in: imageRect, tile: tile)
        drawCaption(in: bounds, imageRect: imageRect, tile: tile, palette: palette)
    }

    private func drawCaption(
        in bounds: CGRect,
        imageRect: CGRect,
        tile: SpaceAgentTile,
        palette: SpaceAgentPalette
    ) {
        let captionLeft = Self.captionLeadingInset
        let captionWidth = bounds.width - Self.captionLeadingInset * 2

        let leftPara = NSMutableParagraphStyle()
        leftPara.alignment = .left
        leftPara.lineBreakMode = .byTruncatingTail

        let primaryAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 14, weight: .bold),
            .foregroundColor: tile.isActive
                ? NSColor.controlAccentColor
                : palette.primaryText.withAlphaComponent(0.96),
            .paragraphStyle: leftPara,
            .kern: -0.1
        ]
        let secondaryAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 12, weight: .regular),
            .foregroundColor: palette.secondaryText.withAlphaComponent(tile.isActive ? 0.9 : 0.72),
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

    private func drawDesktopNumber(in imageRect: CGRect, tile: SpaceAgentTile) {
        guard tile.desktopNumber > 0 else { return }

        let string = "\(tile.desktopNumber)" as NSString
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        let textAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
            .foregroundColor: NSColor.white,
            .paragraphStyle: paragraph
        ]
        let textSize = string.size(withAttributes: textAttrs)
        let badgeHeight: CGFloat = 18
        let badgeWidth = max(18, ceil(textSize.width) + 10)
        let inset: CGFloat = 6
        let badgeRect = CGRect(
            x: imageRect.maxX - badgeWidth - inset,
            y: imageRect.maxY - badgeHeight - inset,
            width: badgeWidth,
            height: badgeHeight
        )

        let badgePath = NSBezierPath(
            roundedRect: badgeRect,
            xRadius: badgeHeight / 2,
            yRadius: badgeHeight / 2
        )
        NSColor.black.withAlphaComponent(0.5).setFill()
        badgePath.fill()

        let textRect = CGRect(
            x: badgeRect.minX,
            y: badgeRect.minY + (badgeHeight - textSize.height) / 2 - 1,
            width: badgeRect.width,
            height: textSize.height
        )
        string.draw(in: textRect, withAttributes: textAttrs)
    }

    override func mouseUp(with event: NSEvent) {
        guard let tile, !tile.isActive, tile.stepDelta != 0 else { return }
        onSelectDelta?(tile.stepDelta)
    }

    private func drawPlaceholder(in rect: CGRect, active: Bool, palette: SpaceAgentPalette) {
        let gradient = NSGradient(colors: [
            palette.placeholderTop,
            palette.placeholderBottom
        ])
        gradient?.draw(in: NSBezierPath(roundedRect: rect, xRadius: 8, yRadius: 8), angle: 90)
        palette.placeholderMark.withAlphaComponent(active ? 0.34 : 0.22).setStroke()
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

private struct SpaceAgentPalette {
    let isDark: Bool

    init(appearance: NSAppearance) {
        isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
    }

    var panelMaterial: NSVisualEffectView.Material {
        isDark ? .hudWindow : .popover
    }

    // Panel surface. Lifted off pure black and made more solid in dark
    // mode so the strip separates from a dark wallpaper instead of reading
    // black-on-black; the higher opacity also lets the window's own shadow
    // cast a real edge. The stroke is a clearly visible hairline so the
    // panel edge stays defined whatever the wallpaper behind it.
    var panelTint: NSColor {
        isDark
            ? NSColor(calibratedWhite: 0.11, alpha: 0.80)
            : NSColor(calibratedWhite: 1.0, alpha: 0.72)
    }

    var panelStroke: NSColor {
        isDark
            ? NSColor(calibratedWhite: 1.0, alpha: 0.24)
            : NSColor(calibratedWhite: 0.0, alpha: 0.16)
    }

    // Rest card surface. Sits a clear step above the lifted panel tint so
    // an inactive card still reads as its own surface rather than blending
    // into the strip behind it.
    var tileFill: NSColor {
        isDark
            ? NSColor(calibratedWhite: 1.0, alpha: 0.10)
            : NSColor(calibratedWhite: 1.0, alpha: 0.26)
    }

    // Hover surface: a clear step up from the rest fill so the card reads
    // as raised, the way Spotify lightens a card under the cursor.
    var tileFillHover: NSColor {
        isDark
            ? NSColor(calibratedWhite: 1.0, alpha: 0.18)
            : NSColor(calibratedWhite: 1.0, alpha: 0.5)
    }

    var activeTileFill: NSColor {
        isDark
            ? NSColor.controlAccentColor.withAlphaComponent(0.16)
            : NSColor.controlAccentColor.withAlphaComponent(0.12)
    }

    // Keyboard-selection ring: a neutral tone so it reads as distinct from
    // the accent ring on the active desktop.
    var selectionRing: NSColor {
        isDark
            ? NSColor(calibratedWhite: 1.0, alpha: 0.7)
            : NSColor(calibratedWhite: 0.0, alpha: 0.45)
    }

    var thumbnailFill: NSColor {
        isDark
            ? NSColor(calibratedWhite: 0.10, alpha: 1.0)
            : NSColor(calibratedWhite: 0.95, alpha: 1.0)
    }

    var primaryText: NSColor {
        isDark ? .white : NSColor(calibratedWhite: 0.08, alpha: 1)
    }

    var secondaryText: NSColor {
        isDark ? .white : NSColor(calibratedWhite: 0.24, alpha: 1)
    }

    var placeholderTop: NSColor {
        isDark
            ? NSColor(calibratedRed: 0.12, green: 0.15, blue: 0.19, alpha: 1)
            : NSColor(calibratedWhite: 0.89, alpha: 1)
    }

    var placeholderBottom: NSColor {
        isDark
            ? NSColor(calibratedRed: 0.19, green: 0.23, blue: 0.29, alpha: 1)
            : NSColor(calibratedWhite: 0.97, alpha: 1)
    }

    var placeholderMark: NSColor {
        isDark ? .white : NSColor(calibratedWhite: 0.22, alpha: 1)
    }

    var overflowFadeStrong: NSColor {
        isDark
            ? NSColor.black.withAlphaComponent(0.42)
            : NSColor.white.withAlphaComponent(0.76)
    }

    var overflowFadeClear: NSColor {
        isDark
            ? NSColor.black.withAlphaComponent(0)
            : NSColor.white.withAlphaComponent(0)
    }

    var overflowChevron: NSColor {
        isDark
            ? NSColor.white.withAlphaComponent(0.48)
            : NSColor.black.withAlphaComponent(0.34)
    }
}

private extension Int {
    var cgFloat: CGFloat { CGFloat(self) }
}
