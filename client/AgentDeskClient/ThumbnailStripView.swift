import UIKit
import AgentDeskWire

@MainActor
protocol DisplayRailViewDelegate: AnyObject {
    func displayRail(_ view: DisplayRailView, didSelectDisplayId displayId: String)
}

@MainActor
final class DisplayRailView: UIView {
    weak var delegate: DisplayRailViewDelegate?

    private let stack = UIStackView()
    private var displays: [DisplayMetadata] = []
    private var selectedDisplayId: String?

    var displayCount: Int { displays.count }

    override init(frame: CGRect) {
        super.init(frame: frame)
        configure()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        configure()
    }

    private func configure() {
        accessibilityIdentifier = "display-rail"
        isHidden = true
        stack.axis = .horizontal
        stack.spacing = 8
        stack.distribution = .fillEqually
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor)
        ])
    }

    func apply(state: DesktopState) {
        displays = state.displays
        selectedDisplayId = state.selectedDisplayId ?? state.activeDisplayId ?? state.displays.first?.id
        render()
    }

    func renderEmpty() {
        displays = []
        selectedDisplayId = nil
        render()
    }

    private func render() {
        stack.arrangedSubviews.forEach { view in
            stack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        isHidden = displays.count <= 1
        for (idx, display) in displays.enumerated() {
            let button = UIButton(type: .system)
            button.titleLabel?.font = .preferredFont(forTextStyle: .caption1)
            button.titleLabel?.adjustsFontSizeToFitWidth = true
            button.titleLabel?.minimumScaleFactor = 0.75
            button.setTitle(Self.title(for: display, fallbackIndex: idx), for: .normal)
            button.layer.cornerRadius = 8
            button.layer.borderWidth = 1
            button.layer.borderColor = UIColor.separator.cgColor
            button.backgroundColor = display.id == selectedDisplayId ? UIColor.tintColor.withAlphaComponent(0.16) : UIColor.secondarySystemBackground
            button.accessibilityIdentifier = "display-rail-\(idx)"
            button.tag = idx
            button.addTarget(self, action: #selector(selectDisplay(_:)), for: .touchUpInside)
            stack.addArrangedSubview(button)
        }
    }

    @objc private func selectDisplay(_ sender: UIButton) {
        guard sender.tag >= 0, sender.tag < displays.count else { return }
        let displayId = displays[sender.tag].id
        guard displayId != selectedDisplayId else { return }
        selectedDisplayId = displayId
        render()
        delegate?.displayRail(self, didSelectDisplayId: displayId)
    }

    static func title(for display: DisplayMetadata, fallbackIndex: Int) -> String {
        let trimmed = display.label.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { return trimmed }
        return display.isMain ? "Main" : "Display \(fallbackIndex + 1)"
    }
}

// Spaces strip. Horizontal UICollectionView of one cell per non-fullscreen
// user Space on the selected display.
//
// The strip is on-demand. At rest it is a 26pt bar carrying nothing but a leading chevron;
// opening it grows that same bar into the tile row, with the chevron still leading and now
// the way back out. Nothing is stacked: the bar does not become a second row above the
// tiles, so opening costs exactly the tile row and closing gives all of it back. The fill
// is the strip's own, so the two states are one surface growing, not a bar swapped for a
// row of loose tiles.
//
// The open row takes one of two tile shapes, chosen by the Space-previews setting:
//
// - Compact: 52x30 "D1 D2" pills. The shape when previews are off, because with capture
//   disabled host-side the preview tile spends 56pt drawing an empty box and a caption for
//   a picture that will never arrive.
//
// - Preview: the full 88x92 tile with image and two-row caption, when the host is capturing.
//
// Closed, the tiles are gone, so tap-to-jump and swipe-to-commit are unavailable until the
// strip is opened. That is the deliberate cost of the bar: Desktop switching from the strip
// is on demand, and the trackpad's own Space gestures are unaffected.
//
// Within either shape there are two layout modes:
//
// - Fits: all tiles fit in the strip's bounds. Spacing expands so the
//   row spans from the strip's leading edge to its trailing edge.
//   Scroll is still enabled (alwaysBounceHorizontal) so a drag bounces
//   off the edges and fires scroll-view callbacks; the strip emits
//   .switchSpaceGesture frames the same way as overflow mode, the
//   landing offset just snaps back to 0 on release.
//
// - Overflow: more tiles than fit. Cells use the default 8pt spacing
//   and the row scrolls horizontally. The partial-cut tiles at the
//   leading and trailing edges of the visible window are the cue that
//   more exists. The active tile is scrolled into view (centered when
//   possible); the host-side commit math hasn't changed.
//
// Selection is per-cell: ThumbnailTileCell flips its own border colour
// when active. The previous floating overlay approach was wrong because
// it pinned the selection to the strip's centerX even when the active
// tile was elsewhere.
//
// Gesture wire is unchanged. Scroll began/scroll/end map onto
// .switchSpaceGesture(.began/.changed/.ended); the host's
// InputDispatcher posts one dock-swipe CGEvent per frame.

@MainActor
protocol ThumbnailStripViewDelegate: AnyObject {
    func thumbnailStrip(_ view: ThumbnailStripView, didTapStepDelta delta: Int)
    func thumbnailStrip(_ view: ThumbnailStripView, didLongPressSpaceId spaceId: UInt64)
    func thumbnailStrip(_ view: ThumbnailStripView, didProduce input: NormalizedInput)
    // The strip's `preferredHeight` changed, through expansion or through the previews
    // setting swapping the tile shape. Same seam as the window picker below it: the height
    // constraint belongs to the layout owner.
    func thumbnailStripDidChangePreferredHeight(_ view: ThumbnailStripView)
    // The user tapped the bar. Distinct from the height report because the strip is also
    // collapsed by the layout owner (keyboard up, strip hidden, teardown), and only a
    // deliberate tap should be remembered as the preferred resting state.
    func thumbnailStripDidToggleExpansion(_ view: ThumbnailStripView)
}

@MainActor
final class ThumbnailStripView: UIView {
    weak var delegate: ThumbnailStripViewDelegate?

    // Tile sized to give the caption enough room for the Spotify-style
    // hierarchy (11pt semibold title + 9pt regular subtitle, both
    // left-aligned). Wider than the original 64pt strip: density drops
    // from ~5 tiles to ~4 visible on a standard phone screen, in
    // exchange for legible captions and a stable two-row baseline.
    static let tileWidth: CGFloat = 88
    static let tileHeight: CGFloat = 56
    static let tileCaptionHeight: CGFloat = 36
    static let previewRowHeight: CGFloat = tileHeight + tileCaptionHeight
    // Compact pills, used when Space previews are off. With capture disabled host-side there
    // is no image to show, and the preview tile spends 56pt drawing an empty box plus a
    // caption for a picture that will never arrive. The pill is the Desktop number and
    // nothing else, which is all the strip can honestly say in that mode.
    static let compactTileWidth: CGFloat = 52
    static let compactRowHeight: CGFloat = 30
    static let defaultTileSpacing: CGFloat = 10

    // The closed bar. Tall enough to be a comfortable target across its full width (the whole
    // bar toggles, not just the chevron glyph) and short enough to read as a sliver.
    static let barHeight: CGFloat = 26
    // Breathing room above and below the open tile row. Without it the row is flush against
    // the strip's clipped edges and the active tile's 1.5pt selection border is shaved off
    // top and bottom, which reads as the blue box being cut in half.
    static let rowVerticalPadding: CGFloat = 3
    // The chevron and the identifying glyph lead the row in both states, so the disclosure
    // control costs no vertical space: open, they sit beside the tiles rather than above them.
    static let chevronWidth: CGFloat = 16
    static let iconWidth: CGFloat = 20
    static let leadColumnWidth: CGFloat = chevronWidth + iconWidth
    static let leadColumnGap: CGFloat = 4

    // False (default, toggle OFF) inverts the wire-level sign so
    // finger-right maps to the Space on the LEFT (scrollbar reading).
    // True passes through (macOS-native trackpad direction).
    var useMacOSDirection: Bool = false

    // Mirrors SettingsStore.showSpacePreviews, which gates thumbnail CAPTURE host-side.
    // Default false to match that setting's own default, so a strip that is built before the
    // first settings push does not flash preview-shaped tiles it will never fill.
    // Chooses the shape of the OPEN row only. It does not gate opening: closed is a bar in
    // both modes, and open is a useful row in both (pills without capture, preview tiles
    // with it). Flipping it while open swaps the tiles in place and re-reports the height.
    var showsPreviews: Bool = false {
        didSet {
            guard oldValue != showsPreviews else { return }
            applyTileMode()
        }
    }

    private(set) var isExpanded = false

    private lazy var layout: UICollectionViewFlowLayout = {
        let l = UICollectionViewFlowLayout()
        l.scrollDirection = .horizontal
        l.itemSize = CGSize(width: Self.compactTileWidth, height: Self.compactRowHeight)
        l.minimumLineSpacing = Self.defaultTileSpacing
        l.minimumInteritemSpacing = 0
        l.sectionInset = .zero
        return l
    }()

    private lazy var collectionView: UICollectionView = {
        let cv = UICollectionView(frame: .zero, collectionViewLayout: layout)
        cv.backgroundColor = .clear
        cv.showsHorizontalScrollIndicator = false
        cv.showsVerticalScrollIndicator = false
        cv.decelerationRate = .fast
        // Always-bounce + always-scroll-enabled so the swipe-to-commit
        // pan fires even when all tiles fit in the strip (fits mode).
        // Without this, isScrollEnabled would be false in fits mode and
        // drags on the strip would do nothing, which surfaces any time
        // the active-display Space count is small enough or the screen
        // wide enough that the tiles don't overflow.
        cv.alwaysBounceHorizontal = true
        // The strip lives in the middle of the view, not at edges; no
        // auto-adjustment of insets behind our back.
        cv.contentInsetAdjustmentBehavior = .never
        cv.dataSource = self
        cv.delegate = self
        cv.register(ThumbnailTileCell.self, forCellWithReuseIdentifier: ThumbnailTileCell.reuseId)
        cv.translatesAutoresizingMaskIntoConstraints = false
        return cv
    }()

    // Floating selection indicator. Lives in the strip's coordinate
    // space (sibling of collectionView, not inside it), so it stays
    // put while the cells scroll past during a drag. That stationary
    // behaviour is what gives the "half-on-current, half-on-next"
    // overlap visual as the user slides between Spaces. After a
    // commit the overlay slides to the new active cell's resting
    // position; in Fits mode where active can be anywhere along the
    // row, that motion is the only thing that moves.
    private lazy var selectionOverlay: UIView = {
        let v = UIView()
        v.backgroundColor = .clear
        v.layer.cornerRadius = 6
        v.layer.borderColor = UIColor.tintColor.cgColor
        v.layer.borderWidth = 1.5
        v.isUserInteractionEnabled = false
        v.isHidden = true
        return v
    }()

    // Holds the collection view and the selection overlay. The overlay is positioned from
    // collection-content coordinates, so keeping both inside one container means the lead
    // column's width never has to be folded into that math. Its leading inset is a fixed
    // constant rather than a chain off the bar, because the bar's own width moves.
    private let contentContainer = UIView()
    // The disclosure control. Closed it spans the strip, so the whole bar is the target;
    // open it shrinks to the lead column at the leading edge and the tiles take the rest.
    private let barButton = UIControl()
    private let chevronView = UIImageView()
    private let barIcon = UIImageView()
    private var barTrailingConstraint: NSLayoutConstraint?
    private var barWidthConstraint: NSLayoutConstraint?

    private var orderedSpaces: [SpaceMetadata] = []
    private var activeSpaceId: UInt64?
    private var thumbnails: [String: String] = [:]
    private var topWindows: [String: SpaceTopWindow] = [:]
    private var isProgrammaticScroll: Bool = false
    private var isDragging: Bool = false
    // contentOffset at which the active cell is at its resting
    // position. Drag progress is measured relative to this.
    private var activeRestingOffsetX: CGFloat = 0
    private var lastBoundsWidth: CGFloat = 0
    private var lastTileCount: Int = -1
    // Height last handed to the delegate. `preferredHeight` is derived from two independent
    // inputs (open state, tile shape), so the change test compares the reported value rather
    // than any one of them.
    private var lastReportedHeight: CGFloat = ThumbnailStripView.barHeight
    // Set by previewActiveTransition for the duration of a multi-step
    // tap-jump chain. While non-nil, apply(state:) skips its overlay
    // re-animation so the in-flight single glide isn't interrupted by
    // each intermediate Dock commit. Cleared when the host's state
    // catches up to the predicted target, or by the safety timer below.
    private var pendingPreviewIndex: Int?
    private var previewClearWorkItem: DispatchWorkItem?

    // Fraction of the strip width past which a drag is treated as a
    // commit on its own. Half a strip's worth: drag past 50% and rest
    // there to commit; drag past 50% and return below before release
    // to cancel. The cancel path uses .cancelled phase so Dock truly
    // abandons the in-flight gesture instead of committing at last
    // progress.
    private static let commitThreshold: CGFloat = 0.5
    // Pan velocity (pt/sec) past which a flick commits even if the
    // user didn't drag past the distance threshold. Tuned to feel
    // like an iOS paging flick: an intentional flick is in the
    // 800-2000 range, casual scroll inertia is below 500.
    private static let commitVelocity: CGFloat = 800

    override init(frame: CGRect) {
        super.init(frame: frame)
        configure()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        configure()
    }

    private func configure() {
        // The fill belongs to the strip rather than the bar control, so the open row is one
        // continuous surface instead of tiles floating on nothing. Closed there is nothing
        // in it to back, and a full-width empty band reads as a label that failed to load,
        // so the fill is applied per state in applyExpansionChrome.
        layer.cornerRadius = 8
        accessibilityIdentifier = "thumbnail-strip"
        isUserInteractionEnabled = true
        // Opening unhides the full-height tile row before the strip has finished growing to
        // hold it, so the overhang has to be clipped for the duration of the animation.
        clipsToBounds = true

        contentContainer.translatesAutoresizingMaskIntoConstraints = false
        addSubview(contentContainer)
        contentContainer.addSubview(collectionView)
        contentContainer.addSubview(selectionOverlay)

        // Added after the container so the closed bar sits above the (hidden) tile row. It
        // carries no fill of its own in either state; the strip behind it is the bar.
        barButton.translatesAutoresizingMaskIntoConstraints = false
        barButton.accessibilityIdentifier = "thumbnail-strip-disclosure"
        barButton.addTarget(self, action: #selector(toggleExpansion), for: .touchUpInside)
        addSubview(barButton)

        chevronView.tintColor = .secondaryLabel
        chevronView.contentMode = .center
        chevronView.preferredSymbolConfiguration = UIImage.SymbolConfiguration(
            pointSize: 11, weight: .semibold
        )
        chevronView.translatesAutoresizingMaskIntoConstraints = false
        barButton.addSubview(chevronView)

        // Two closed slivers stacked one above the other are indistinguishable by a chevron
        // alone, so each carries the glyph for what it opens: desktops here, a window in the
        // picker below.
        barIcon.contentMode = .center
        barIcon.tintColor = .secondaryLabel
        barIcon.image = UIImage(systemName: "rectangle.3.group")
        barIcon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(
            pointSize: 12, weight: .regular
        )
        barIcon.translatesAutoresizingMaskIntoConstraints = false
        barButton.addSubview(barIcon)

        let barTrailing = barButton.trailingAnchor.constraint(equalTo: trailingAnchor)
        let barWidth = barButton.widthAnchor.constraint(equalToConstant: Self.leadColumnWidth)
        barTrailingConstraint = barTrailing
        barWidthConstraint = barWidth
        barTrailing.isActive = true
        NSLayoutConstraint.activate([
            barButton.leadingAnchor.constraint(equalTo: leadingAnchor),
            barButton.topAnchor.constraint(equalTo: topAnchor),
            // Full-height rather than centred on the bar's own height: open, this column is
            // the way back out, and a 36x26 target floating beside a 92pt tile row is easy
            // to miss.
            barButton.bottomAnchor.constraint(equalTo: bottomAnchor),

            chevronView.leadingAnchor.constraint(equalTo: barButton.leadingAnchor),
            chevronView.widthAnchor.constraint(equalToConstant: Self.chevronWidth),
            chevronView.topAnchor.constraint(equalTo: barButton.topAnchor),
            chevronView.bottomAnchor.constraint(equalTo: barButton.bottomAnchor),

            barIcon.leadingAnchor.constraint(equalTo: chevronView.trailingAnchor),
            barIcon.widthAnchor.constraint(equalToConstant: Self.iconWidth),
            barIcon.topAnchor.constraint(equalTo: barButton.topAnchor),
            barIcon.bottomAnchor.constraint(equalTo: barButton.bottomAnchor),

            // Fixed inset, not a chain off the bar: the bar spans the strip while closed,
            // and anchoring the row to its trailing edge would collapse the row to nothing.
            contentContainer.leadingAnchor.constraint(
                equalTo: leadingAnchor, constant: Self.leadColumnWidth + Self.leadColumnGap
            ),
            contentContainer.trailingAnchor.constraint(equalTo: trailingAnchor),
            contentContainer.topAnchor.constraint(
                equalTo: topAnchor, constant: Self.rowVerticalPadding
            ),
            contentContainer.bottomAnchor.constraint(
                equalTo: bottomAnchor, constant: -Self.rowVerticalPadding
            ),

            collectionView.leadingAnchor.constraint(equalTo: contentContainer.leadingAnchor),
            collectionView.trailingAnchor.constraint(equalTo: contentContainer.trailingAnchor),
            collectionView.topAnchor.constraint(equalTo: contentContainer.topAnchor),
            collectionView.bottomAnchor.constraint(equalTo: contentContainer.bottomAnchor)
        ])

        let longPress = UILongPressGestureRecognizer(target: self, action: #selector(handleLongPress(_:)))
        longPress.minimumPressDuration = 0.4
        collectionView.addGestureRecognizer(longPress)

        isHidden = true
        applyTileMode(notifyHeightChange: false)
    }

    // The row's resting layout, computed rather than read back. Nothing here depends on the
    // strip's height, which is the only thing the expand animation moves, so this is already
    // truthful while the strip is still closed. See ThumbnailStripGeometry.
    private var rowGeometry: ThumbnailStripGeometry {
        ThumbnailStripGeometry(
            tileCount: orderedSpaces.count,
            tileWidth: currentTileWidth,
            tileHeight: contentRowHeight,
            spacing: Self.defaultTileSpacing,
            viewportWidth: contentContainer.bounds.width
        )
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        // Recompute layout mode whenever the row's width or tile count change. Height is not
        // an input: it is the axis the expand animation moves along, and the row math is
        // deliberately independent of it.
        let needsRelayout = lastBoundsWidth != contentContainer.bounds.width
            || lastTileCount != orderedSpaces.count
        if needsRelayout {
            applyLayoutMode()
            lastBoundsWidth = contentContainer.bounds.width
            lastTileCount = orderedSpaces.count
            collectionView.layoutIfNeeded()
            recenterOnActive(animated: false)
            updateSelectionOverlayFrame(animated: false)
        }
    }

    // Picks the layout mode for the current bounds and tile count:
    //   - Fits: default 8pt spacing, the whole tile row centered as a
    //     block via sectionInset. Two desktops sit side-by-side in the
    //     middle; five desktops are still tight in the middle with
    //     extra empty space on either side.
    //   - Overflow: sectionInset collapses to zero; the row scrolls, and
    //     partial-cut tiles at the edges indicate "more exists".
    private func applyLayoutMode() {
        let geometry = rowGeometry
        guard geometry.isUsable else { return }
        layout.minimumLineSpacing = geometry.spacing
        layout.sectionInset = UIEdgeInsets(
            top: 0, left: geometry.sectionInset, bottom: 0, right: geometry.sectionInset
        )
        layout.invalidateLayout()
        // Scroll stays enabled in both modes. In fits mode, drags
        // bounce off the contentSize edges and snap back to 0 on
        // release, but the scroll-view delegate methods still fire
        // and the strip's switchSpace emission goes out as normal.
    }

    // MARK: - Tile mode and expansion

    // Preview tiles only when the strip is open AND the host is actually capturing. Closed,
    // the row is not on screen at all, so it is sized for the cheaper shape.
    var showsPreviewTiles: Bool { showsPreviews && isExpanded }
    var currentTileWidth: CGFloat { showsPreviewTiles ? Self.tileWidth : Self.compactTileWidth }
    var contentRowHeight: CGFloat { showsPreviewTiles ? Self.previewRowHeight : Self.compactRowHeight }

    // Closed the strip is the bar and nothing else; open it is the tile row plus its padding,
    // since the bar becomes that row's leading chevron rather than a band above it.
    var preferredHeight: CGFloat {
        isExpanded ? contentRowHeight + Self.rowVerticalPadding * 2 : Self.barHeight
    }

    private func applyTileMode(notifyHeightChange: Bool = true) {
        let previous = lastReportedHeight
        layout.itemSize = CGSize(width: currentTileWidth, height: contentRowHeight)
        applyExpansionChrome()
        collectionView.reloadData()
        applyLayoutMode()
        lastTileCount = orderedSpaces.count
        collectionView.layoutIfNeeded()
        recenterOnActive(animated: false)
        updateSelectionOverlayFrame(animated: false)
        lastReportedHeight = preferredHeight
        if notifyHeightChange, previous != preferredHeight {
            // The indicator is already on the active tile above, before the layout owner has
            // been told to grow us, so the height animation reveals it in position instead of
            // moving it.
            delegate?.thumbnailStripDidChangePreferredHeight(self)
        }
    }

    @objc private func toggleExpansion() {
        setExpanded(!isExpanded)
        delegate?.thumbnailStripDidToggleExpansion(self)
    }

    func setExpanded(_ expanded: Bool) {
        guard expanded != isExpanded else { return }
        isExpanded = expanded
        applyTileMode()
    }

    private func applyExpansionChrome() {
        // Closed, the bar spans the strip so the whole sliver is the target. Open, it yields
        // everything past the lead column to the tiles. It stays transparent either way:
        // closed, the chevron and glyph alone are the visible control, so the row is not a
        // wide empty band and the generous target costs nothing to look at.
        barTrailingConstraint?.isActive = !isExpanded
        barWidthConstraint?.isActive = isExpanded
        backgroundColor = isExpanded ? .secondarySystemFill : .clear
        // Hidden rather than merely off-screen: a closed strip must not eat taps meant for
        // the surface below it, and the row is clipped mid-animation either way.
        contentContainer.isHidden = !isExpanded
        chevronView.image = UIImage(
            systemName: isExpanded ? "chevron.down" : "chevron.right"
        )
        barButton.accessibilityLabel = isExpanded ? "Hide Desktops" : "Show Desktops"
        // The tile row's available width can change with the bar. `layoutSubviews` re-derives
        // the fits/overflow split from the container's width, so let it run rather than
        // computing the centering inset against the width the row had a moment ago.
        setNeedsLayout()
    }

    // MARK: - Public state surface

    func apply(state: DesktopState) {
        guard let displayId = Self.displayIdToRender(from: state) else {
            renderEmpty()
            return
        }
        let userSpaces = state.spaces
            .filter { $0.displayId == displayId && $0.type == 0 }
            .sorted { ($0.index ?? Int.max) < ($1.index ?? Int.max) }
        let countChanged = userSpaces.map { $0.id } != orderedSpaces.map { $0.id }
        orderedSpaces = userSpaces
        activeSpaceId = state.activeSpaceId

        if countChanged {
            collectionView.reloadData()
            // Re-derive layout mode for the new count.
            applyLayoutMode()
            lastTileCount = orderedSpaces.count
        } else {
            // Re-render visible cells so their active-state border
            // tracks the new activeSpaceId.
            for ip in collectionView.indexPathsForVisibleItems {
                if let cell = collectionView.cellForItem(at: ip) as? ThumbnailTileCell {
                    configureCell(cell, atIndex: ip.item)
                }
            }
        }
        collectionView.layoutIfNeeded()
        // If a multi-step preview is in flight, only re-sync the overlay
        // once the host's actual activeIndex has caught up to (or past)
        // the predicted target. Intermediate state arrivals (one per
        // Dock commit in the chain) skip the re-animation so the single
        // smooth glide started by previewActiveTransition isn't broken
        // into per-commit hops.
        if let pending = pendingPreviewIndex {
            if activeIndex == pending || countChanged {
                pendingPreviewIndex = nil
                previewClearWorkItem?.cancel()
                previewClearWorkItem = nil
                recenterOnActive(animated: !countChanged)
                updateSelectionOverlayFrame(animated: !countChanged)
            }
            return
        }
        recenterOnActive(animated: !countChanged)
        updateSelectionOverlayFrame(animated: !countChanged)
    }

    func apply(thumbnails: [String: String]) {
        self.thumbnails = thumbnails
        for ip in collectionView.indexPathsForVisibleItems {
            if let cell = collectionView.cellForItem(at: ip) as? ThumbnailTileCell {
                configureCell(cell, atIndex: ip.item)
            }
        }
    }

    // Update per-space top-window metadata. Cells re-render their label
    // from this map using SpaceAgentLabelResolver, falling back to
    // "Desktop N" when a space has no captured top window.
    func apply(topWindows: [String: SpaceTopWindow]) {
        self.topWindows = topWindows
        for ip in collectionView.indexPathsForVisibleItems {
            if let cell = collectionView.cellForItem(at: ip) as? ThumbnailTileCell {
                configureCell(cell, atIndex: ip.item)
            }
        }
    }

    func renderEmpty() {
        orderedSpaces = []
        activeSpaceId = nil
        thumbnails = [:]
        topWindows = [:]
        collectionView.reloadData()
        lastTileCount = 0
        selectionOverlay.isHidden = true
        pendingPreviewIndex = nil
        previewClearWorkItem?.cancel()
        previewClearWorkItem = nil
        setExpanded(false)
    }

    // Predict the final tile for a tap-jump and slide the selection
    // overlay directly there in a single continuous animation. Used by
    // the tap-step handler so a multi-step jump (e.g. Desktop 5 -> 1)
    // looks like one smooth glide instead of hopping per Dock commit.
    // While the preview is active, apply(state:) suppresses its own
    // overlay re-animation for intermediate states (see pendingPreview-
    // Index handling there); a safety timer clears the lock if the
    // chain stalls so the overlay always resyncs to truth eventually.
    func previewActiveTransition(toIndex targetIdx: Int, duration: TimeInterval) {
        guard targetIdx >= 0, targetIdx < orderedSpaces.count else { return }
        // Closed there is no indicator on screen to glide.
        let geometry = rowGeometry
        guard isExpanded, geometry.isUsable else { return }

        let clampedOffset = geometry.restingOffsetX(for: targetIdx)
        activeRestingOffsetX = clampedOffset

        // Glide the scroll position (overflow mode) and overlay frame
        // in the same animation block so both motions share a curve
        // and finish together. In fits mode clampedOffset matches the
        // current contentOffset so setContentOffset is a no-op.
        let targetFrame = geometry.tileFrame(at: targetIdx, offsetBy: clampedOffset)
        let needsScroll = abs(collectionView.contentOffset.x - clampedOffset) >= 0.5
        if needsScroll {
            isProgrammaticScroll = true
        }
        UIView.animate(
            withDuration: duration,
            delay: 0,
            options: [.curveEaseInOut, .beginFromCurrentState],
            animations: {
                if needsScroll {
                    self.collectionView.setContentOffset(
                        CGPoint(x: clampedOffset, y: 0), animated: false
                    )
                }
                self.selectionOverlay.frame = targetFrame
                self.selectionOverlay.isHidden = false
            },
            completion: { _ in
                if needsScroll {
                    self.isProgrammaticScroll = false
                }
            }
        )

        pendingPreviewIndex = targetIdx
        previewClearWorkItem?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.pendingPreviewIndex = nil
            self.previewClearWorkItem = nil
            self.recenterOnActive(animated: true)
            self.updateSelectionOverlayFrame(animated: true)
        }
        previewClearWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + duration + 1.5, execute: work)
    }

    var userSpaceCount: Int { orderedSpaces.count }

    var activeIndex: Int? {
        guard let activeSpaceId else { return nil }
        return orderedSpaces.firstIndex { $0.id == activeSpaceId }
    }

    static func displayIdToRender(from state: DesktopState) -> String? {
        let available = Set(state.spaces.map(\.displayId))
        for candidate in [state.selectedDisplayId, state.activeDisplayId, state.displays.first?.id] {
            guard let candidate else { continue }
            if available.contains(candidate) { return candidate }
        }
        return available.sorted().first
    }

    // Test affordances.
    var renderedTileCount: Int { orderedSpaces.count }
    func tileSpaceIds() -> [UInt64] { orderedSpaces.map { $0.id } }

    // MARK: - Internals

    // Scrolls the active cell into view in Overflow mode. In Fits
    // mode the math collapses naturally: contentSize.width <=
    // bounds.width so maxOffset == 0 and the clamp lands at 0.
    private func recenterOnActive(animated: Bool) {
        let geometry = rowGeometry
        guard isExpanded, geometry.isUsable, let idx = activeIndex, idx < geometry.tileCount
        else { return }
        // Center the active cell in the visible window, clamped to
        // valid scroll bounds (UICollectionView clamps itself when
        // we hand it a target).
        let clamped = geometry.restingOffsetX(for: idx)
        activeRestingOffsetX = clamped
        if abs(collectionView.contentOffset.x - clamped) < 0.5 { return }
        isProgrammaticScroll = true
        if animated {
            collectionView.setContentOffset(CGPoint(x: clamped, y: 0), animated: true)
        } else {
            // Opening runs a height animation on our behalf, and a bare offset assignment
            // taken while it is in flight inherits it, drifting away from the indicator that
            // is already in place. Landing on the resting offset is not a motion.
            UIView.performWithoutAnimation {
                collectionView.setContentOffset(CGPoint(x: clamped, y: 0), animated: false)
            }
            isProgrammaticScroll = false
        }
    }

    fileprivate func configureCell(_ cell: ThumbnailTileCell, atIndex i: Int) {
        let space = orderedSpaces[i]
        let key = String(space.id)
        guard showsPreviewTiles else {
            // "D1", "D2". The agent label is deliberately dropped here rather than truncated
            // into a 52pt pill: a two-character Desktop number is legible, and half an app
            // name is not.
            cell.configureCompact(title: "D\(i + 1)")
            return
        }
        let image: UIImage? = {
            if let base64 = thumbnails[key],
               let data = Data(base64Encoded: base64),
               let img = UIImage(data: data) {
                return img
            }
            return nil
        }()
        let fallback = "Desktop \(i + 1)"
        let resolved = SpaceAgentLabelResolver.resolve(
            topWindow: topWindows[key],
            fallback: fallback
        )
        cell.configure(primary: resolved.primary, secondary: resolved.secondary, image: image)
    }

    // Position the floating indicator over the active cell's current
    // visible frame. Called only when the resting state could have
    // changed (layout pass, state apply); intentionally NOT called
    // from scrollViewDidScroll, so the indicator stays put while the
    // user drags. That stationary behaviour is what produces the
    // half-on-current / half-on-next overlap as cells scroll past.
    private func updateSelectionOverlayFrame(animated: Bool) {
        let geometry = rowGeometry
        guard isExpanded, geometry.isUsable, let idx = activeIndex, idx < geometry.tileCount
        else {
            selectionOverlay.isHidden = true
            return
        }
        // Computed from the row's own numbers rather than the flow layout's answer, so it is
        // right at the instant the strip starts opening instead of one animation later. The
        // offset subtracted is the one at which the active cell will REST, not the live
        // contentOffset.x: the live offset is often mid-animation when apply(state:) calls us
        // (the user's bounce is still decelerating, or recenterOnActive just kicked off
        // setContentOffset(animated: true)), so reading it produces a frame that lines up with
        // the cell only at the start of the animation, not at settlement.
        let target = geometry.tileFrame(at: idx, offsetBy: activeRestingOffsetX)
        let apply = {
            self.selectionOverlay.frame = target
            self.selectionOverlay.isHidden = false
        }
        if animated {
            UIView.animate(withDuration: 0.25, animations: apply)
        } else {
            // Placing the indicator is not a motion. Opening does its work inside a height
            // animation, and a bare frame assignment there inherits it, which is seen as the
            // indicator sliding in from wherever it last sat.
            UIView.performWithoutAnimation(apply)
        }
    }

    // MARK: - Long-press

    @objc private func handleLongPress(_ gr: UILongPressGestureRecognizer) {
        guard gr.state == .began else { return }
        let point = gr.location(in: collectionView)
        guard let ip = collectionView.indexPathForItem(at: point),
              ip.item < orderedSpaces.count else { return }
        delegate?.thumbnailStrip(self, didLongPressSpaceId: orderedSpaces[ip.item].id)
    }

    // MARK: - Gesture emission (pure functions, testable)

    // Maps a scroll offset onto the .switchSpaceGesture progress the
    // host expects. Old translation.x maps inversely to contentOffset:
    // dragging the finger RIGHT pulls content right, DECREASING
    // contentOffset.x. The "translation-equivalent" is therefore
    // -(currentOffset - resting). Progress is normalised to one
    // pageWidth (one tile + spacing) and clamped to [-1, 1].
    static func computeRawProgress(
        currentOffsetX: CGFloat,
        activeRestingOffsetX: CGFloat,
        pageWidth: CGFloat
    ) -> Float {
        guard pageWidth > 0 else { return 0 }
        let translation = -(currentOffsetX - activeRestingOffsetX)
        let raw = Float(translation / pageWidth)
        return min(max(raw, -1.0), 1.0)
    }

    // Dock reads progress=0 on a .changed frame as "no gesture in
    // progress" and drops it. Nudge to FLT_TRUE_MIN-sized away from
    // zero so the direction-required guard still passes when the
    // user's drag transits the resting position.
    static func nudgeAwayFromZero(_ progress: Float) -> Float {
        progress == 0 ? .leastNonzeroMagnitude : progress
    }

    // Internal, not private: scrollView delegate methods call this
    // in production and ThumbnailStripViewTests calls it directly to
    // exercise the sign-flip logic without spinning a real
    // UIScrollView.
    func emitSwipeFrame(phase: NormalizedInput.SwipePhase, rawProgress: Float, velocityX: CGFloat) {
        // Per AGENTS.md "Scroll and slide direction": the default
        // (useMacOSDirection=false) is OPPOSITE of Mac native. Finger
        // LEFT commits the right-neighbour Space, finger RIGHT commits
        // the left-neighbour. computeRawProgress returns negative for
        // finger-LEFT (drag positive in offset space, translation
        // negative), which is exactly the wire sign macOS Dock reads
        // as "next Space" under the user's trackpad setting -- so the
        // default passes through. The toggle inverts.
        // Verified on hardware 2026-05-24: with the default (iPhone-
        // opposite-of-Mac) toggle, the wire needs the inverse of the
        // raw progress sign for finger-LEFT to commit to the right-
        // neighbour Space. The Mac-native toggle leaves it passthrough.
        let signedProgress = useMacOSDirection ? rawProgress : -rawProgress
        let signedVelocity = Float(useMacOSDirection ? velocityX : -velocityX)
        delegate?.thumbnailStrip(self, didProduce: .switchSpaceGesture(
            phase: phase,
            progress: signedProgress,
            velocityX: signedVelocity
        ))
    }
}

// MARK: - UICollectionViewDataSource

extension ThumbnailStripView: UICollectionViewDataSource {
    func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
        orderedSpaces.count
    }

    func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
        let cell = collectionView.dequeueReusableCell(
            withReuseIdentifier: ThumbnailTileCell.reuseId, for: indexPath
        ) as! ThumbnailTileCell
        configureCell(cell, atIndex: indexPath.item)
        return cell
    }
}

