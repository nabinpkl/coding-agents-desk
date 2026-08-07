import UIKit
import AgentDeskWire

@MainActor
protocol WindowPickerStripViewDelegate: AnyObject {
    // nil means "go back to watching the whole Desktop".
    func windowPicker(_ view: WindowPickerStripView, didSelectWindowId windowId: UInt32?)
}

// Flat horizontal strip of app icons, one per watchable window, sitting directly under the
// Spaces strip.
//
// Flat rather than grouped by Desktop: the Mac-side Dock enrichment groups per Desktop and
// ends up wide and under-used, while the real Dock stays flat. The Desktop lives on the icon
// as a badge, and the host's Desktop-then-app ordering keeps Desktop-mates adjacent without
// spending a row on a header.
//
// The list is deliberately NOT filtered to the active Desktop. Filtering would read as a
// natural drill-down and would destroy the point: the off-Desktop windows are exactly the
// ones worth watching from a phone, and they stream at roughly a quarter of a full display's
// bitrate.
//
// The first tile is always the whole-Desktop target, so the strip can also get you back out.
// It is the only control here that changes what the trackpad does: a window target is
// view-only, enforced host-side.
@MainActor
final class WindowPickerStripView: UIView {
    weak var delegate: WindowPickerStripViewDelegate?

    static let tileSize: CGFloat = 44
    static let tileSpacing: CGFloat = 10
    // Icon plus a little breathing room; the badge overlaps the icon corner rather than
    // claiming its own height, so the strip stays one tile tall.
    static let stripHeight: CGFloat = tileSize + 8

    private var windows: [WindowSummary] = []
    private var icons: [String: UIImage] = [:]
    private var desktopOrdinals: [UInt64: Int] = [:]
    private var selectedWindowId: UInt32?

    private lazy var layout: UICollectionViewFlowLayout = {
        let l = UICollectionViewFlowLayout()
        l.scrollDirection = .horizontal
        l.itemSize = CGSize(width: Self.tileSize, height: Self.tileSize)
        l.minimumLineSpacing = Self.tileSpacing
        l.minimumInteritemSpacing = 0
        l.sectionInset = .zero
        return l
    }()

    private lazy var collectionView: UICollectionView = {
        let cv = UICollectionView(frame: .zero, collectionViewLayout: layout)
        cv.backgroundColor = .clear
        cv.showsHorizontalScrollIndicator = false
        cv.showsVerticalScrollIndicator = false
        cv.contentInsetAdjustmentBehavior = .never
        cv.dataSource = self
        cv.delegate = self
        cv.register(WindowPickerTileCell.self, forCellWithReuseIdentifier: WindowPickerTileCell.reuseId)
        cv.translatesAutoresizingMaskIntoConstraints = false
        return cv
    }()

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
        accessibilityIdentifier = "window-picker-strip"
        addSubview(collectionView)
        NSLayoutConstraint.activate([
            collectionView.leadingAnchor.constraint(equalTo: leadingAnchor),
            collectionView.trailingAnchor.constraint(equalTo: trailingAnchor),
            collectionView.topAnchor.constraint(equalTo: topAnchor),
            collectionView.bottomAnchor.constraint(equalTo: bottomAnchor)
        ])
        isHidden = true
    }

    // MARK: - State

    func apply(push: WindowListPush) {
        windows = push.windows
        for icon in push.icons {
            guard let data = Data(base64Encoded: icon.png), let image = UIImage(data: data) else { continue }
            icons[icon.hash] = image
        }
        // A selected window that vanished from the list keeps its selection deliberately. It
        // lights no tile, because its tile is gone, and it does not light Whole Desktop either,
        // because that would claim a fallback the host did not make: ADR-0094 holds the dead
        // target and reports it through host availability rather than silently reverting to a
        // 4-6x more expensive display capture. Whole Desktop is one tap away when the user
        // wants it.
        collectionView.reloadData()
    }

    func apply(state: DesktopState) {
        desktopOrdinals = WindowPickerModel.desktopOrdinals(from: state)
        collectionView.reloadData()
    }

    func renderEmpty() {
        windows = []
        selectedWindowId = nil
        desktopOrdinals = [:]
        isHidden = true
        collectionView.reloadData()
    }

    // Visibility has one owner, refreshThumbnailStripVisibility(), same as the two strips
    // above it. This is the only thing it needs from here: a strip carrying nothing but the
    // Whole Desktop tile, with the whole Desktop already showing, is a control for a state
    // you are already in.
    var isEmptyAndIdle: Bool { windows.isEmpty && selectedWindowId == nil }

    // Test affordances.
    var renderedTileCount: Int { windows.count + 1 }
    var currentSelection: UInt32? { selectedWindowId }
}

