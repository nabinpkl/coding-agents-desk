import UIKit
import AgentDeskWire

@MainActor
protocol WindowPickerStripViewDelegate: AnyObject {
    // nil means "go back to watching the whole Desktop".
    func windowPicker(_ view: WindowPickerStripView, didSelectWindowId windowId: UInt32?)
    // The strip's `preferredHeight` changed. The height constraint lives with the layout
    // owner, so expansion has to be reported rather than self-applied.
    func windowPickerDidChangePreferredHeight(_ view: WindowPickerStripView)
    // The user changed the disclosure, by tapping the bar or by picking a window. Distinct
    // from the height report because the strip is also collapsed by the layout owner
    // (keyboard up, strip hidden, teardown), and only a deliberate change should be
    // remembered as the preferred resting state.
    func windowPickerDidToggleExpansion(_ view: WindowPickerStripView)
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
    // The bar is the whole strip when collapsed: a sliver carrying the window glyph that says
    // which strip this is. It spans the full width so the tap target is large in the axis
    // that matters.
    static let barHeight: CGFloat = 28
    // The identifying glyph. Open, the bar shrinks to this column and the tiles take the rest
    // of the row, so the disclosure control costs no vertical band of its own.
    //
    // One glyph, not a chevron beside one, for the same reason as the Spaces strip above:
    // horizontal is the axis that runs out, and the filled variant says open just as well as
    // a second symbol did. This is why the glyph is no longer `macwindow` -- it has no filled
    // variant in the catalog, and tint is already spoken for here (see `renderBar`, where it
    // means "narrowed to one window"). Two overlapping squares is also the more honest shape
    // for a list of windows.
    static let iconWidth: CGFloat = 20
    static let leadColumnWidth: CGFloat = iconWidth
    // Dead space between the glyph and the first tile, claimed by the bar as target area
    // rather than left beside a 20pt-wide control. See `barWidthConstraint`.
    static let leadColumnGap: CGFloat = 4
    static let rowVerticalPadding: CGFloat = 4
    static let collapsedHeight: CGFloat = barHeight
    // The tile row alone. It used to be the row plus a label band above it, which spent 32pt
    // restating what the video and the icon already say.
    static let expandedHeight: CGFloat = tileRowHeight + rowVerticalPadding * 2

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
    private let barIcon = UIImageView()
    private var barTrailingConstraint: NSLayoutConstraint?
    private var barWidthConstraint: NSLayoutConstraint?

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
        barButton.accessibilityIdentifier = "window-picker-bar"
        barButton.isAccessibilityElement = true
        barButton.accessibilityTraits = [.button]
        barButton.addTarget(self, action: #selector(toggleExpansion), for: .touchUpInside)
        addSubview(barButton)

        // Two closed slivers stacked one above the other are indistinguishable by a bare
        // disclosure, so each carries the glyph for what it opens. `applyExpansionToSubviews`
        // owns the image, since which variant is right depends on the disclosure.
        barIcon.contentMode = .center
        barIcon.tintColor = .secondaryLabel
        barIcon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 13, weight: .regular)
        barIcon.translatesAutoresizingMaskIntoConstraints = false
        barButton.addSubview(barIcon)

        addSubview(collectionView)

        let barTrailing = barButton.trailingAnchor.constraint(equalTo: trailingAnchor)
        // The gap is inside the target, not beside it: open, this is the way back out, and a
        // bare 20pt column is a thin thing to hit next to a full-height row of tiles.
        let barWidth = barButton.widthAnchor.constraint(
            equalToConstant: Self.leadColumnWidth + Self.leadColumnGap
        )
        barTrailingConstraint = barTrailing
        barWidthConstraint = barWidth
        barTrailing.isActive = true
        NSLayoutConstraint.activate([
            barButton.leadingAnchor.constraint(equalTo: leadingAnchor),
            barButton.topAnchor.constraint(equalTo: topAnchor),
            // Full height rather than the bar's own: open, this column is the way back out,
            // and a short target beside a 52pt tile row is easy to miss.
            barButton.bottomAnchor.constraint(equalTo: bottomAnchor),

            barIcon.leadingAnchor.constraint(equalTo: barButton.leadingAnchor),
            barIcon.widthAnchor.constraint(equalToConstant: Self.iconWidth),
            barIcon.topAnchor.constraint(equalTo: barButton.topAnchor),
            barIcon.bottomAnchor.constraint(equalTo: barButton.bottomAnchor),

            // Fixed inset rather than a chain off the bar: the bar spans the strip while
            // closed, and anchoring the row to its trailing edge would collapse it to nothing.
            collectionView.leadingAnchor.constraint(
                equalTo: leadingAnchor, constant: Self.leadColumnWidth + Self.leadColumnGap
            ),
            collectionView.trailingAnchor.constraint(equalTo: trailingAnchor),
            collectionView.topAnchor.constraint(equalTo: topAnchor, constant: Self.rowVerticalPadding),
            collectionView.bottomAnchor.constraint(
                equalTo: bottomAnchor, constant: -Self.rowVerticalPadding
            )
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
        delegate?.windowPickerDidToggleExpansion(self)
    }

    func setExpanded(_ expanded: Bool) {
        guard expanded != isExpanded else { return }
        isExpanded = expanded
        applyExpansionToSubviews()
        renderBar()
        delegate?.windowPickerDidChangePreferredHeight(self)
    }

    private func applyExpansionToSubviews() {
        // Closed, the bar spans the strip so the whole sliver is the target. Open, it yields
        // everything past the lead column to the tiles, and the strip itself carries the fill.
        barTrailingConstraint?.isActive = !isExpanded
        barWidthConstraint?.isActive = isExpanded
        backgroundColor = isExpanded ? .secondarySystemFill : .clear
        // Hidden rather than merely off-screen: a closed strip must not eat taps meant for the
        // surface below it.
        collectionView.isHidden = !isExpanded
        // Filled means open, the same encoding the Spaces strip above uses. Both names were
        // checked against the symbol catalog rather than assumed: `UIImage(systemName:)`
        // answers nil for a name that does not exist, and the control would render as
        // nothing at all. `macwindow.fill`, the obvious first guess, is one of those.
        barIcon.image = UIImage(systemName: isExpanded ? "square.fill.on.square" : "square.on.square")
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
        // Narrowed to one window is the state worth seeing at a glance from the closed strip,
        // because it is the state where the trackpad is view-only and the phone is not showing
        // the rest of the Mac. With the label row gone the glyph carries it: tinted means one
        // window, grey means the whole desktop.
        let narrowed = selectedWindowId != nil
        barIcon.tintColor = narrowed ? .tintColor : .secondaryLabel
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
    // The target's name has no visible label any more, so accessibility is where it lives.
    var barTitleText: String? { barButton.accessibilityValue }
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
        // A pick-close is the user choosing a resting state as much as a bar tap is, so it is
        // remembered too. Without this the next DesktopState push would re-open the row the
        // user just dismissed.
        delegate?.windowPickerDidToggleExpansion(self)
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