// MARK: - UICollectionViewDelegate / UIScrollViewDelegate

extension ThumbnailStripView: UICollectionViewDelegate {
    func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
        guard let activeIdx = activeIndex, indexPath.item < orderedSpaces.count else { return }
        let delta = indexPath.item - activeIdx
        guard delta != 0 else { return }
        delegate?.thumbnailStrip(self, didTapStepDelta: delta)
    }

    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
        isDragging = true
        emitSwipeFrame(phase: .began, rawProgress: 0, velocityX: 0)
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        if isProgrammaticScroll || !isDragging { return }
        // Drag distance comes from the pan recognizer's translation
        // (the user's actual finger movement), NOT contentOffset.x.
        // In fits mode the scroll view bounces with built-in
        // resistance: a 300pt finger travel only nudges contentOffset
        // by ~70pt, which made the strip read 90%-visual drags as
        // 19% progress and never crossed the commit threshold.
        // pan.translation.x is the raw finger delta and gives a
        // proportional reading in both fits and overflow modes.
        let reference = max(1, bounds.width)
        let panTranslation = scrollView.panGestureRecognizer.translation(in: scrollView).x
        let raw = Self.computeRawProgress(
            currentOffsetX: -panTranslation,
            activeRestingOffsetX: 0,
            pageWidth: reference
        )
        let nudged = Self.nudgeAwayFromZero(raw)
        let velocity = scrollView.panGestureRecognizer.velocity(in: scrollView).x
        emitSwipeFrame(phase: .changed, rawProgress: nudged, velocityX: velocity)
    }

    // Predict commit / cancel and override targetContentOffset so the
    // strip snaps to the right resting position. Three buckets:
    //
    // - Drag past 50% of strip width: commit in the drag's direction.
    //   Velocity doesn't matter, the user clearly pushed it past.
    // - Drag short, but pan velocity past flick threshold AND in the
    //   same direction as the drag (or no drag, pure flick from
    //   rest): commit in the velocity's direction.
    // - Anything else (including a quick flick BACK after a peek,
    //   where drag and velocity point opposite ways): cancel.
    //
    // Sign convention: dragging the finger LEFT increases
    // contentOffset.x (positive drag in offset space) AND yields a
    // negative pan.velocity.x (finger-right is positive). We work in
    // "offset space" by negating pan velocity, so drag and offset-
    // velocity share a sign when they agree.
    //
    // To keep the host (CGEvent dock-swipe -> macOS Dock) in
    // agreement with what the user sees: on cancel we emit a .ended
    // frame with progress=0 velocity=0 so Dock snaps back; on commit
    // we emit progress=±1.0 (saturating past Dock's own threshold)
    // so Dock commits in the same direction we just snapped to. The
    // sign is the inverse of step because drag-positive yields
    // rawProgress-negative under our translation convention, and the
    // sign-flip in emitSwipeFrame turns that back into the correct
    // host-side direction under useMacOSDirection=false.
    func scrollViewWillEndDragging(
        _ scrollView: UIScrollView,
        withVelocity velocity: CGPoint,
        targetContentOffset: UnsafeMutablePointer<CGPoint>
    ) {
        guard let activeIdx = activeIndex else {
            isDragging = false
            return
        }
        let reference = max(1, bounds.width)
        // Same reason as in scrollViewDidScroll: contentOffset.x
        // saturates against the scroll-view's bounce limit in fits
        // mode, so it can't represent a "swiped 90% of the strip"
        // gesture. pan.translation.x is the user's actual finger
        // travel since the gesture began, finger-LEFT negative.
        // Negate so drag>0 means "step toward right-neighbour"
        // (the same sign convention the rest of this function uses).
        let panTranslation = scrollView.panGestureRecognizer.translation(in: scrollView).x
        let drag = -panTranslation
        let dragFraction = drag / reference
        let panVelocity = scrollView.panGestureRecognizer.velocity(in: scrollView).x
        let offsetVelocity = -panVelocity

        let step: Int
        if abs(dragFraction) > Self.commitThreshold {
            step = dragFraction > 0 ? 1 : -1
        } else if abs(offsetVelocity) > Self.commitVelocity
                  && (drag == 0 || drag * offsetVelocity > 0) {
            step = offsetVelocity > 0 ? 1 : -1
        } else {
            step = 0
        }
        let targetIdx = max(0, min(orderedSpaces.count - 1, activeIdx + step))

        let geometry = rowGeometry
        if geometry.isUsable, targetIdx < geometry.tileCount {
            targetContentOffset.pointee = CGPoint(
                x: geometry.restingOffsetX(for: targetIdx), y: 0
            )
        }

        if step == 0 {
            // .ended(0, 0) does NOT cancel; Dock commits at whatever
            // direction the most recent .changed was trending. Use the
            // .cancelled phase (CGS phase 8) so Dock snaps back to the
            // current Space and discards the in-flight gesture.
            emitSwipeFrame(phase: .cancelled, rawProgress: 0, velocityX: 0)
        } else {
            // step=+1 corresponds to drag>0 (offset right), which is
            // rawProgress<0 in our translation convention. Saturate
            // so Dock's commit threshold is unambiguously crossed.
            let rawForEmit: Float = step > 0 ? -1.0 : 1.0
            emitSwipeFrame(phase: .ended, rawProgress: rawForEmit, velocityX: panVelocity)
        }
        isDragging = false
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
        isProgrammaticScroll = false
    }

    func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) {
        if isProgrammaticScroll {
            activeRestingOffsetX = scrollView.contentOffset.x
        }
        isProgrammaticScroll = false
    }
}

