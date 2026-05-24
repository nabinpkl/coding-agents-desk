import UIKit

// Spaces strip. Horizontal UICollectionView of one cell per non-fullscreen
// user Space on the active display, with a fixed border-only indicator
// pinned to the strip's horizontal centre. Tiles scroll past the
// indicator; that motion is the swipe-to-switch gesture.
//
// The earlier hand-rolled approach overlaid a translucent rect over the
// active tile and animated it manually as the user dragged. That
// produced five rounds of "the highlight isn't moving" before the user
// reminded me to reach for the canonical iOS pattern, which is this
// one: tiles in a scroll container, indicator pinned to the viewport.
//
// Gesture wire is unchanged. Drag-began/scroll/end map onto
// .switchSpaceGesture(.began/.changed/.ended); the host's
// InputDispatcher posts one dock-swipe CGEvent per frame.
//
// State arrives as two streams: DesktopState drives the tile lineup
// (which Spaces exist, which is active), and `thumbnails` drives the
// images. PairingViewController applies both as they update.

@MainActor
protocol ThumbnailStripViewDelegate: AnyObject {
    // Triggered on tap. The view emits a chain of single-step
    // .switchSpaceGesture frames in the controller, so the existing
    // dock-swipe synthesis path can commit a multi-step move without a
    // new wire shape.
    func thumbnailStrip(_ view: ThumbnailStripView, didTapStepDelta delta: Int)
    // Triggered on long-press. Routes to a client-config refresh
    // frame.
    func thumbnailStrip(_ view: ThumbnailStripView, didLongPressSpaceId spaceId: UInt64)
    // Triggered on continuous scroll. Forwards .switchSpaceGesture(...)
    // frames in lockstep with UIScrollView's drag/scroll callbacks.
    func thumbnailStrip(_ view: ThumbnailStripView, didProduce input: NormalizedInput)
}

@MainActor
final class ThumbnailStripView: UIView {
    weak var delegate: ThumbnailStripViewDelegate?

    static let tileWidth: CGFloat = 64
    static let tileHeight: CGFloat = 40
    static let tileSpacing: CGFloat = 8
    static let tileCaptionHeight: CGFloat = 14
    static var pageWidth: CGFloat { tileWidth + tileSpacing }

    // Direction mapping mirrored from the retired manual implementation.
    // False (default, toggle OFF) inverts the wire-level sign so
    // finger-right maps to the Space on the LEFT (scrollbar-style
    // reading). True passes through (macOS-native trackpad direction).
    var useMacOSDirection: Bool = false

    private lazy var layout: UICollectionViewFlowLayout = {
        let l = UICollectionViewFlowLayout()
        l.scrollDirection = .horizontal
        l.itemSize = CGSize(width: Self.tileWidth, height: Self.tileHeight + Self.tileCaptionHeight)
        l.minimumLineSpacing = Self.tileSpacing
        l.minimumInteritemSpacing = 0
        return l
    }()

    private lazy var collectionView: UICollectionView = {
        let cv = UICollectionView(frame: .zero, collectionViewLayout: layout)
        cv.backgroundColor = .clear
        cv.showsHorizontalScrollIndicator = false
        cv.showsVerticalScrollIndicator = false
        cv.decelerationRate = .fast
        cv.alwaysBounceHorizontal = true
        // Default is .automatic, which lets iOS add safe-area /
        // keyboard-tracking padding to the scroll's contentInset
        // behind our back. The strip lives in the middle of the
        // view, not at edges, so we want no auto adjustment; what we
        // set is what we get.
        cv.contentInsetAdjustmentBehavior = .never
        cv.dataSource = self
        cv.delegate = self
        cv.register(ThumbnailTileCell.self, forCellWithReuseIdentifier: ThumbnailTileCell.reuseId)
        cv.translatesAutoresizingMaskIntoConstraints = false
        return cv
    }()

    // Fixed indicator. Sits over the collection view at horizontal
    // centre; tiles scroll past underneath. Transparent fill so the
    // active tile's thumbnail shows through; tinted border alone marks
    // the selection.
    private lazy var selectionOverlay: UIView = {
        let v = UIView()
        v.backgroundColor = .clear
        v.layer.cornerRadius = 6
        v.layer.borderColor = UIColor.tintColor.cgColor
        v.layer.borderWidth = 1.5
        v.isUserInteractionEnabled = false
        v.translatesAutoresizingMaskIntoConstraints = false
        return v
    }()

