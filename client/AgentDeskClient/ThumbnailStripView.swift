import UIKit

// R25 merged Spaces band. Replaces SpacesDotsView entirely: the active
// tile's tintColor / "Here" treatment is the position indicator, and a
// horizontal pan anywhere on the strip drives the continuous dock-swipe
// stream the dots band used to drive. Tap = jump to that Space.
// Long-press = refresh thumbnail.
//
// Gesture model is unchanged from the old dots band: single-finger
// horizontal pan streams SwipePhase + normalised progress + velocity
// frame-by-frame; the host's InputDispatcher posts one dock-swipe
// CGEvent per frame and Dock animates / commits accordingly. Pan and
// tap coexist via UIKit's natural arbitration: tap fires below the
// pan slop (~10pt), pan wins once it crosses.
//
// State arrives as two streams: DesktopState drives the tile lineup
// (which Spaces exist, which is active), and `thumbnails` drives the
// images. PairingViewController applies both as they update.

@MainActor
protocol ThumbnailStripViewDelegate: AnyObject {
    // Triggered on tap. The view emits a chain of single-step
    // .switchSpaceGesture frames (one per index step toward the
    // target) so the host's existing dock-swipe synthesis path can
    // commit the multi-step move without a new wire shape.
    func thumbnailStrip(_ view: ThumbnailStripView, didTapStepDelta delta: Int)
    // Triggered on long-press. Routes to a client-config frame.
    func thumbnailStrip(_ view: ThumbnailStripView, didLongPressSpaceId spaceId: UInt64)
    // Triggered on continuous pan. Forwards .switchSpaceGesture(...)
    // frames in lockstep with UIKit pan callbacks (began -> ... ->
    // ended/cancelled). PairingViewController forwards to sendInput.
    func thumbnailStrip(_ view: ThumbnailStripView, didProduce input: NormalizedInput)
}

@MainActor
final class ThumbnailStripView: UIView {
    weak var delegate: ThumbnailStripViewDelegate?

    // Layout: a horizontal stack of fixed-width tiles, centered in
    // the band. 64x40 keeps the strip dense enough for 6+ Spaces on
    // a standard iPhone while leaving captions legible.
    static let tileWidth: CGFloat = 64
    static let tileHeight: CGFloat = 40
    static let tileSpacing: CGFloat = 8

    // R25: swipe-to-switch direction mapping, mirrored from the old
    // SpacesDotsView. False (default, toggle OFF) inverts the
    // wire-level sign so finger-right maps to the Space on the LEFT
    // (scrollbar-style reading). True passes through (macOS-native
    // trackpad direction). PairingViewController reads
    // SettingsStore.shared.useMacOSSpacesDirection.
    var useMacOSDirection: Bool = false