// MARK: - ThumbnailTileCell

@MainActor
final class ThumbnailTileCell: UICollectionViewCell {
    static let reuseId = "ThumbnailTileCell"

    private let imageView = UIImageView()
    private let primaryLabel = UILabel()
    private let secondaryLabel = UILabel()
    // Compact pills center a single label over the whole cell; preview tiles stack the image
    // and a left-aligned two-row caption. One constraint set is installed at a time.
    private var previewConstraints: [NSLayoutConstraint] = []
    private var compactConstraints: [NSLayoutConstraint] = []

    override init(frame: CGRect) {
        super.init(frame: frame)
        configure()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

    private func configure() {
        contentView.backgroundColor = .secondarySystemBackground.withAlphaComponent(0.6)
        contentView.layer.cornerRadius = 8
        contentView.layer.borderColor = UIColor.separator.withAlphaComponent(0.4).cgColor
        contentView.layer.borderWidth = 0.5
        contentView.clipsToBounds = true

        imageView.contentMode = .scaleAspectFill
        imageView.clipsToBounds = true
        imageView.layer.cornerRadius = 4
        imageView.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(imageView)

        // Spotify-style hierarchy: bold title at full opacity, dimmer
        // regular-weight subtitle. Both left-aligned and single-line so
        // each truncates independently with its own ellipsis. Subtitle
        // is always populated (file name when in an editor with an
        // open file, app name otherwise) so the row-2 baseline stays
        // uniform across tiles.
        primaryLabel.font = .systemFont(ofSize: 11, weight: .semibold)
        primaryLabel.textColor = .label
        primaryLabel.textAlignment = .left
        primaryLabel.numberOfLines = 1
        primaryLabel.lineBreakMode = .byTruncatingTail
        primaryLabel.adjustsFontSizeToFitWidth = false
        primaryLabel.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(primaryLabel)

        secondaryLabel.font = .systemFont(ofSize: 9, weight: .regular)
        secondaryLabel.textColor = .secondaryLabel
        secondaryLabel.textAlignment = .left
        secondaryLabel.numberOfLines = 1
        secondaryLabel.lineBreakMode = .byTruncatingTail
        secondaryLabel.adjustsFontSizeToFitWidth = false
        secondaryLabel.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(secondaryLabel)

        previewConstraints = [
            imageView.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 4),
            imageView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 4),
            imageView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -4),
            imageView.heightAnchor.constraint(equalToConstant: ThumbnailStripView.tileHeight - 8),

