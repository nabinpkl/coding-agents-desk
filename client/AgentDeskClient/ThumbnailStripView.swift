import UIKit

// Spaces strip. Horizontal UICollectionView of one cell per non-fullscreen
// user Space on the active display, with two layout modes:
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
}

@MainActor
final class ThumbnailStripView: UIView {
    weak var delegate: ThumbnailStripViewDelegate?

    static let tileWidth: CGFloat = 64
    static let tileHeight: CGFloat = 40
    static let tileCaptionHeight: CGFloat = 14
    static let defaultTileSpacing: CGFloat = 8
    static var pageWidth: CGFloat { tileWidth + defaultTileSpacing }

    // False (default, toggle OFF) inverts the wire-level sign so
    // finger-right maps to the Space on the LEFT (scrollbar reading).
    // True passes through (macOS-native trackpad direction).
    var useMacOSDirection: Bool = false

    private lazy var layout: UICollectionViewFlowLayout = {
        let l = UICollectionViewFlowLayout()
        l.scrollDirection = .horizontal
        l.itemSize = CGSize(width: Self.tileWidth, height: Self.tileHeight + Self.tileCaptionHeight)
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

    private var orderedSpaces: [SpaceMetadata] = []
    private var activeSpaceId: UInt64?
    private var thumbnails: [String: String] = [:]
    private var isProgrammaticScroll: Bool = false
    private var isDragging: Bool = false
    // contentOffset at which the active cell is at its resting
    // position. Drag progress is measured relative to this.
    private var activeRestingOffsetX: CGFloat = 0
    private var lastBoundsWidth: CGFloat = 0
    private var lastTileCount: Int = -1

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
        backgroundColor = .clear
        accessibilityIdentifier = "thumbnail-strip"
        isUserInteractionEnabled = true

        addSubview(collectionView)
        addSubview(selectionOverlay)
        NSLayoutConstraint.activate([
            collectionView.leadingAnchor.constraint(equalTo: leadingAnchor),
            collectionView.trailingAnchor.constraint(equalTo: trailingAnchor),
            collectionView.topAnchor.constraint(equalTo: topAnchor),
            collectionView.bottomAnchor.constraint(equalTo: bottomAnchor)
        ])

        let longPress = UILongPressGestureRecognizer(target: self, action: #selector(handleLongPress(_:)))
        longPress.minimumPressDuration = 0.4
        collectionView.addGestureRecognizer(longPress)

        isHidden = true
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        // Recompute layout mode whenever bounds or tile count change.
        let needsRelayout = lastBoundsWidth != bounds.width
            || lastTileCount != orderedSpaces.count
        if needsRelayout {
            applyLayoutMode()
            lastBoundsWidth = bounds.width
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
    //   - Overflow: default 8pt spacing; row scrolls; partial-cut tiles
    //     at the edges of the visible window indicate "more exists".
    private func applyLayoutMode() {
        let count = orderedSpaces.count
        guard count > 0, bounds.width > 0 else { return }
        layout.minimumLineSpacing = Self.defaultTileSpacing
        let totalAtDefault = CGFloat(count) * Self.tileWidth
            + CGFloat(max(0, count - 1)) * Self.defaultTileSpacing
        let fits = totalAtDefault <= bounds.width
        if fits {
            // Center the tile block: equal inset on left and right.
            let inset = max(0, (bounds.width - totalAtDefault) / 2)
            layout.sectionInset = UIEdgeInsets(top: 0, left: inset, bottom: 0, right: inset)
        } else {
            layout.sectionInset = .zero
        }
        layout.invalidateLayout()
        // Scroll stays enabled in both modes. In fits mode, drags
        // bounce off the contentSize edges and snap back to 0 on
        // release, but the scroll-view delegate methods still fire
        // and the strip's switchSpace emission goes out as normal.
    }

    // MARK: - Public state surface

    func apply(state: DesktopState) {
        guard let activeDisplayId = state.activeDisplayId else {
            renderEmpty()
            return
        }
        let userSpaces = state.spaces
            .filter { $0.displayId == activeDisplayId && $0.type == 0 }
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

    func renderEmpty() {
        orderedSpaces = []
        activeSpaceId = nil
        thumbnails = [:]
        collectionView.reloadData()
        lastTileCount = 0
        selectionOverlay.isHidden = true
    }

    var userSpaceCount: Int { orderedSpaces.count }

    var activeIndex: Int? {
        guard let activeSpaceId else { return nil }
        return orderedSpaces.firstIndex { $0.id == activeSpaceId }
    }

    // Test affordances.
    var renderedTileCount: Int { orderedSpaces.count }
    func tileSpaceIds() -> [UInt64] { orderedSpaces.map { $0.id } }

    // MARK: - Internals

    // Scrolls the active cell into view in Overflow mode. In Fits
    // mode the math collapses naturally: contentSize.width <=
    // bounds.width so maxOffset == 0 and the clamp lands at 0.
    private func recenterOnActive(animated: Bool) {
        guard let idx = activeIndex, bounds.width > 0 else { return }
        guard let attrs = collectionView.layoutAttributesForItem(
            at: IndexPath(item: idx, section: 0)
        ) else { return }
        // Center the active cell in the visible window, clamped to
        // valid scroll bounds (UICollectionView clamps itself when
        // we hand it a target).
        let target = attrs.frame.midX - collectionView.bounds.width / 2
        let maxOffset = max(0, collectionView.contentSize.width - collectionView.bounds.width)
        let clamped = max(0, min(target, maxOffset))
        activeRestingOffsetX = clamped
        if abs(collectionView.contentOffset.x - clamped) < 0.5 { return }
        isProgrammaticScroll = true
        collectionView.setContentOffset(CGPoint(x: clamped, y: 0), animated: animated)
        if !animated {
            isProgrammaticScroll = false
        }
    }

    fileprivate func configureCell(_ cell: ThumbnailTileCell, atIndex i: Int) {
        let space = orderedSpaces[i]
        let key = String(space.id)
        let image: UIImage? = {
            if let base64 = thumbnails[key],
               let data = Data(base64Encoded: base64),
               let img = UIImage(data: data) {
                return img
            }
            return nil
        }()
        cell.configure(ordinal: i + 1, image: image)
    }

    // Position the floating indicator over the active cell's current
    // visible frame. Called only when the resting state could have
    // changed (layout pass, state apply); intentionally NOT called
    // from scrollViewDidScroll, so the indicator stays put while the
    // user drags. That stationary behaviour is what produces the
    // half-on-current / half-on-next overlap as cells scroll past.
    private func updateSelectionOverlayFrame(animated: Bool) {
        guard let idx = activeIndex,
              let attrs = collectionView.layoutAttributesForItem(
                at: IndexPath(item: idx, section: 0)
              )
        else {
            selectionOverlay.isHidden = true
            return
        }
        // Cell frame is in collection view's content coords. Convert
        // to strip coords by subtracting the offset at which the
        // active cell will REST, not the live contentOffset.x. The
        // live offset is often mid-animation when apply(state:) calls
        // us (the user's bounce is still decelerating, or
        // recenterOnActive just kicked off setContentOffset(animated:
        // true)), so reading it produces a frame that lines up with
        // the cell only at the start of the animation, not at
        // settlement. activeRestingOffsetX is the destination.
        let cellFrame = attrs.frame
        let target = CGRect(
            x: cellFrame.origin.x - activeRestingOffsetX,
            y: cellFrame.origin.y,
            width: cellFrame.size.width,
            height: cellFrame.size.height
        )
        let apply = {
            self.selectionOverlay.frame = target
            self.selectionOverlay.isHidden = false
        }
        if animated {
            UIView.animate(withDuration: 0.25, animations: apply)
        } else {
            apply()
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

        if let attrs = collectionView.layoutAttributesForItem(
            at: IndexPath(item: targetIdx, section: 0)
        ) {
            let maxOffset = max(0, collectionView.contentSize.width - collectionView.bounds.width)
            let landing = max(0, min(attrs.frame.midX - collectionView.bounds.width / 2, maxOffset))
            targetContentOffset.pointee = CGPoint(x: landing, y: 0)
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
    private let captionLabel = UILabel()

    override init(frame: CGRect) {
        super.init(frame: frame)
        configure()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

    private func configure() {
        contentView.backgroundColor = .secondarySystemBackground
        contentView.layer.cornerRadius = 6
        contentView.layer.borderColor = UIColor.separator.cgColor
        contentView.layer.borderWidth = 0.5
        contentView.clipsToBounds = true

        imageView.contentMode = .scaleAspectFill
        imageView.clipsToBounds = true
        imageView.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(imageView)

        captionLabel.font = .preferredFont(forTextStyle: .caption2)
        captionLabel.textColor = .secondaryLabel
        captionLabel.textAlignment = .center
        captionLabel.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(captionLabel)

        NSLayoutConstraint.activate([
            imageView.topAnchor.constraint(equalTo: contentView.topAnchor),
            imageView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            imageView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            imageView.heightAnchor.constraint(equalToConstant: ThumbnailStripView.tileHeight),

            captionLabel.topAnchor.constraint(equalTo: imageView.bottomAnchor, constant: 1),
            captionLabel.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            captionLabel.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            captionLabel.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -1)
        ])
    }

    func configure(ordinal: Int, image: UIImage?) {
        captionLabel.text = "Desktop \(ordinal)"
        imageView.image = image
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        imageView.image = nil
        captionLabel.text = nil
    }
}
