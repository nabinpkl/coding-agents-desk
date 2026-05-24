import UIKit

// Spaces strip. Horizontal UICollectionView of one cell per non-fullscreen
// user Space on the active display, with two layout modes:
//
// - Fits: all tiles fit in the strip's bounds. Spacing expands so the
//   row spans from the strip's leading edge to its trailing edge. No
//   scrolling. The active tile draws its own tinted border in place.
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
        cv.alwaysBounceHorizontal = false
        // The strip lives in the middle of the view, not at edges; no
        // auto-adjustment of insets behind our back.
        cv.contentInsetAdjustmentBehavior = .never
        cv.dataSource = self
        cv.delegate = self
        cv.register(ThumbnailTileCell.self, forCellWithReuseIdentifier: ThumbnailTileCell.reuseId)
        cv.translatesAutoresizingMaskIntoConstraints = false
        return cv
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
    // commit. 0.5 means "half a strip's worth of drag commits one
    // Space". Velocity is intentionally not in the prediction: the
    // user's mental model is "slide and stay = commit, slide and
    // return = cancel", and a fast return-flick would otherwise read
    // as a commit in the wrong direction.
    private static let commitThreshold: CGFloat = 0.5

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
        }
    }

    // Picks the layout mode for the current bounds and tile count:
    //   - Fits: lineSpacing expanded so the row spans leading-to-trailing.
    //   - Overflow: default 8pt spacing; row scrolls; partial-cut tiles at
    //     the edges of the visible window indicate "more exists".
    //
    // Both modes use sectionInset = .zero. In Fits, contentOffset stays
    // at 0; in Overflow, recenterOnActive scrolls the active cell into
    // view.
    private func applyLayoutMode() {
        let count = orderedSpaces.count
        guard count > 0, bounds.width > 0 else { return }
        let totalAtDefault = CGFloat(count) * Self.tileWidth
            + CGFloat(max(0, count - 1)) * Self.defaultTileSpacing
        let fits = totalAtDefault <= bounds.width
        if fits && count > 1 {
            // Distribute remaining width across the gaps so cells
            // span leading-to-trailing.
            let extra = bounds.width - CGFloat(count) * Self.tileWidth
            layout.minimumLineSpacing = max(Self.defaultTileSpacing, extra / CGFloat(count - 1))
        } else {
            layout.minimumLineSpacing = Self.defaultTileSpacing
        }
        layout.invalidateLayout()
        collectionView.isScrollEnabled = !fits
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
    // mode all cells are visible already; nothing to do.
    private func recenterOnActive(animated: Bool) {
        guard let idx = activeIndex, bounds.width > 0 else { return }
        if !collectionView.isScrollEnabled {
            // Fits mode: no scrolling, contentOffset stays at 0.
            activeRestingOffsetX = 0
            return
        }
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
        cell.configure(
            ordinal: i + 1,
            image: image,
            isActive: space.id == activeSpaceId
        )
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
        // useMacOSDirection=true passes finger direction through;
        // false (default) inverts so finger-right maps to Space-on-
        // the-left (scrollbar reading).
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
        // Reference progress against the full strip width so a small
        // drag stays a small progress (and the host doesn't commit
        // until the user has dragged a meaningful distance). The old
        // SpacesDotsView used the same reference; the previous
        // pageWidth-based normalisation made every 30pt nudge read as
        // ~0.4 progress and triggered premature commits.
        let reference = max(1, bounds.width)
        let raw = Self.computeRawProgress(
            currentOffsetX: scrollView.contentOffset.x,
            activeRestingOffsetX: activeRestingOffsetX,
            pageWidth: reference
        )
        let nudged = Self.nudgeAwayFromZero(raw)
        let velocity = scrollView.panGestureRecognizer.velocity(in: scrollView).x
        emitSwipeFrame(phase: .changed, rawProgress: nudged, velocityX: velocity)
    }

    // Predict commit / cancel and override targetContentOffset so the
    // strip snaps to the right resting position. The user's model is
    // "slide and stay = commit, slide and return = cancel" so the
    // decision is drag-distance only; velocity does not push a small
    // peek into a commit.
    //
    // To keep the host (CGEvent dock-swipe -> macOS Dock) in
    // agreement with what the user sees on the strip: on cancel we
    // emit a .ended frame with progress=0 and velocity=0, which Dock
    // reads as "complete the gesture with no displacement, snap
    // back". On commit we pass through the drag's progress and
    // velocity so Dock commits to the same neighbour we already
    // predicted.
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
        let drag = scrollView.contentOffset.x - activeRestingOffsetX
        let fraction = drag / reference
        let panVelocity = scrollView.panGestureRecognizer.velocity(in: scrollView).x

        let step: Int
        if fraction > Self.commitThreshold { step = 1 }
        else if fraction < -Self.commitThreshold { step = -1 }
        else { step = 0 }
        let targetIdx = max(0, min(orderedSpaces.count - 1, activeIdx + step))

        if let attrs = collectionView.layoutAttributesForItem(
            at: IndexPath(item: targetIdx, section: 0)
        ) {
            let maxOffset = max(0, collectionView.contentSize.width - collectionView.bounds.width)
            let landing = max(0, min(attrs.frame.midX - collectionView.bounds.width / 2, maxOffset))
            targetContentOffset.pointee = CGPoint(x: landing, y: 0)
        }

        if step == 0 {
            // Cancel: zero out progress + velocity so Dock snaps
            // back instead of treating a quick flick-return as a
            // commit in the opposite direction.
            emitSwipeFrame(phase: .ended, rawProgress: 0, velocityX: 0)
        } else {
            emitSwipeFrame(phase: .ended, rawProgress: Float(fraction), velocityX: panVelocity)
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

    func configure(ordinal: Int, image: UIImage?, isActive: Bool) {
        captionLabel.text = "Desktop \(ordinal)"
        imageView.image = image
        contentView.layer.borderColor = (isActive ? UIColor.tintColor : UIColor.separator).cgColor
        contentView.layer.borderWidth = isActive ? 1.5 : 0.5
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        imageView.image = nil
        captionLabel.text = nil
        contentView.layer.borderColor = UIColor.separator.cgColor
        contentView.layer.borderWidth = 0.5
    }
}
