import UIKit

// R20 / ADR-0006 thumbnail preview strip. Sits in the band between the
// screen-share video sink and the SpacesDotsView. Renders one tile per
// non-active user Space (the active Space's tile is a "you're here"
// placeholder since WebRTC already shows it).
//
// Tap: emits a `.switchSpaceGesture` swipe directed at the target
// Space, computed from the signed index delta to the active Space.
// Long-press: emits a thumbnailRefresh request via the delegate, which
// routes through the input channel's client-config frame.
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

    private let stack = UIStackView()
    private var tiles: [ThumbnailTileView] = []
    private var orderedSpaces: [SpaceMetadata] = []
    private var activeSpaceId: UInt64?
    private var thumbnails: [String: String] = [:]

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
        stack.axis = .horizontal
        stack.spacing = Self.tileSpacing
        stack.alignment = .center
        stack.distribution = .equalSpacing
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor)
        ])
        isHidden = true
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

    func setActive(_ active: Bool) {
        if active {
            backgroundColor = .tintColor.withAlphaComponent(0.18)
            layer.borderColor = UIColor.tintColor.cgColor
            captionLabel.text = "Here"
            imageView.image = nil
        } else {
            backgroundColor = .secondarySystemBackground
            layer.borderColor = UIColor.separator.cgColor
            captionLabel.text = "Desktop \(ordinal)"
        }
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