extension WindowPickerStripView: UICollectionViewDataSource {
    func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
        // +1 for the leading whole-Desktop tile.
        windows.count + 1
    }

    func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
        let cell = collectionView.dequeueReusableCell(
            withReuseIdentifier: WindowPickerTileCell.reuseId, for: indexPath
        ) as! WindowPickerTileCell
        if indexPath.item == 0 {
            cell.configure(
                image: UIImage(systemName: "macwindow.on.rectangle"),
                badge: nil,
                isSelected: selectedWindowId == nil,
                label: "Whole Desktop"
            )
            return cell
        }
        let window = windows[indexPath.item - 1]
        cell.configure(
            image: icons[window.iconHash],
            badge: WindowPickerModel.badgeText(spaceId: window.spaceId, ordinals: desktopOrdinals),
            isSelected: selectedWindowId == window.id,
            label: window.title.isEmpty ? window.appName : "\(window.appName): \(window.title)"
        )
        return cell
    }
}

extension WindowPickerStripView: UICollectionViewDelegate {
    func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
        let target: UInt32? = indexPath.item == 0 ? nil : windows[indexPath.item - 1].id
        guard target != selectedWindowId else { return }
        selectedWindowId = target
        collectionView.reloadData()
        delegate?.windowPicker(self, didSelectWindowId: target)
    }
}

@MainActor
final class WindowPickerTileCell: UICollectionViewCell {
    static let reuseId = "WindowPickerTileCell"

    private let imageView = UIImageView()
    private let badgeLabel = UILabel()

    override init(frame: CGRect) {
        super.init(frame: frame)
        configure()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

    private func configure() {
        contentView.layer.cornerRadius = 10
        contentView.layer.borderWidth = 1.5
        contentView.clipsToBounds = false

        imageView.contentMode = .scaleAspectFit
        imageView.tintColor = .label
        imageView.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(imageView)

        badgeLabel.font = .systemFont(ofSize: 9, weight: .semibold)
        badgeLabel.textColor = .white
        badgeLabel.textAlignment = .center
        badgeLabel.backgroundColor = .tintColor
        badgeLabel.layer.cornerRadius = 7
        badgeLabel.clipsToBounds = true
        badgeLabel.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(badgeLabel)

        NSLayoutConstraint.activate([
            imageView.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 5),
            imageView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 5),
            imageView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -5),
            imageView.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -5),

            badgeLabel.widthAnchor.constraint(equalToConstant: 14),
            badgeLabel.heightAnchor.constraint(equalToConstant: 14),
            badgeLabel.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: 2),
            badgeLabel.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: 2)
        ])
    }

    func configure(image: UIImage?, badge: String?, isSelected: Bool, label: String) {
        imageView.image = image
        badgeLabel.text = badge
        badgeLabel.isHidden = badge == nil
        contentView.layer.borderColor = isSelected
            ? UIColor.tintColor.cgColor
            : UIColor.clear.cgColor
        contentView.backgroundColor = isSelected
            ? UIColor.tintColor.withAlphaComponent(0.16)
            : .clear
        isAccessibilityElement = true
        accessibilityLabel = label
        accessibilityTraits = isSelected ? [.button, .selected] : [.button]
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        imageView.image = nil
        badgeLabel.text = nil
        badgeLabel.isHidden = true
    }
}