    private let stack = UIStackView()
    private let feedback = UISelectionFeedbackGenerator()
    // R27 v2: floating selection overlay. Sits on top of the active
    // tile in the strip's coordinate space (not inside the stack), so
    // it can slide between tile positions independently of the stack's
    // own slide-with-finger transform. The previous per-tile
    // cross-fade fought the stack's transform and the user couldn't
    // perceive the overlap; one overlay sliding across tile centres
    // gives the clean "moving between two desktops" visual.
    private let selectionOverlay = UIView()
    private var tiles: [ThumbnailTileView] = []
    private var orderedSpaces: [SpaceMetadata] = []
    private var activeSpaceId: UInt64?
    private var thumbnails: [String: String] = [:]
    private var gestureBandWidth: CGFloat = 1.0
    private var isSwipeActive = false

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
        stack.axis = .horizontal
        stack.spacing = Self.tileSpacing
        stack.alignment = .center
        stack.distribution = .equalSpacing
        stack.isUserInteractionEnabled = true
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor)
        ])

        // R27 v2: selection overlay sits above the stack in z-order
        // and is positioned via frame in updateSelectionOverlayFrame.
        // Not user-interactive so taps fall through to tiles.
        selectionOverlay.backgroundColor = UIColor.tintColor.withAlphaComponent(0.20)
        selectionOverlay.layer.cornerRadius = 6
        selectionOverlay.layer.borderColor = UIColor.tintColor.cgColor
        selectionOverlay.layer.borderWidth = 1.5
        selectionOverlay.isUserInteractionEnabled = false
        selectionOverlay.isHidden = true
        addSubview(selectionOverlay)

        let pan = UIPanGestureRecognizer(target: self, action: #selector(handleSwipe(_:)))
        pan.minimumNumberOfTouches = 1
        pan.maximumNumberOfTouches = 1
        addGestureRecognizer(pan)

        isHidden = true
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        updateSelectionOverlayFrame()
    }

    private func updateSelectionOverlayFrame() {
        // R27 v4: never touch the overlay frame while a swipe is
        // active - setting frame while transform is non-identity is
        // undefined per UIKit docs, and it was wiping the on-screen
        // slide visible to the user.
        if isSwipeActive { return }
        guard let activeIdx = activeIndex, activeIdx < tiles.count else {
            selectionOverlay.isHidden = true
            return
        }
        let activeTile = tiles[activeIdx]
        // Force the stack to lay out so the tile's frame is current
        // before we read it. Without this, tile.frame can still be
        // .zero on the first apply(state:) and the overlay lands at
        // the strip's origin instead of over the active tile.
        stack.setNeedsLayout()
        stack.layoutIfNeeded()
        let frame = activeTile.convert(activeTile.bounds, to: self)
        selectionOverlay.transform = .identity
        selectionOverlay.frame = frame
        selectionOverlay.isHidden = false
    }

    // Called whenever DesktopState arrives. Recomputes the tile list
    // from the active display's user Spaces; identity-stable so a tile
    // for the same Space doesn't reload between ticks. Does not manage
    // its own isHidden; PairingViewController combines the settings
    // toggle and the Space count to decide visibility.
    func apply(state: DesktopState) {
        guard let activeDisplayId = state.activeDisplayId else {
            renderEmpty()
            return
        }
        let userSpaces = state.spaces
            .filter { $0.displayId == activeDisplayId && $0.type == 0 }
            .sorted { ($0.index ?? Int.max) < ($1.index ?? Int.max) }
        orderedSpaces = userSpaces
        activeSpaceId = state.activeSpaceId
        rebuildIfNeeded()
        applyThumbnailsToTiles()
        setNeedsLayout()
        layoutIfNeeded()
        updateSelectionOverlayFrame()
    }

    // Called whenever ThumbnailsPush arrives.
    func apply(thumbnails: [String: String]) {
        self.thumbnails = thumbnails
        applyThumbnailsToTiles()
    }

    func renderEmpty() {
        orderedSpaces = []
        activeSpaceId = nil
        thumbnails = [:]
        for tile in tiles { tile.removeFromSuperview() }
        tiles = []
        selectionOverlay.isHidden = true
    }

    // PairingViewController calls this to expose the tile count it
    // needs for the show/hide decision without leaking internals.
    var userSpaceCount: Int { orderedSpaces.count }

    // MARK: - Internals

    private func rebuildIfNeeded() {
        // Identity-by-spaceId. A change to active-Space pointer alone
        // doesn't require recreating tiles; only count / id list does.
        let desiredIds = orderedSpaces.map { $0.id }
        let currentIds = tiles.map { $0.spaceId }
        guard desiredIds != currentIds else {
            // Just re-mark active.
            for tile in tiles { tile.setActive(tile.spaceId == activeSpaceId) }
            return
        }
        for tile in tiles { tile.removeFromSuperview() }
        tiles = []
        for (idx, space) in orderedSpaces.enumerated() {
            let tile = ThumbnailTileView(spaceId: space.id, ordinal: idx + 1)
            tile.delegate = self
            tile.setActive(space.id == activeSpaceId)
            stack.addArrangedSubview(tile)
            tiles.append(tile)
        }
    }

    private func applyThumbnailsToTiles() {
        for tile in tiles {
            if tile.spaceId == activeSpaceId {
                tile.setActive(true)
                tile.clearImage()
                continue
            }
            let key = String(tile.spaceId)
            if let base64 = thumbnails[key],
               let data = Data(base64Encoded: base64),
               let image = UIImage(data: data) {
                tile.setImage(image)
            } else {
                tile.clearImage()
            }
        }
    }

    // MARK: - Tile callbacks

    fileprivate func tileTapped(_ tile: ThumbnailTileView) {
        guard let activeSpaceId else { return }
        guard let activeIdx = orderedSpaces.firstIndex(where: { $0.id == activeSpaceId }),
              let targetIdx = orderedSpaces.firstIndex(where: { $0.id == tile.spaceId })
        else { return }
        let delta = targetIdx - activeIdx
        guard delta != 0 else { return }
        delegate?.thumbnailStrip(self, didTapStepDelta: delta)
    }

    fileprivate func tileLongPressed(_ tile: ThumbnailTileView) {
        delegate?.thumbnailStrip(self, didLongPressSpaceId: tile.spaceId)
    }

    // MARK: - Swipe state machine
    //
    // Ported from the retired SpacesDotsView. Same shape so the host
    // contract (one .switchSpaceGesture frame per UIKit pan callback)
    // doesn't change. Pure function: tests drive processGesture
    // without UIKit setup.

    @objc private func handleSwipe(_ gesture: UIPanGestureRecognizer) {
        processGesture(
            state: gesture.state,
            translation: gesture.translation(in: self),
            velocity: gesture.velocity(in: self),
            bandWidth: bounds.width
        )
    }

    func processGesture(
        state: UIGestureRecognizer.State,
        translation: CGPoint,
        velocity: CGPoint,
        bandWidth: CGFloat
    ) {
        switch state {
        case .began:
            gestureBandWidth = max(bandWidth, 1.0)
            feedback.selectionChanged()
            isSwipeActive = true
            // R26: cancel any in-flight snap-back so a rapid second
            // pan starts cleanly from the current transform instead
            // of fighting the spring.
            stack.layer.removeAllAnimations()
            selectionOverlay.layer.removeAllAnimations()
            emit(phase: .began, progress: 0, velocityX: 0)
        case .changed:
            let raw = Float(translation.x / gestureBandWidth)
            let progress = min(max(raw, -1.0), 1.0)
            let nudged = nudgeAwayFromZero(progress)
            applyVisualSlide(translation: translation)
            applyOverlapHighlight(translation: translation)
            emit(phase: .changed, progress: nudged, velocityX: Float(velocity.x))
        case .ended:
            let raw = Float(translation.x / gestureBandWidth)
            let progress = min(max(raw, -1.0), 1.0)
            emit(phase: .ended, progress: progress, velocityX: Float(velocity.x))
            isSwipeActive = false
            snapStackBack()
            restoreActiveHighlight()
        case .cancelled, .failed:
            emit(phase: .cancelled, progress: 0, velocityX: 0)
            isSwipeActive = false
            snapStackBack()
            restoreActiveHighlight()
        default:
            break
        }
    }

    // R26: slide the tile stack 1:1 with the finger inside the band,
    // and apply diminishing resistance beyond the band edge so a long
    // overdrag doesn't shoot the strip off-screen. Tracks the finger
    // direction (not the host's swipe direction), so under the
    // default useMacOSDirection=false reading where finger-right maps
    // to the Space-on-the-left, the strip still slides right with the
    // finger - matches the user's tactile expectation.
    private func applyVisualSlide(translation: CGPoint) {
        let raw = translation.x
        let band = gestureBandWidth
        let visualX: CGFloat
        if abs(raw) <= band {
            visualX = raw
        } else {
            let sign: CGFloat = raw >= 0 ? 1 : -1
            let overshoot = abs(raw) - band
            visualX = sign * (band + overshoot * 0.35)
        }
        stack.transform = CGAffineTransform(translationX: visualX, y: 0)
    }

    // R27 v4: overlay slides at 2x the finger rate. The stack slides
    // at 1x (applyVisualSlide), so the overlay's net motion RELATIVE
    // to the active tile equals 1x the finger translation - exactly
    // the "blue box leaves the active tile by whatever distance I
    // slide" the user asked for. Direction matches the finger
    // (overlay goes the same way the finger goes); the
    // useMacOSDirection setting only flips the wire-level sign in
    // emit(), not the on-screen overlay motion. The previous
    // formulas with destSign / magnitude / tileDistance produced
    // tiny relative offsets (~12pt at a 50pt drag) that were
    // invisible against the stack's full-rate slide.
    private func applyOverlapHighlight(translation: CGPoint) {
        guard activeIndex != nil else { return }
        selectionOverlay.transform = CGAffineTransform(
            translationX: translation.x * 2.0,
            y: 0
        )
    }

    private func restoreActiveHighlight() {
        // Spring the overlay back to the (current) active tile's
        // frame. If the swipe committed, the host's DesktopState
        // arrives next and updateSelectionOverlayFrame moves the
        // resting position to the new active tile.
        UIView.animate(
            withDuration: 0.35,
            delay: 0,
            usingSpringWithDamping: 0.72,
            initialSpringVelocity: 0,
            options: [.allowUserInteraction, .beginFromCurrentState],
            animations: { self.selectionOverlay.transform = .identity },
            completion: nil
        )
    }

    private func snapStackBack() {
        UIView.animate(
            withDuration: 0.35,
            delay: 0,
            usingSpringWithDamping: 0.72,
            initialSpringVelocity: 0,
            options: [.allowUserInteraction, .beginFromCurrentState],
            animations: { self.stack.transform = .identity },
            completion: nil
        )
    }

    // Dock reads progress=0 on a .changed frame as "no gesture in
    // progress" and drops it. Nudge to FLT_TRUE_MIN-sized away from
    // zero so the direction-required guard still passes.
    private func nudgeAwayFromZero(_ progress: Float) -> Float {
        if progress != 0 { return progress }
        return .leastNonzeroMagnitude
    }

    private func emit(phase: NormalizedInput.SwipePhase, progress: Float, velocityX: Float) {
        // Flip when NOT using macOS direction; pass through when
        // using macOS direction. Default (false) gives the inverted
        // scrollbar-style feel.
        let signedProgress = useMacOSDirection ? progress : -progress
        let signedVelocityX = useMacOSDirection ? velocityX : -velocityX
        delegate?.thumbnailStrip(self, didProduce: .switchSpaceGesture(
            phase: phase, progress: signedProgress, velocityX: signedVelocityX
        ))
    }

    // Test affordances.
    var renderedTileCount: Int { tiles.count }
    func tileSpaceIds() -> [UInt64] { tiles.map { $0.spaceId } }
    var activeIndex: Int? {
        guard let activeSpaceId else { return nil }
        return tiles.firstIndex(where: { $0.spaceId == activeSpaceId })
    }
}