    private var orderedSpaces: [SpaceMetadata] = []
    private var activeSpaceId: UInt64?
    private var thumbnails: [String: String] = [:]
    // Guards against scrollViewDidScroll firing while we're
    // programmatically recentering after a state update.
    private var isProgrammaticScroll: Bool = false
    private var isDragging: Bool = false
    private var lastEmittedActiveIndex: Int?
    // The "resting offset" at which the currently-active tile sits
    // centred under the indicator. Recomputed when bounds, tile count,
    // or active index change.
    private var activeRestingOffsetX: CGFloat = 0
    private var lastBoundsWidth: CGFloat = 0

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
            collectionView.bottomAnchor.constraint(equalTo: bottomAnchor),

            selectionOverlay.centerXAnchor.constraint(equalTo: centerXAnchor),
            selectionOverlay.centerYAnchor.constraint(
                equalTo: topAnchor,
                constant: (Self.tileHeight + Self.tileCaptionHeight) / 2
            ),
            selectionOverlay.widthAnchor.constraint(equalToConstant: Self.tileWidth),
            selectionOverlay.heightAnchor.constraint(
                equalToConstant: Self.tileHeight + Self.tileCaptionHeight
            )
        ])

        let longPress = UILongPressGestureRecognizer(target: self, action: #selector(handleLongPress(_:)))
        longPress.minimumPressDuration = 0.4
        collectionView.addGestureRecognizer(longPress)

        isHidden = true
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        // Inset so the first and last tile can centre under the
        // indicator. Depends on bounds.width; recompute when it
        // changes.
        let inset = max(0, (bounds.width - Self.tileWidth) / 2)
        let needsUpdate = collectionView.contentInset.left != inset
            || lastBoundsWidth != bounds.width
        if needsUpdate {
            collectionView.contentInset = UIEdgeInsets(
                top: 0, left: inset, bottom: 0, right: inset
            )
            lastBoundsWidth = bounds.width
            // Force the flow layout to recompute now so scrollToItem
            // and the resting-offset readback below see the
            // post-inset content size.
            collectionView.collectionViewLayout.invalidateLayout()
            collectionView.layoutIfNeeded()
            recenterOnActive(animated: false)
        }
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
        } else {
            // Just re-render visible cells so active-mark updates.
            for ip in collectionView.indexPathsForVisibleItems {
                if let cell = collectionView.cellForItem(at: ip) as? ThumbnailTileCell {
                    configureCell(cell, atIndex: ip.item)
                }
            }
        }
        recenterOnActive(animated: !countChanged)
        selectionOverlay.isHidden = activeIndex == nil
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

    private func recenterOnActive(animated: Bool) {
        guard let idx = activeIndex, bounds.width > 0 else { return }
        // Let UICollectionView do the centering math itself. It
        // accounts for contentInset, sectionInset, and the special
        // cases at the start and end of the list. The previous
        // hand-rolled `i * pageWidth - inset` formula occasionally
        // landed off-centre when the strip's bounds and the
        // collection view's contentInset hadn't fully synchronised.
        let ip = IndexPath(item: idx, section: 0)
        isProgrammaticScroll = true
        collectionView.scrollToItem(at: ip, at: .centeredHorizontally, animated: animated)
        // After scrollToItem the contentOffset reflects "active
        // centred", which is the reference point the progress math
        // measures drags against.
        if !animated {
            collectionView.layoutIfNeeded()
            activeRestingOffsetX = collectionView.contentOffset.x
            isProgrammaticScroll = false
        } else {
            // For animated scroll, capture an approximate resting
            // offset now so an interrupting drag has a reference.
            // didEndScrollingAnimation will refine it.
            activeRestingOffsetX = restingOffsetEstimate(forIndex: idx)
        }
    }

    private func restingOffsetEstimate(forIndex i: Int) -> CGFloat {
        let inset = collectionView.contentInset.left
        return CGFloat(i) * Self.pageWidth - inset
    }

    fileprivate func configureCell(_ cell: ThumbnailTileCell, atIndex i: Int) {
        let space = orderedSpaces[i]
        let key = String(space.id)
        if let base64 = thumbnails[key],
           let data = Data(base64Encoded: base64),
           let image = UIImage(data: data) {
            cell.configure(ordinal: i + 1, image: image)
        } else {
            cell.configure(ordinal: i + 1, image: nil)
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

    // MARK: - Gesture emission (pure function, testable)

    // Maps a scroll offset to the .switchSpaceGesture progress the
    // host expects. Pure function so tests can exercise it directly
    // without UIKit setup.
    //
    // Old translation.x maps inversely to contentOffset: dragging the
    // finger RIGHT pulls content right, which DECREASES
    // contentOffset.x. The "translation-equivalent" is therefore
    // -(currentOffset - resting).
    //
    // Progress is normalised to one pageWidth (one tile + spacing) and
    // clamped to [-1, 1].
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

    // Internal, not private: scrollView delegate methods call this in
    // production, and ThumbnailStripViewTests calls it directly to
    // exercise the sign-flip logic without spinning a real
    // UIScrollView.
    func emitSwipeFrame(phase: NormalizedInput.SwipePhase, rawProgress: Float, velocityX: CGFloat) {
        // useMacOSDirection=true passes finger direction through;
        // false (default) inverts so finger-right maps to Space-on-the-
        // left (scrollbar reading). The progress sign here is in old
        // translation.x convention (finger-right positive).
        let signedProgress = useMacOSDirection ? rawProgress : -rawProgress
        let signedVelocity = Float(useMacOSDirection ? velocityX : -velocityX)
        delegate?.thumbnailStrip(self, didProduce: .switchSpaceGesture(
            phase: phase,
            progress: signedProgress,
            velocityX: signedVelocity
        ))
    }

    // Dock reads progress=0 on a .changed frame as "no gesture in
    // progress" and drops it. Nudge to FLT_TRUE_MIN-sized away from
    // zero so the direction-required guard still passes when the
    // user's drag transits the resting position.
    static func nudgeAwayFromZero(_ progress: Float) -> Float {
        progress == 0 ? .leastNonzeroMagnitude : progress
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
        let raw = Self.computeRawProgress(
            currentOffsetX: scrollView.contentOffset.x,
            activeRestingOffsetX: activeRestingOffsetX,
            pageWidth: Self.pageWidth
        )
        let nudged = Self.nudgeAwayFromZero(raw)
        let velocity = scrollView.panGestureRecognizer.velocity(in: scrollView).x
        emitSwipeFrame(phase: .changed, rawProgress: nudged, velocityX: velocity)
    }

    // Predict where the snap will land and override the target so the
    // strip lands cleanly under the indicator. Also emit .ended with
    // the predicted progress so the host's commit decision matches
    // what the user sees.
    func scrollViewWillEndDragging(
        _ scrollView: UIScrollView,
        withVelocity velocity: CGPoint,
        targetContentOffset: UnsafeMutablePointer<CGPoint>
    ) {
        guard let activeIdx = activeIndex else { return }
        // Velocity here is in points-per-millisecond; multiply by 1000
        // to project a 1-second drift forward.
        let projected = scrollView.contentOffset.x + velocity.x * 200
        let tileFromActive = (projected - activeRestingOffsetX) / Self.pageWidth
        let step: Int
        if tileFromActive > 0.5 { step = 1 }
        else if tileFromActive < -0.5 { step = -1 }
        else { step = 0 }
        let targetIdx = max(0, min(orderedSpaces.count - 1, activeIdx + step))
        let landing = restingOffsetEstimate(forIndex: targetIdx)
        targetContentOffset.pointee = CGPoint(x: landing, y: 0)

        // Emit .ended with the post-drag progress (clamped). The host
        // will commit if |progress| or |velocity| crosses its
        // threshold; predicting the same step here keeps the visual
        // and the host in agreement.
        let raw = Self.computeRawProgress(
            currentOffsetX: landing,
            activeRestingOffsetX: activeRestingOffsetX,
            pageWidth: Self.pageWidth
        )
        // panGestureRecognizer velocity is in points/sec; pass it
        // through with the same sign convention as the old code (old
        // used velocity.x from pan.translation, same units).
        let panVelocity = scrollView.panGestureRecognizer.velocity(in: scrollView).x
        emitSwipeFrame(phase: .ended, rawProgress: raw, velocityX: panVelocity)
        isDragging = false
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
        isProgrammaticScroll = false
    }

    func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) {
        // After an animated recenter, the actual resting offset is
        // whatever UICollectionView landed on. Capture it so the
        // progress math measures drags against the true reference.
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
