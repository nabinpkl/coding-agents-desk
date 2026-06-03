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

    // Panel orientation. Horizontal is the original strip below the rocket;
    // vertical stacks desktops in a column to the rocket's left. Both layouts
    // are kept; the knob (Config.spaceAgentLayout) only selects which renders.
    let layout: Config.SpaceAgentLayout

    private let handleSize = CGSize(width: 52, height: 52)
    private let tileSize = CGSize(width: 140, height: 84)
    private let tileSpacing: CGFloat = 10
    private let stripInset: CGFloat = 10
    private let tileStripHeight: CGFloat = 164
    private let tailHeight: CGFloat = 0
    private let popoverToAnchorGap: CGFloat = 6
    private let popoverScreenMargin: CGFloat = 0
    // Vertical-layout metrics: a fixed-width panel of list rows to the left of
    // the rocket, with a small gap between the two.
    private let panelWidth: CGFloat = 280
    private let rowHeight: CGFloat = 52
    private let rowSpacing: CGFloat = 6
    private let clusterGap: CGFloat = 10
    private let rootView = SpaceAgentRootView()
    private let handleView = SpaceAgentHandleView()
    private let tileBackdrop = SpaceAgentTileBackdropView()
    private let tileScrollView = NSScrollView()
    private let tileClipView = SpaceAgentClipView()
    private let tileHost = SpaceAgentTileHostView()
    private let overflowHintView = SpaceAgentOverflowHintView()
    private let searchField = NSSearchField()
    private let searchTokenView = SpaceAgentSearchTokenView()
    private let searchFieldHeight: CGFloat = 28
    private let searchToStripGap: CGFloat = 8
    private var tiles: [SpaceAgentTile] = []
    // Live search/filter state for the desktop palette. filterText narrows
    // the strip; selectedSpaceId is the keyboard highlight, opened on Enter.
    private var filterText: String = ""
    private var selectedSpaceId: UInt64?

    init(layout: Config.SpaceAgentLayout = Config.spaceAgentLayout) {
        self.layout = layout
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        self.layout = Config.spaceAgentLayout
        super.init(coder: coder)
    }

    /// Hard cap on the popover's outer width. Set to a positive value to
    /// override the screen-derived default (used by tests).
    var popoverMaxWidth: CGFloat = 0 {
        didSet { preferredContentSize = preferredPanelSize }
    }

    /// Hard cap on the panel's outer height (vertical layout). Set to a
    /// positive value to override the screen-derived default (used by tests).
    var popoverMaxHeight: CGFloat = 0 {
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
        let searchZone = searchFieldHeight + searchToStripGap
        switch layout {
        case .horizontal:
            let tileWidth = CGFloat(max(1, tiles.count)) * tileSize.width
                + CGFloat(max(0, tiles.count - 1)) * tileSpacing
            let idealWidth = tileWidth + stripInset * 2
            let maxWidth = resolvedPopoverMaxWidth
            let popoverWidth = min(max(handleSize.width, idealWidth), maxWidth)
            let height = tileStripHeight + tailHeight + searchZone
                + popoverToAnchorGap + handleSize.height
            return NSSize(width: popoverWidth, height: height)
        case .vertical:
            // Fixed-width panel to the left of the rocket; height grows with the
            // row count, capped to the screen so the list scrolls when long.
            let count = max(1, tiles.count)
            let listHeight = CGFloat(count) * rowHeight
                + CGFloat(count - 1) * rowSpacing
            let idealPanelHeight = stripInset * 2 + searchZone + listHeight
            let panelHeight = min(idealPanelHeight, resolvedPanelMaxHeight)
            let height = max(panelHeight, handleSize.height)
            let width = panelWidth + clusterGap + handleSize.width
            return NSSize(width: width, height: height)
        }
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

    private var resolvedPanelMaxHeight: CGFloat {
        if popoverMaxHeight > 0 {
            return popoverMaxHeight
        }
        let visible = view.window?.screen?.visibleFrame
            ?? NSScreen.main?.visibleFrame
            ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        return max(handleSize.height, visible.height - popoverScreenMargin * 2)
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
            selectedSpaceId = firstSelectableSpaceId(for: filterText) ?? filtered.first?.spaceId
        }
        let displayed = filtered.map { tile -> SpaceAgentTile in
            var copy = tile
            copy.isSelected = tile.spaceId == selectedSpaceId
            copy.highlightPrefix = (!filterText.isEmpty && tile.matchesNamePrefix(query: filterText))
                ? filterText.trimmingCharacters(in: .whitespaces)
                : ""
            return copy
        }
        tileHost.render(tiles: displayed)
    }

    private func matchesFilter(_ tile: SpaceAgentTile) -> Bool {
        tile.matchesSearch(query: filterText)
    }

    // The desktop to highlight for a query: prefer one whose name actually
    // starts with it (so a seeded Hyper char lands on a starts-with desktop),
    // falling back to the first word-prefix match.
    private func firstSelectableSpaceId(for query: String) -> UInt64? {
        (tiles.first { $0.matchesNamePrefix(query: query) }
            ?? tiles.first { $0.matchesSearch(query: query) })?.spaceId
    }

    // Open-with-text path (Hyper quick-switch with two or more matches): seed
    // the query, point the selection at the first match, and keep the field
    // editor in sync if the field is already focused. Shows the "startsWith"
    // token so the user can see the search mode at a glance.
    func presetSearch(_ text: String) {
        filterText = text
        searchField.stringValue = text
        if let editor = searchField.currentEditor() {
            editor.string = text
            editor.selectedRange = NSRange(location: (text as NSString).length, length: 0)
        }
        searchTokenView.isHidden = false
        rootView.needsLayout = true
        selectedSpaceId = firstSelectableSpaceId(for: text)
        refreshDisplayedTiles()
        tileHost.scrollSelectedTileToVisible()
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
        searchTokenView.isHidden = true
        rootView.needsLayout = true
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
        rootView.panelLayout = layout
        rootView.panelWidth = panelWidth
        rootView.clusterGap = clusterGap
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
        switch layout {
        case .horizontal:
            tileScrollView.horizontalScrollElasticity = .allowed
            tileScrollView.verticalScrollElasticity = .none
        case .vertical:
            tileScrollView.horizontalScrollElasticity = .none
            tileScrollView.verticalScrollElasticity = .allowed
        }
        tileScrollView.contentView = tileClipView
        tileScrollView.documentView = tileHost
        tileClipView.drawsBackground = false
        tileClipView.onBoundsChanged = { [weak self] in
            self?.tileHost.clipBoundsChanged()
            self?.updateOverflowHints()
        }

        tileHost.axis = layout
        tileHost.tileSize = tileSize
        tileHost.tileSpacing = tileSpacing
        tileHost.rowHeight = rowHeight
        tileHost.rowSpacing = rowSpacing
        overflowHintView.axis = layout
        tileHost.onSelectDelta = { [weak self] delta in
            guard let self else { return }
            delegate?.spaceAgentViewController(self, didSelectStepDelta: delta)
        }

        searchField.placeholderString = "Search desktops"
        searchField.focusRingType = .none
        searchField.delegate = self
        searchTokenView.isHidden = true
        rootView.searchField = searchField
        rootView.searchTokenView = searchTokenView
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
            overflowHintView.setShows(start: false, end: false)
            return
        }

        // start/end are along the scroll axis: left/right edges in the
        // horizontal strip, top/bottom edges in the vertical column.
        let viewport = tileScrollView.contentView.bounds
        switch layout {
        case .horizontal:
            let maxOffset = max(0, tileHost.frame.width - viewport.width)
            overflowHintView.setShows(start: viewport.minX > 1,
                                      end: viewport.minX < maxOffset - 1)
        case .vertical:
            let maxOffset = max(0, tileHost.frame.height - viewport.height)
            overflowHintView.setShows(start: viewport.minY > 1,
                                      end: viewport.minY < maxOffset - 1)
        }
    }

    var overflowHintState: (start: Bool, end: Bool) {
        updateOverflowHints()
        return (overflowHintView.showsStart, overflowHintView.showsEnd)
    }
}

