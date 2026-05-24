import UIKit

// Modal settings screen presented from PairingViewController's gear icon.
// Direct edits to SettingsStore on each control event so changes take
// effect immediately without a separate "save" step.
final class SettingsViewController: UIViewController {
    private let store = SettingsStore.shared

    private let cursorSpeedSlider = UISlider()
    private let cursorSpeedLabel = UILabel()
    private let cursorAccelSlider = UISlider()
    private let cursorAccelLabel = UILabel()
    private let scrollSpeedSlider = UISlider()
    private let scrollSpeedLabel = UILabel()
    private let scrollDirectionSwitch = UISwitch()
    private let accessoryContainerSlider = UISlider()
    private let accessoryContainerLabel = UILabel()
    private let accessoryKeySlider = UISlider()
    private let accessoryKeyLabel = UILabel()
    private let accessoryGapSlider = UISlider()
    private let accessoryGapLabel = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        title = "Trackpad Settings"

        navigationItem.rightBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .done,
            target: self,
            action: #selector(dismissSelf)
        )

        let cursorSection = makeSection(
            title: "Cursor",
            rows: [
                ("Speed", cursorSpeedLabel, cursorSpeedSlider),
                ("Acceleration", cursorAccelLabel, cursorAccelSlider)
            ]
        )

        let scrollSection = makeSection(
            title: "Scroll",
            rows: [
                ("Speed", scrollSpeedLabel, scrollSpeedSlider)
            ],
            switchRow: ("Invert direction", scrollDirectionSwitch)
        )

        let accessorySection = makeSection(
            title: "Keyboard accessory bar",
            rows: [
                ("Container height", accessoryContainerLabel, accessoryContainerSlider),
                ("Key height", accessoryKeyLabel, accessoryKeySlider),
                ("Key spacing", accessoryGapLabel, accessoryGapSlider)
            ]
        )

        let stack = UIStackView(arrangedSubviews: [cursorSection, scrollSection, accessorySection])
        stack.axis = .vertical
        stack.spacing = 28
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)

        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 16),
            stack.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor)
        ])

        configureSliders()
        loadFromStore()
    }

    private func configureSliders() {
        // Range 0.5x - 3.0x covers "slow precision" through "fast flick"
        // without giving the user a way to set unusable extremes.
        for slider in [cursorSpeedSlider, cursorAccelSlider, scrollSpeedSlider] {
            slider.minimumValue = 0.5
            slider.maximumValue = 3.0
            slider.isContinuous = true
        }
        cursorSpeedSlider.addTarget(self, action: #selector(cursorSpeedChanged), for: .valueChanged)
        cursorAccelSlider.addTarget(self, action: #selector(cursorAccelChanged), for: .valueChanged)
        scrollSpeedSlider.addTarget(self, action: #selector(scrollSpeedChanged), for: .valueChanged)
        scrollDirectionSwitch.addTarget(self, action: #selector(scrollDirectionChanged), for: .valueChanged)

        // Accessory bar tunings live in points so the slider value maps
        // directly to layout. Ranges chosen to cover "tiny chiclet" to
        // "iPad-tall" without nonsense extremes.
        accessoryContainerSlider.minimumValue = 28
        accessoryContainerSlider.maximumValue = 80
        accessoryContainerSlider.isContinuous = true
        accessoryContainerSlider.addTarget(self, action: #selector(accessoryContainerChanged), for: .valueChanged)

        accessoryKeySlider.minimumValue = 20
        accessoryKeySlider.maximumValue = 64
        accessoryKeySlider.isContinuous = true
        accessoryKeySlider.addTarget(self, action: #selector(accessoryKeyChanged), for: .valueChanged)

        accessoryGapSlider.minimumValue = 0
        accessoryGapSlider.maximumValue = 16
        accessoryGapSlider.isContinuous = true
        accessoryGapSlider.addTarget(self, action: #selector(accessoryGapChanged), for: .valueChanged)
    }

    private func loadFromStore() {
        cursorSpeedSlider.value = Float(store.cursorSpeed)
        cursorAccelSlider.value = Float(store.cursorAcceleration)
        scrollSpeedSlider.value = Float(store.scrollSpeed)
        scrollDirectionSwitch.isOn = store.scrollInverted
        accessoryContainerSlider.value = Float(store.accessoryContainerHeight)
        accessoryKeySlider.value = Float(store.accessoryKeyHeight)
        accessoryGapSlider.value = Float(store.accessoryKeySpacing)
        refreshLabels()
    }

    private func refreshLabels() {
        cursorSpeedLabel.text = formatted(cursorSpeedSlider.value)
        cursorAccelLabel.text = formatted(cursorAccelSlider.value)
        scrollSpeedLabel.text = formatted(scrollSpeedSlider.value)
        accessoryContainerLabel.text = formattedPoints(accessoryContainerSlider.value)
        accessoryKeyLabel.text = formattedPoints(accessoryKeySlider.value)
        accessoryGapLabel.text = formattedPoints(accessoryGapSlider.value)
    }

    private func formatted(_ value: Float) -> String {
        String(format: "%.1fx", value)
    }

    private func formattedPoints(_ value: Float) -> String {
        String(format: "%.0fpt", value)
    }

    @objc private func cursorSpeedChanged() {
        store.cursorSpeed = Double(cursorSpeedSlider.value)
        refreshLabels()
    }

    @objc private func cursorAccelChanged() {
        store.cursorAcceleration = Double(cursorAccelSlider.value)
        refreshLabels()
    }

    @objc private func scrollSpeedChanged() {
        store.scrollSpeed = Double(scrollSpeedSlider.value)
        refreshLabels()
    }

    @objc private func scrollDirectionChanged() {
        store.scrollInverted = scrollDirectionSwitch.isOn
    }

    @objc private func accessoryContainerChanged() {
        store.accessoryContainerHeight = Double(accessoryContainerSlider.value)
        refreshLabels()
    }

    @objc private func accessoryKeyChanged() {
        store.accessoryKeyHeight = Double(accessoryKeySlider.value)
        refreshLabels()
    }

    @objc private func accessoryGapChanged() {
        store.accessoryKeySpacing = Double(accessoryGapSlider.value)
        refreshLabels()
    }

    @objc private func dismissSelf() {
        dismiss(animated: true)
    }

    // Helper: build a section header + a list of (label, value-label, slider)
    // rows, with an optional bottom switch row. Returns a vertical stack.
    private func makeSection(
        title: String,
        rows: [(String, UILabel, UISlider)],
        switchRow: (String, UISwitch)? = nil
    ) -> UIStackView {
        let header = UILabel()
        header.text = title.uppercased()
        header.font = .preferredFont(forTextStyle: .footnote)
        header.textColor = .secondaryLabel

        let rowsStack = UIStackView()
        rowsStack.axis = .vertical
        rowsStack.spacing = 12

        for (name, valueLabel, slider) in rows {
            rowsStack.addArrangedSubview(makeSliderRow(name: name, valueLabel: valueLabel, slider: slider))
        }

        if let (name, control) = switchRow {
            rowsStack.addArrangedSubview(makeSwitchRow(name: name, control: control))
        }

        let stack = UIStackView(arrangedSubviews: [header, rowsStack])
        stack.axis = .vertical
        stack.spacing = 8
        return stack
    }

    private func makeSliderRow(name: String, valueLabel: UILabel, slider: UISlider) -> UIStackView {
        let nameLabel = UILabel()
        nameLabel.text = name
        nameLabel.font = .preferredFont(forTextStyle: .body)

        valueLabel.font = .preferredFont(forTextStyle: .body)
        valueLabel.textColor = .secondaryLabel
        valueLabel.setContentHuggingPriority(.required, for: .horizontal)
        valueLabel.textAlignment = .right
        valueLabel.widthAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true

        let top = UIStackView(arrangedSubviews: [nameLabel, valueLabel])
        top.axis = .horizontal
        top.spacing = 8

        let row = UIStackView(arrangedSubviews: [top, slider])
        row.axis = .vertical
        row.spacing = 4
        return row
    }

    private func makeSwitchRow(name: String, control: UISwitch) -> UIStackView {
        let nameLabel = UILabel()
        nameLabel.text = name
        nameLabel.font = .preferredFont(forTextStyle: .body)

        let row = UIStackView(arrangedSubviews: [nameLabel, control])
        row.axis = .horizontal
        row.spacing = 8
        row.alignment = .center
        return row
    }
}
