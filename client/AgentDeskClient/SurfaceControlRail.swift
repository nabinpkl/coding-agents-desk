import UIKit

/// One vertical home for surface selection and global presentation actions.
///
/// The rail is an overlay: the surface underneath runs the full width of the screen and the
/// rail floats on top of it, the same way it already floats over the gesture webview. Its
/// chevron opens and closes the panel, and closing it leaves only that chevron on screen, so
/// a terminal or agent surface can be read edge to edge without being switched away from.
///
/// The rail owns presentation and selection state only. PairingViewController remains the
/// authoritative owner of the active surface and of every action performed by the utility buttons.
final class SurfaceControlRail: UIView {
    private static let buttonSide: CGFloat = 44
    private static let railWidth: CGFloat = 60
    private static let contentInset: CGFloat = 8

    private let scrollView = UIScrollView()
    private let stackView = UIStackView()
    private let separator = UIView()
    private var surfaceByButton: [ObjectIdentifier: ControlSurface] = [:]
    private var onSelection: ((ControlSurface) -> Void)?

    private(set) var surfaceButtons: [UIButton] = []
    private(set) var isCollapsed = false
    let collapseButton = UIButton(type: .system)
    let utilityButtons: [UIButton]

    var axis: NSLayoutConstraint.Axis { stackView.axis }

    init(
        gestureButton: UIButton,
        orientationButton: UIButton,
        voiceButton: UIButton,
        keyboardDictationButton: UIButton,
        settingsButton: UIButton
    ) {
        utilityButtons = [
            gestureButton,
            orientationButton,
            voiceButton,
            keyboardDictationButton,
            settingsButton,
        ]
        super.init(frame: .zero)
        configureView()
        configureCollapseButton()
        utilityButtons.forEach(configureRailButton)
        rebuildStack()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is unavailable")
    }

    override var intrinsicContentSize: CGSize {
        let contentHeight = stackView.systemLayoutSizeFitting(
            CGSize(width: Self.buttonSide, height: UIView.layoutFittingCompressedSize.height),
            withHorizontalFittingPriority: .required,
            verticalFittingPriority: .fittingSizeLevel
        ).height
        return CGSize(
            width: isCollapsed ? Self.buttonSide : Self.railWidth,
            height: contentHeight + (Self.contentInset * 2)
        )
    }

