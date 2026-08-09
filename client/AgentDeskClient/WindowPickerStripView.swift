import UIKit
import AgentDeskWire

@MainActor
protocol WindowPickerStripViewDelegate: AnyObject {
    // nil means "go back to watching the whole Desktop".
    func windowPicker(_ view: WindowPickerStripView, didSelectWindowId windowId: UInt32?)
    // The strip's `preferredHeight` changed. The height constraint lives with the layout
    // owner, so expansion has to be reported rather than self-applied.
    func windowPickerDidChangePreferredHeight(_ view: WindowPickerStripView)
}

// Flat horizontal strip of app icons, one per watchable window, sitting directly under the
// Spaces strip.
//
// Collapsed by default to a one-line bar, expanded on demand. Picking a window is an
// occasional act, while the row it used to hold was permanent: 52pt of tiles under the
// Spaces strip, every session, mostly to say "you are watching the whole Desktop", which the
// video already says. Collapsed, the bar reports the current target in a line and hands the
// rest back to the trackpad; tapping opens the tiles, and picking one closes them again.
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
    // claiming its own height, so the tile row stays one tile tall.
    static let tileRowHeight: CGFloat = tileSize + 8
    // The bar is the whole strip when collapsed. Short, because it is a label with a hit
    // target rather than a control cluster, and it spans the full width so the tap target is
    // large in the axis that matters.
    static let barHeight: CGFloat = 28
    static let tileRowGap: CGFloat = 4
    static let collapsedHeight: CGFloat = barHeight
    static let expandedHeight: CGFloat = barHeight + tileRowGap + tileRowHeight

    private var windows: [WindowSummary] = []
    private var icons: [String: UIImage] = [:]
    private var desktopOrdinals: [UInt64: Int] = [:]
    private var selectedWindowId: UInt32?
    private(set) var isExpanded = false

    private lazy var layout: UICollectionViewFlowLayout = {
        let l = UICollectionViewFlowLayout()
        l.scrollDirection = .horizontal
        l.itemSize = CGSize(width: Self.tileSize, height: Self.tileSize)
        l.minimumLineSpacing = Self.tileSpacing
        l.minimumInteritemSpacing = 0
        l.sectionInset = .zero
        return l
    }()

    private let barButton = UIControl()
    private let barChevron = UIImageView()
    private let barTitleLabel = UILabel()
    private let barCountLabel = UILabel()

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
        // The tile row is laid out below the strip's own height while collapsed, so it has to
        // be clipped rather than merely hidden: mid-animation it is partially on screen.
        clipsToBounds = true

        barButton.translatesAutoresizingMaskIntoConstraints = false
        barButton.layer.cornerRadius = 8
        barButton.layer.borderWidth = 1
        barButton.accessibilityIdentifier = "window-picker-bar"
        barButton.isAccessibilityElement = true
        barButton.accessibilityTraits = [.button]
        barButton.addTarget(self, action: #selector(toggleExpansion), for: .touchUpInside)
        addSubview(barButton)

        barChevron.contentMode = .scaleAspectFit
        barChevron.tintColor = .secondaryLabel
        barChevron.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 11, weight: .semibold)
        barChevron.translatesAutoresizingMaskIntoConstraints = false
        barButton.addSubview(barChevron)

        barTitleLabel.font = .systemFont(ofSize: 12, weight: .medium)
        barTitleLabel.textColor = .label
        barTitleLabel.lineBreakMode = .byTruncatingTail
        barTitleLabel.translatesAutoresizingMaskIntoConstraints = false
        barButton.addSubview(barTitleLabel)

        barCountLabel.font = .systemFont(ofSize: 11, weight: .regular)
        barCountLabel.textColor = .secondaryLabel
        barCountLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
        barCountLabel.translatesAutoresizingMaskIntoConstraints = false
        barButton.addSubview(barCountLabel)

        addSubview(collectionView)
        NSLayoutConstraint.activate([
            barButton.leadingAnchor.constraint(equalTo: leadingAnchor),
            barButton.trailingAnchor.constraint(equalTo: trailingAnchor),
            barButton.topAnchor.constraint(equalTo: topAnchor),
            barButton.heightAnchor.constraint(equalToConstant: Self.barHeight),

            barChevron.leadingAnchor.constraint(equalTo: barButton.leadingAnchor, constant: 2),
            barChevron.centerYAnchor.constraint(equalTo: barButton.centerYAnchor),
            barChevron.widthAnchor.constraint(equalToConstant: 14),

            barTitleLabel.leadingAnchor.constraint(equalTo: barChevron.trailingAnchor, constant: 6),
            barTitleLabel.centerYAnchor.constraint(equalTo: barButton.centerYAnchor),
            barTitleLabel.trailingAnchor.constraint(
                lessThanOrEqualTo: barCountLabel.leadingAnchor, constant: -8
            ),

            barCountLabel.trailingAnchor.constraint(equalTo: barButton.trailingAnchor, constant: -2),
            barCountLabel.centerYAnchor.constraint(equalTo: barButton.centerYAnchor),

            collectionView.leadingAnchor.constraint(equalTo: leadingAnchor),
            collectionView.trailingAnchor.constraint(equalTo: trailingAnchor),
            collectionView.topAnchor.constraint(equalTo: barButton.bottomAnchor, constant: Self.tileRowGap),
            collectionView.heightAnchor.constraint(equalToConstant: Self.tileRowHeight)
        ])
        isHidden = true
        renderBar()
        applyExpansionToSubviews()
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
        renderBar()
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
        setExpanded(false)
        renderBar()
    }

    // MARK: - Expansion

    // Collapsed height is the bar alone; expanded adds the tile row. The layout owner reads
    // this after every `windowPickerDidChangePreferredHeight`.
    var preferredHeight: CGFloat { isExpanded ? Self.expandedHeight : Self.collapsedHeight }

    @objc private func toggleExpansion() {
        setExpanded(!isExpanded)
    }

    func setExpanded(_ expanded: Bool) {
        guard expanded != isExpanded else { return }
        isExpanded = expanded
        applyExpansionToSubviews()
        renderBar()
        delegate?.windowPickerDidChangePreferredHeight(self)
    }

    private func applyExpansionToSubviews() {
        collectionView.isHidden = !isExpanded
        barChevron.image = UIImage(systemName: isExpanded ? "chevron.down" : "chevron.right")
    }

    private func renderBar() {
        let title: String
        if let selectedWindowId, let window = windows.first(where: { $0.id == selectedWindowId }) {
            title = window.title.isEmpty ? window.appName : "\(window.appName): \(window.title)"
        } else if selectedWindowId != nil {
            // Selected but no longer listed. Naming it "Whole Desktop" would claim a fallback
            // the host did not make; see `apply(push:)`.
            title = "Window unavailable"
        } else {
            title = "Whole Desktop"
        }
        barTitleLabel.text = title
        barCountLabel.text = windows.isEmpty ? nil : "\(windows.count) windows"
        // Narrowed to one window is the state worth seeing at a glance from the collapsed
        // bar, because it is the state where the trackpad is view-only and the phone is not
        // showing the rest of the Mac.
        let narrowed = selectedWindowId != nil
        barButton.backgroundColor = narrowed
            ? UIColor.tintColor.withAlphaComponent(0.16)
            : .tertiarySystemFill
        barButton.layer.borderColor = narrowed
            ? UIColor.tintColor.cgColor
            : UIColor.clear.cgColor
        barChevron.tintColor = narrowed ? .tintColor : .secondaryLabel
        barButton.accessibilityLabel = "Window picker"
        barButton.accessibilityValue = title
        barButton.accessibilityHint = isExpanded ? "Closes the window list." : "Opens the window list."
    }

    // Visibility has one owner, refreshThumbnailStripVisibility(), same as the two strips
    // above it. This is the only thing it needs from here: a strip carrying nothing but the
    // Whole Desktop tile, with the whole Desktop already showing, is a control for a state
    // you are already in.
    var isEmptyAndIdle: Bool { windows.isEmpty && selectedWindowId == nil }

    // Test affordances.
    var renderedTileCount: Int { windows.count + 1 }
    var currentSelection: UInt32? { selectedWindowId }
    var barTitleText: String? { barTitleLabel.text }
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
        // Picking closes the list either way, including re-picking the current target: the
        // tap was an act of dismissal as much as of selection, and leaving the tiles open
        // would make it read as ignored.
        setExpanded(false)
        guard target != selectedWindowId else { return }
        selectedWindowId = target
        collectionView.reloadData()
        renderBar()
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