// MARK: - ThumbnailTileView

@MainActor
final class ThumbnailTileView: UIView {
    let spaceId: UInt64
    private let ordinal: Int
    private let imageView = UIImageView()
    private let captionLabel = UILabel()
    fileprivate weak var delegate: ThumbnailStripView?

    init(spaceId: UInt64, ordinal: Int) {
        self.spaceId = spaceId
        self.ordinal = ordinal
        super.init(frame: .zero)
        configure()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

    private func configure() {
        translatesAutoresizingMaskIntoConstraints = false
        backgroundColor = .secondarySystemBackground
        layer.cornerRadius = 6
        layer.borderColor = UIColor.separator.cgColor
        layer.borderWidth = 0.5
        clipsToBounds = true
        isUserInteractionEnabled = true

        imageView.contentMode = .scaleAspectFill
        imageView.clipsToBounds = true
        imageView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(imageView)

        captionLabel.text = "Desktop \(ordinal)"
        captionLabel.font = .preferredFont(forTextStyle: .caption2)
        captionLabel.textColor = .secondaryLabel
        captionLabel.textAlignment = .center
        captionLabel.translatesAutoresizingMaskIntoConstraints = false
        addSubview(captionLabel)

        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: ThumbnailStripView.tileWidth),
            heightAnchor.constraint(equalToConstant: ThumbnailStripView.tileHeight + 14),
            imageView.topAnchor.constraint(equalTo: topAnchor),
            imageView.leadingAnchor.constraint(equalTo: leadingAnchor),
            imageView.trailingAnchor.constraint(equalTo: trailingAnchor),
            imageView.heightAnchor.constraint(equalToConstant: ThumbnailStripView.tileHeight),
            captionLabel.topAnchor.constraint(equalTo: imageView.bottomAnchor, constant: 1),
            captionLabel.leadingAnchor.constraint(equalTo: leadingAnchor),
            captionLabel.trailingAnchor.constraint(equalTo: trailingAnchor),
            captionLabel.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -1)
        ])

        let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap))
        addGestureRecognizer(tap)
        let press = UILongPressGestureRecognizer(target: self, action: #selector(handleLongPress(_:)))
        press.minimumPressDuration = 0.4
        addGestureRecognizer(press)
    }

    private(set) var isActive: Bool = false

    // R27 v2: per-tile highlight is gone. The strip's floating
    // selectionOverlay sits over (or between) tiles and is the only
    // active-state cue. setActive still tracks the bool for the
    // delegate's tap-step-delta math; visually a tile always looks
    // the same (separator border, secondary background).
    func setActive(_ active: Bool) {
        isActive = active
    }

    func setImage(_ image: UIImage) {
        imageView.image = image
    }

    func clearImage() {
        imageView.image = nil
    }

    @objc private func handleTap() {
        delegate?.tileTapped(self)
    }

    @objc private func handleLongPress(_ gr: UILongPressGestureRecognizer) {
        guard gr.state == .began else { return }
        delegate?.tileLongPressed(self)
    }
}