    func setSurfaces(
        _ surfaces: [ControlSurface],
        selected: ControlSurface,
        onSelection: @escaping (ControlSurface) -> Void
    ) {
        self.onSelection = onSelection
        let currentLabels = surfaceButtons.compactMap(\.accessibilityLabel)
        let nextLabels = surfaces.map(\.switcherAccessibilityLabel)
        if currentLabels != nextLabels {
            surfaceButtons.forEach {
                $0.removeTarget(self, action: #selector(surfaceButtonPressed(_:)), for: .touchUpInside)
            }
            surfaceButtons = surfaces.map(makeSurfaceButton)
            surfaceByButton = Dictionary(
                uniqueKeysWithValues: zip(surfaceButtons, surfaces).map {
                    (ObjectIdentifier($0.0), $0.1)
                }
            )
            rebuildStack()
        }
        select(selected)
    }

    func clearSurfaces() {
        surfaceButtons.forEach {
            $0.removeTarget(self, action: #selector(surfaceButtonPressed(_:)), for: .touchUpInside)
        }
        surfaceButtons = []
        surfaceByButton = [:]
        onSelection = nil
        rebuildStack()
    }

    func select(_ surface: ControlSurface) {
        for button in surfaceButtons {
            let isSelected = surfaceByButton[ObjectIdentifier(button)] == surface
            button.isSelected = isSelected
            updateSelectionAppearance(button, isSelected: isSelected)
        }
    }

    func setUtilityButton(_ button: UIButton, selected: Bool) {
        guard utilityButtons.contains(where: { $0 === button }) else { return }
        button.isSelected = selected
        updateSelectionAppearance(button, isSelected: selected)
    }

    private func configureView() {
        accessibilityIdentifier = "surface-control-rail"
        isAccessibilityElement = false
        isOpaque = false
        backgroundColor = UIColor.black.withAlphaComponent(0.56)
        layer.cornerRadius = 18
        layer.borderWidth = 0.5
        layer.borderColor = UIColor.white.withAlphaComponent(0.18).cgColor
        clipsToBounds = false

        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.alwaysBounceVertical = false
        scrollView.showsVerticalScrollIndicator = false
        scrollView.contentInsetAdjustmentBehavior = .never
        scrollView.backgroundColor = .clear
        addSubview(scrollView)

        stackView.axis = .vertical
        stackView.alignment = .center
        stackView.distribution = .fill
        stackView.spacing = 4
        stackView.translatesAutoresizingMaskIntoConstraints = false
        stackView.accessibilityIdentifier = "surface-switcher"
        scrollView.addSubview(stackView)

        separator.backgroundColor = UIColor.white.withAlphaComponent(0.16)
        separator.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            separator.heightAnchor.constraint(equalToConstant: 1),
            separator.widthAnchor.constraint(equalToConstant: 36)
        ])

        NSLayoutConstraint.activate([
            scrollView.leadingAnchor.constraint(equalTo: leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: bottomAnchor),

            stackView.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor),
            stackView.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor),
            stackView.topAnchor.constraint(
                equalTo: scrollView.contentLayoutGuide.topAnchor,
                constant: Self.contentInset
            ),
            stackView.bottomAnchor.constraint(
                equalTo: scrollView.contentLayoutGuide.bottomAnchor,
                constant: -Self.contentInset
            ),
            stackView.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor)
        ])
    }

    private func configureCollapseButton() {
        collapseButton.accessibilityIdentifier = "surface-control-collapse"
        collapseButton.addTarget(
            self,
            action: #selector(collapseButtonPressed),
            for: .touchUpInside
        )
        configureRailButton(collapseButton)
        updateCollapseButtonAppearance()
    }

    private func rebuildStack() {
        stackView.arrangedSubviews.forEach {
            stackView.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        // The toggle leads the stack so it keeps one fixed position at the top
        // trailing corner: the panel grows downward from it, and a closed rail is
        // that button alone, in the place the user last reached for it.
        stackView.addArrangedSubview(collapseButton)
        surfaceButtons.forEach(stackView.addArrangedSubview)
        stackView.addArrangedSubview(separator)
        utilityButtons.forEach(stackView.addArrangedSubview)
        applyCollapsedState(animated: false)
    }

    private func makeSurfaceButton(_ surface: ControlSurface) -> UIButton {
        let button = UIButton(type: .system)
        button.setImage(UIImage(systemName: surface.switcherSymbolName), for: .normal)
        button.accessibilityLabel = surface.switcherAccessibilityLabel
        button.accessibilityIdentifier = "surface-\(surface.switcherAccessibilityLabel.lowercased())"
        configureRailButton(button)
        button.addTarget(self, action: #selector(surfaceButtonPressed(_:)), for: .touchUpInside)
        return button
    }

    private func configureRailButton(_ button: UIButton) {
        button.translatesAutoresizingMaskIntoConstraints = false
        button.tintColor = .white
        button.layer.shadowColor = UIColor.black.cgColor
        button.layer.shadowOpacity = 0.7
        button.layer.shadowRadius = 2
        button.layer.shadowOffset = .zero
        button.configuration = railButtonConfiguration(
            selected: false,
            image: button.image(for: .normal)
        )
        NSLayoutConstraint.activate([
            button.widthAnchor.constraint(equalToConstant: Self.buttonSide),
            button.heightAnchor.constraint(equalToConstant: Self.buttonSide)
        ])
    }

    private func updateSelectionAppearance(_ button: UIButton, isSelected: Bool) {
        button.configuration = railButtonConfiguration(
            selected: isSelected,
            image: button.image(for: .normal) ?? button.configuration?.image
        )
        if isSelected {
            button.accessibilityTraits.insert(.selected)
        } else {
            button.accessibilityTraits.remove(.selected)
        }
    }

    private func railButtonConfiguration(
        selected: Bool,
        image: UIImage?
    ) -> UIButton.Configuration {
        var configuration = UIButton.Configuration.plain()
        configuration.baseForegroundColor = selected ? .systemBlue : .white
        configuration.image = image
        configuration.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(
            pointSize: 18,
            weight: .regular
        )
        configuration.background.backgroundColor = .clear
        return configuration
    }

    private func setCollapsed(_ collapsed: Bool, animated: Bool) {
        guard collapsed != isCollapsed else { return }
        isCollapsed = collapsed
        applyCollapsedState(animated: animated)
    }

    private func applyCollapsedState(animated: Bool) {
        // Closing the panel removes the controls from the stack outright rather
        // than fading them in place. The rail overlays the active surface, so a
        // full-height transparent column would keep covering content that the
        // user closed the panel to see, and hidden views leave the hit-testing
        // and accessibility trees on their own.
        let controls = surfaceButtons + utilityButtons
        let apply = { [self] in
            controls.forEach { $0.isHidden = isCollapsed }
            separator.isHidden = isCollapsed || surfaceButtons.isEmpty
            invalidateIntrinsicContentSize()
            superview?.layoutIfNeeded()
        }

        scrollView.isScrollEnabled = !isCollapsed
        updateCollapseButtonAppearance()
        superview?.setNeedsLayout()

        guard animated else {
            apply()
            return
        }
        UIView.animate(
            withDuration: 0.2,
            delay: 0,
            options: [.beginFromCurrentState, .curveEaseInOut],
            animations: apply
        )
    }

    private func updateCollapseButtonAppearance() {
        let symbolName = isCollapsed ? "chevron.left" : "chevron.right"
        collapseButton.configuration = railButtonConfiguration(
            selected: false,
            image: UIImage(systemName: symbolName)
        )
        collapseButton.accessibilityLabel = isCollapsed ? "Expand controls" : "Collapse controls"
        collapseButton.accessibilityValue = isCollapsed ? "Collapsed" : "Expanded"
    }

    @objc func collapseButtonPressed() {
        setCollapsed(!isCollapsed, animated: true)
    }

    @objc func surfaceButtonPressed(_ sender: UIButton) {
        guard let surface = surfaceByButton[ObjectIdentifier(sender)] else { return }
        select(surface)
        onSelection?(surface)
    }
}