extension SpaceAgentViewController: NSSearchFieldDelegate {
    func controlTextDidChange(_ obj: Notification) {
        filterText = searchField.stringValue
        // Dismiss the startsWith token once the user edits freely.
        if !searchTokenView.isHidden {
            searchTokenView.isHidden = true
            rootView.needsLayout = true
        }
        // Each edit re-points the selection at the best match so Enter on a
        // narrowed result opens it without an arrow press.
        selectedSpaceId = firstSelectableSpaceId(for: filterText)
        refreshDisplayedTiles()
        tileHost.scrollSelectedTileToVisible()
    }

    // Both layouts share one mapping: Left/Up step the selection back, Right/Down
    // step it forward, so the primary axis matches whichever orientation is
    // active (Left/Right for the horizontal strip, Up/Down for the vertical
    // column) without separate handling. Intercepting them costs caret
    // arrow-movement in the (short) query, an acceptable trade for desktop nav.
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
    var searchTokenView: SpaceAgentSearchTokenView? {
        didSet {
            oldValue?.removeFromSuperview()
            if let searchTokenView { addSubview(searchTokenView) }
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
    // Named panelLayout (not `layout`) to avoid clashing with NSView.layout().
    var panelLayout: Config.SpaceAgentLayout = .horizontal
    var panelWidth: CGFloat = 280
    var clusterGap: CGFloat = 10

    override var isFlipped: Bool { true }

    override func layout() {
        super.layout()
        if !isExpanded {
            let handleX = max(0, (bounds.width - handleSize.width) / 2)
            let handleY = max(0, (bounds.height - handleSize.height) / 2)
            handleView?.frame = CGRect(x: handleX, y: handleY, width: handleSize.width, height: handleSize.height)
            tileBackdrop?.frame = .zero
            tileHost?.frame = .zero
            overflowHintView?.frame = .zero
            searchField?.frame = .zero
            return
        }
        switch panelLayout {
        case .horizontal:
            layoutHorizontal()
        case .vertical:
            layoutVertical()
        }
    }

    // Original strip: search + horizontal tile row in a backdrop, rocket
    // centered below it.
    private func layoutHorizontal() {
        let handleX = max(0, (bounds.width - handleSize.width) / 2)
        let popoverWidth = bounds.width
        let searchZone = searchFieldHeight + searchToStripGap
        let backdropHeight = tileStripHeight + tailHeight + searchZone
        let backdropFrame = CGRect(x: 0, y: 0, width: popoverWidth, height: backdropHeight)
        tileBackdrop?.frame = backdropFrame

        let tokenShown = searchTokenView.map { !$0.isHidden } ?? false
        let tokenWidth = tokenShown ? (searchTokenView?.measuredWidth ?? 0) : 0
        let tokenGap: CGFloat = tokenShown ? 4 : 0
        searchTokenView?.frame = tokenShown
            ? CGRect(x: stripInset, y: stripInset, width: tokenWidth, height: searchFieldHeight)
            : .zero
        searchField?.frame = CGRect(
            x: stripInset + tokenWidth + tokenGap,
            y: stripInset,
            width: max(0, popoverWidth - stripInset - stripInset - tokenWidth - tokenGap),
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

    // Vertical column: fixed-width panel (search on top, list below) on the
    // left, rocket vertically centered to its right.
    private func layoutVertical() {
        let backdropFrame = CGRect(x: 0, y: 0, width: panelWidth, height: bounds.height)
        tileBackdrop?.frame = backdropFrame
        tileBackdrop?.tailCenterX = backdropFrame.midX

        let searchZone = searchFieldHeight + searchToStripGap
        let tokenShown = searchTokenView.map { !$0.isHidden } ?? false
        let tokenWidth = tokenShown ? (searchTokenView?.measuredWidth ?? 0) : 0
        let tokenGap: CGFloat = tokenShown ? 4 : 0
        searchTokenView?.frame = tokenShown
            ? CGRect(x: stripInset, y: stripInset, width: tokenWidth, height: searchFieldHeight)
            : .zero
        searchField?.frame = CGRect(
            x: stripInset + tokenWidth + tokenGap,
            y: stripInset,
            width: max(0, panelWidth - stripInset - stripInset - tokenWidth - tokenGap),
            height: searchFieldHeight
        )

        let bodyFrame = CGRect(
            x: stripInset,
            y: stripInset + searchZone,
            width: max(0, panelWidth - stripInset * 2),
            height: max(0, bounds.height - stripInset * 2 - searchZone)
        )
        tileHost?.frame = bodyFrame
        overflowHintView?.frame = bodyFrame

        let handleX = panelWidth + clusterGap
        let handleY = max(0, (bounds.height - handleSize.height) / 2)
        handleView?.frame = CGRect(x: handleX, y: handleY, width: handleSize.width, height: handleSize.height)
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
    // start/end run along the scroll axis: left/right edges in the horizontal
    // strip, top/bottom edges in the vertical column.
    private(set) var showsStart = false
    private(set) var showsEnd = false
    var axis: Config.SpaceAgentLayout = .horizontal

    override var isFlipped: Bool { true }

    override func hitTest(_ point: NSPoint) -> NSView? {
        nil
    }

    func setShows(start: Bool, end: Bool) {
        let changed = showsStart != start || showsEnd != end
        showsStart = start
        showsEnd = end
        isHidden = !start && !end
        if changed {
            needsDisplay = true
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        guard showsStart || showsEnd else { return }
        if showsStart { drawHint(atStart: true) }
        if showsEnd { drawHint(atStart: false) }
    }

    private func drawHint(atStart: Bool) {
        let palette = SpaceAgentPalette(appearance: effectiveAppearance)
        let thickness: CGFloat = 34
        let fadeRect: CGRect
        let gradientAngle: CGFloat
        switch axis {
        case .horizontal:
            fadeRect = atStart
                ? CGRect(x: bounds.minX, y: bounds.minY, width: thickness, height: bounds.height)
                : CGRect(x: bounds.maxX - thickness, y: bounds.minY, width: thickness, height: bounds.height)
            gradientAngle = atStart ? 0 : 180
        case .vertical:
            // Flipped coords: minY is the top edge (start), maxY the bottom.
            fadeRect = atStart
                ? CGRect(x: bounds.minX, y: bounds.minY, width: bounds.width, height: thickness)
                : CGRect(x: bounds.minX, y: bounds.maxY - thickness, width: bounds.width, height: thickness)
            gradientAngle = atStart ? 90 : 270
        }
        NSGradient(colors: [palette.overflowFadeStrong, palette.overflowFadeClear])?
            .draw(in: fadeRect, angle: gradientAngle)

        // Chevron pointing toward the off-screen content.
        let chevron = NSBezierPath()
        chevron.lineWidth = 2.2
        chevron.lineCapStyle = .round
        chevron.lineJoinStyle = .round
        let cx = fadeRect.midX
        let cy = fadeRect.midY
        switch axis {
        case .horizontal:
            if atStart {
                chevron.move(to: CGPoint(x: cx + 4, y: cy - 8))
                chevron.line(to: CGPoint(x: cx - 4, y: cy))
                chevron.line(to: CGPoint(x: cx + 4, y: cy + 8))
            } else {
                chevron.move(to: CGPoint(x: cx - 4, y: cy - 8))
                chevron.line(to: CGPoint(x: cx + 4, y: cy))
                chevron.line(to: CGPoint(x: cx - 4, y: cy + 8))
            }
        case .vertical:
            if atStart {
                chevron.move(to: CGPoint(x: cx - 8, y: cy + 4))
                chevron.line(to: CGPoint(x: cx, y: cy - 4))
                chevron.line(to: CGPoint(x: cx + 8, y: cy + 4))
            } else {
                chevron.move(to: CGPoint(x: cx - 8, y: cy - 4))
                chevron.line(to: CGPoint(x: cx, y: cy + 4))
                chevron.line(to: CGPoint(x: cx + 8, y: cy - 4))
            }
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

    // The handle lives in a borderless non-activating panel. Without this,
    // the first click on the rocket is spent making the panel key and the
    // toggle only fires on the second click. The sibling pills (dictation,
    // terminal) override this for the same reason.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

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
    var axis: Config.SpaceAgentLayout = .horizontal {
        didSet { tileViews.forEach { $0.style = tileStyle } }
    }
    // Horizontal-strip card metrics.
    var tileSize = CGSize(width: 128, height: 80)
    var tileSpacing: CGFloat = 8
    // Vertical-list row metrics.
    var rowHeight: CGFloat = 52
    var rowSpacing: CGFloat = 6
    var onSelectDelta: ((Int) -> Void)?
    private var tileViews: [SpaceAgentTileView] = []
    private var renderedSpaceIds: [UInt64] = []
    private var renderedActiveSpaceId: UInt64?

    private var tileStyle: SpaceAgentTileView.Style {
        axis == .vertical ? .row : .card
    }

    override var isFlipped: Bool { true }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        tileViews.forEach { $0.needsDisplay = true }
        needsDisplay = true
    }

    // The vertical list's rows span the clip width, so a clip-bounds change
    // (panel resize) must re-flow them. The horizontal strip's cards are a
    // fixed width and ignore this.
    func clipBoundsChanged() {
        guard axis == .vertical else { return }
        needsLayout = true
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
            view.style = tileStyle
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
        switch axis {
        case .horizontal:
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
        case .vertical:
            // Rows fill the clip width (document width follows the viewport so
            // there is no horizontal scroll), stacked top to bottom.
            let width = enclosingScrollView?.contentView.bounds.width ?? bounds.width
            var y: CGFloat = 0
            for view in tileViews {
                view.frame = CGRect(x: 0, y: y, width: width, height: rowHeight)
                y += rowHeight + rowSpacing
            }
        }
    }

    private func resizeDocument(for tileCount: Int) {
        switch axis {
        case .horizontal:
            let width = CGFloat(tileCount) * tileSize.width
                + CGFloat(max(0, tileCount - 1)) * tileSpacing
            let height = tileSize.height + SpaceAgentTileView.labelHeight
            frame = CGRect(origin: .zero, size: CGSize(width: max(0, width), height: height))
        case .vertical:
            let width = enclosingScrollView?.contentView.bounds.width ?? bounds.width
            let height = CGFloat(tileCount) * rowHeight
                + CGFloat(max(0, tileCount - 1)) * rowSpacing
            frame = CGRect(origin: .zero, size: CGSize(width: max(0, width), height: max(0, height)))
        }
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
    // Vertical-list row metrics: a thumbnail on the left, caption to its right.
    static let rowThumbnailSize = CGSize(width: 64, height: 40)
    static let rowContentInset: CGFloat = 6
    static let rowThumbnailToTextGap: CGFloat = 10

    // .card is the horizontal Spotify-style cover-art tile; .row is the vertical
    // list item (thumbnail left, name + subtitle right).
    enum Style {
        case card
        case row
    }
    var style: Style = .card {
        didSet {
            guard oldValue != style else { return }
            needsDisplay = true
        }
    }

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

    // The tiles live in the same borderless non-activating panel as the rocket.
    // Now that the persistent sidebar stays non-key, the first click on a tile
    // would otherwise be spent making the panel key, so switching desktops took
    // two clicks. Accepting the first mouse makes a single click switch.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

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
        switch style {
        case .card:
            drawCard(tile: tile, palette: palette)
        case .row:
            drawRow(tile: tile, palette: palette)
        }
    }

    private func surfaceColor(for tile: SpaceAgentTile, palette: SpaceAgentPalette) -> NSColor {
        if tile.isActive {
            return palette.activeTileFill
        } else if tile.isSelected || isHovered {
            return palette.tileFillHover
        } else {
            return palette.tileFill
        }
    }

    private func drawCard(tile: SpaceAgentTile, palette: SpaceAgentPalette) {
        // Card surface. Lightens on hover (paired with the shadow lift in
        // updateElevation); a faint accent wash marks the active desktop.
        let card = NSBezierPath(
            roundedRect: bounds,
            xRadius: Self.cardCornerRadius,
            yRadius: Self.cardCornerRadius
        )
        surfaceColor(for: tile, palette: palette).setFill()
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
        let primaryString: NSAttributedString
        let prefix = tile.highlightPrefix
        if !prefix.isEmpty, tile.title.lowercased().hasPrefix(prefix.lowercased()) {
            let prefixLen = min(prefix.count, tile.title.count)
            let matchedPart = String(tile.title.prefix(prefixLen))
            let restPart = String(tile.title.dropFirst(prefixLen))
            let highlightAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 14, weight: .bold),
                .foregroundColor: NSColor.controlAccentColor,
                .paragraphStyle: leftPara,
                .kern: -0.1
            ]
            let attributed = NSMutableAttributedString(string: matchedPart, attributes: highlightAttrs)
            attributed.append(NSAttributedString(string: restPart, attributes: primaryAttrs))
            primaryString = attributed
        } else {
            primaryString = NSAttributedString(string: tile.title, attributes: primaryAttrs)
        }
        primaryString.draw(in: primaryRect)

        guard !tile.secondary.isEmpty else { return }
        let secondaryRect = CGRect(
            x: captionLeft,
            y: primaryRect.maxY + Self.primaryToSecondaryGap,
            width: captionWidth,
            height: Self.secondaryRowHeight
        )
        NSAttributedString(string: tile.secondary, attributes: secondaryAttrs).draw(in: secondaryRect)
    }

    // Vertical-list row: rounded surface, a thumbnail on the left (number badge
    // in its corner), and the title + subtitle stacked to its right.
    private func drawRow(tile: SpaceAgentTile, palette: SpaceAgentPalette) {
        let row = NSBezierPath(
            roundedRect: bounds,
            xRadius: Self.cardCornerRadius,
            yRadius: Self.cardCornerRadius
        )
        surfaceColor(for: tile, palette: palette).setFill()
        row.fill()

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

        let inset = Self.rowContentInset
        let thumbSize = Self.rowThumbnailSize
        let thumbRect = CGRect(
            x: inset,
            y: (bounds.height - thumbSize.height) / 2,
            width: thumbSize.width,
            height: thumbSize.height
        )
        let thumbPath = NSBezierPath(roundedRect: thumbRect, xRadius: 6, yRadius: 6)
        NSGraphicsContext.saveGraphicsState()
        thumbPath.addClip()
        palette.thumbnailFill.setFill()
        thumbRect.fill()
        if let data = tile.thumbnail, let image = NSImage(data: data) {
            NSGraphicsContext.current?.imageInterpolation = .high
            image.draw(in: thumbRect, from: .zero, operation: .sourceOver, fraction: 1)
        } else {
            drawPlaceholder(in: thumbRect, active: tile.isActive, palette: palette)
        }
        NSGraphicsContext.restoreGraphicsState()
        drawDesktopNumber(in: thumbRect, tile: tile)

        let textLeft = thumbRect.maxX + Self.rowThumbnailToTextGap
        let textWidth = max(0, bounds.width - textLeft - inset)
        guard textWidth > 0 else { return }

        let para = NSMutableParagraphStyle()
        para.alignment = .left
        para.lineBreakMode = .byTruncatingTail
        let primaryAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 13, weight: .semibold),
            .foregroundColor: tile.isActive
                ? NSColor.controlAccentColor
                : palette.primaryText.withAlphaComponent(0.96),
            .paragraphStyle: para,
            .kern: -0.1
        ]
        let secondaryAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 11, weight: .regular),
            .foregroundColor: palette.secondaryText.withAlphaComponent(tile.isActive ? 0.9 : 0.7),
            .paragraphStyle: para
        ]

        // Center the one- or two-line caption block against the thumbnail.
        let hasSecondary = !tile.secondary.isEmpty
        let primaryH: CGFloat = 17
        let secondaryH: CGFloat = 14
        let gap: CGFloat = hasSecondary ? 2 : 0
        let blockH = primaryH + (hasSecondary ? secondaryH + gap : 0)
        var y = (bounds.height - blockH) / 2

        let primaryRect = CGRect(x: textLeft, y: y, width: textWidth, height: primaryH)
        let prefix = tile.highlightPrefix
        if !prefix.isEmpty, tile.title.lowercased().hasPrefix(prefix.lowercased()) {
            let prefixLen = min(prefix.count, tile.title.count)
            let matched = String(tile.title.prefix(prefixLen))
            let rest = String(tile.title.dropFirst(prefixLen))
            var highlightAttrs = primaryAttrs
            highlightAttrs[.foregroundColor] = NSColor.controlAccentColor
            let attributed = NSMutableAttributedString(string: matched, attributes: highlightAttrs)
            attributed.append(NSAttributedString(string: rest, attributes: primaryAttrs))
            attributed.draw(in: primaryRect)
        } else {
            NSAttributedString(string: tile.title, attributes: primaryAttrs).draw(in: primaryRect)
        }

        guard hasSecondary else { return }
        y += primaryH + gap
        let secondaryRect = CGRect(x: textLeft, y: y, width: textWidth, height: secondaryH)
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

// Pill token that appears in the search bar when the palette is opened via
// the Hyper quick-switch (i.e. the search mode is "startsWith", not a
// free-text word match). Non-interactive; the search field sits to its right.
final class SpaceAgentSearchTokenView: NSView {
    private let label = "startsWith"

    // Intrinsic pill width for layout.
    var measuredWidth: CGFloat {
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 11, weight: .medium)
        ]
        return ceil((label as NSString).size(withAttributes: attrs).width) + 14
    }

    override var isFlipped: Bool { true }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        let pill = NSBezierPath(
            roundedRect: bounds.insetBy(dx: 0, dy: 3),
            xRadius: 4, yRadius: 4
        )
        NSColor.controlAccentColor.withAlphaComponent(0.85).setFill()
        pill.fill()

        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 11, weight: .medium),
            .foregroundColor: NSColor.white
        ]
        let size = (label as NSString).size(withAttributes: attrs)
        let textRect = CGRect(
            x: (bounds.width - size.width) / 2,
            y: bounds.minY + 3 + (bounds.height - 6 - size.height) / 2,
            width: size.width,
            height: size.height
        )
        (label as NSString).draw(in: textRect, withAttributes: attrs)
    }
}

private extension Int {
    var cgFloat: CGFloat { CGFloat(self) }
}