            primaryLabel.topAnchor.constraint(equalTo: imageView.bottomAnchor, constant: 6),
            primaryLabel.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 6),
            primaryLabel.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -6),

            secondaryLabel.topAnchor.constraint(equalTo: primaryLabel.bottomAnchor, constant: 1),
            secondaryLabel.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 6),
            secondaryLabel.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -6),
            secondaryLabel.bottomAnchor.constraint(lessThanOrEqualTo: contentView.bottomAnchor, constant: -4)
        ]
        compactConstraints = [
            primaryLabel.centerXAnchor.constraint(equalTo: contentView.centerXAnchor),
            primaryLabel.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
            primaryLabel.leadingAnchor.constraint(greaterThanOrEqualTo: contentView.leadingAnchor, constant: 4),
            primaryLabel.trailingAnchor.constraint(lessThanOrEqualTo: contentView.trailingAnchor, constant: -4)
        ]
        NSLayoutConstraint.activate(previewConstraints)
    }

    func configure(primary: String, secondary: String, image: UIImage?) {
        applyLayoutStyle(compact: false)
        primaryLabel.text = primary
        primaryLabel.font = .systemFont(ofSize: 11, weight: .semibold)
        primaryLabel.textAlignment = .left
        secondaryLabel.text = secondary
        secondaryLabel.isHidden = secondary.isEmpty
        imageView.image = image
    }

    func configureCompact(title: String) {
        applyLayoutStyle(compact: true)
        primaryLabel.text = title
        primaryLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        primaryLabel.textAlignment = .center
        secondaryLabel.text = nil
        secondaryLabel.isHidden = true
        imageView.image = nil
    }

    private func applyLayoutStyle(compact: Bool) {
        imageView.isHidden = compact
        // Cells are reused across a mode flip, so swap rather than accumulate: leaving the
        // preview set installed would pin the label under a zero-height image box.
        NSLayoutConstraint.deactivate(compact ? previewConstraints : compactConstraints)
        NSLayoutConstraint.activate(compact ? compactConstraints : previewConstraints)
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        imageView.image = nil
        primaryLabel.text = nil
        secondaryLabel.text = nil
        secondaryLabel.isHidden = false
    }
}
