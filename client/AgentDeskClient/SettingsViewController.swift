import AVFoundation
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
    private let spacesDirectionSwitch = UISwitch()
    private let showSpacePreviewsSwitch = UISwitch()
    private let accessoryContainerSlider = UISlider()
    private let accessoryContainerLabel = UILabel()
    private let accessoryKeySlider = UISlider()
    private let accessoryKeyLabel = UILabel()
    private let accessoryGapSlider = UISlider()
    private let accessoryGapLabel = UILabel()
    private let agentSayLanguageButton = UIButton(type: .system)
    private let agentSayVoiceButton = UIButton(type: .system)
    private var agentSayVoices: [AVSpeechSynthesisVoice] = []
    private var agentSayLanguages: [String] = []

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

        let spacesSection = makeSection(
            title: "Spaces",
            rows: [],
            switchRow: ("Match Mac swipe direction", spacesDirectionSwitch)
        )

        // ADR-0006: opt-in for the thumbnail preview strip.
        // Footnote explains the trust posture so the user has the
        // context to decide.
        let previewsSection = makeSection(
            title: "Spaces previews",
            rows: [],
            switchRow: ("Show Space previews", showSpacePreviewsSwitch),
            footnote: "Mirrors thumbnails of your other Spaces to this phone. Off by default; enable only when the phone is somewhere you trust."
        )

        let accessorySection = makeSection(
            title: "Keyboard accessory bar",
            rows: [
                ("Container height", accessoryContainerLabel, accessoryContainerSlider),
                ("Key height", accessoryKeyLabel, accessoryKeySlider),
                ("Key spacing", accessoryGapLabel, accessoryGapSlider)
            ]
        )

        let speechSection = makeSection(
            title: "Speech",
            rows: [],
            customRows: [makeLanguageRow(), makeVoiceRow()],
            footnote: "Used for AgentDesk spoken subtitles. Download higher-quality voices in Settings > Accessibility > Read & Speak > Voices."
        )

        let stack = UIStackView(arrangedSubviews: [cursorSection, scrollSection, spacesSection, previewsSection, speechSection, accessorySection])
        stack.axis = .vertical
        stack.spacing = 28
        stack.translatesAutoresizingMaskIntoConstraints = false

        // Wrap in a scroll view so the third (and any future) section
        // doesn't overflow the screen on small iPhones.
        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.alwaysBounceVertical = true
        view.addSubview(scroll)
        scroll.addSubview(stack)

        // Fixed 20pt horizontal inset. view.layoutMargins is unreliable
        // in viewDidLoad (frame not yet resolved), which is why the
        // sliders previously ran edge to edge.
        let horizontalInset: CGFloat = 20

        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.bottomAnchor),

            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 16),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -32),
            stack.leadingAnchor.constraint(equalTo: scroll.frameLayoutGuide.leadingAnchor, constant: horizontalInset),
            stack.trailingAnchor.constraint(equalTo: scroll.frameLayoutGuide.trailingAnchor, constant: -horizontalInset),
            stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -(horizontalInset * 2))
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
        spacesDirectionSwitch.addTarget(self, action: #selector(spacesDirectionChanged), for: .valueChanged)
        showSpacePreviewsSwitch.addTarget(self, action: #selector(showSpacePreviewsChanged), for: .valueChanged)

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

        configureSpeechMenus()
    }

    private func loadFromStore() {
        cursorSpeedSlider.value = Float(store.cursorSpeed)
        cursorAccelSlider.value = Float(store.cursorAcceleration)
        scrollSpeedSlider.value = Float(store.scrollSpeed)
        scrollDirectionSwitch.isOn = store.scrollInverted
        spacesDirectionSwitch.isOn = store.useMacOSSpacesDirection
        showSpacePreviewsSwitch.isOn = store.showSpacePreviews
        accessoryContainerSlider.value = Float(store.accessoryContainerHeight)
        accessoryKeySlider.value = Float(store.accessoryKeyHeight)
        accessoryGapSlider.value = Float(store.accessoryKeySpacing)
        refreshLanguageButtonTitle()
        refreshVoiceButtonTitle()
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

    @objc private func spacesDirectionChanged() {
        store.useMacOSSpacesDirection = spacesDirectionSwitch.isOn
    }

    @objc private func showSpacePreviewsChanged() {
        store.showSpacePreviews = showSpacePreviewsSwitch.isOn
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

    private func configureSpeechMenus() {
        configureSpeechOptions()
        configureLanguageMenu()
        configureVoiceMenu()
    }

    private func configureSpeechOptions() {
        agentSayVoices = AVSpeechSynthesisVoice.speechVoices()
            .sorted { lhs, rhs in
                let leftRank = voiceQualityRank(lhs.quality)
                let rightRank = voiceQualityRank(rhs.quality)
                if leftRank != rightRank { return leftRank < rightRank }
                if lhs.language != rhs.language { return lhs.language < rhs.language }
                return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
            }
        agentSayLanguages = Array(Set(agentSayVoices.map(\.language)))
            .sorted { lhs, rhs in
                languageDisplayName(lhs).localizedCaseInsensitiveCompare(languageDisplayName(rhs)) == .orderedAscending
            }
        normalizeSpeechSelection()
    }

    private func configureLanguageMenu() {
        agentSayLanguageButton.contentHorizontalAlignment = .trailing
        agentSayLanguageButton.showsMenuAsPrimaryAction = true

        let selectedLanguage = selectedSpeechLanguage()
        let actions = agentSayLanguages.map { language in
            UIAction(
                title: languageDisplayName(language),
                subtitle: language,
                state: language == selectedLanguage ? .on : .off
            ) { [weak self] _ in
                self?.store.agentSayVoiceLanguage = language
                self?.store.agentSayVoiceIdentifier = nil
                self?.configureSpeechMenus()
            }
        }

        agentSayLanguageButton.menu = UIMenu(children: actions)
        refreshLanguageButtonTitle()
    }

    private func configureVoiceMenu() {
        agentSayVoiceButton.contentHorizontalAlignment = .trailing
        agentSayVoiceButton.showsMenuAsPrimaryAction = true

        let selectedLanguage = selectedSpeechLanguage()
        let filteredVoices = voices(for: selectedLanguage)
        let defaultTitle = if let selectedLanguage {
            "Default for \(languageDisplayName(selectedLanguage))"
        } else {
            "System Default"
        }

        let defaultAction = UIAction(
            title: defaultTitle,
            state: store.agentSayVoiceIdentifier == nil ? .on : .off
        ) { [weak self] _ in
            self?.store.agentSayVoiceIdentifier = nil
            self?.configureSpeechMenus()
        }

        let actions = filteredVoices.map { voice in
            UIAction(
                title: voiceMenuTitle(voice),
                subtitle: voice.language,
                state: voice.identifier == store.agentSayVoiceIdentifier ? .on : .off
            ) { [weak self] _ in
                self?.store.agentSayVoiceIdentifier = voice.identifier
                self?.store.agentSayVoiceLanguage = voice.language
                self?.configureSpeechMenus()
            }
        }

        agentSayVoiceButton.menu = UIMenu(children: [defaultAction] + actions)
        refreshVoiceButtonTitle()
    }

    private func normalizeSpeechSelection() {
        if let identifier = store.agentSayVoiceIdentifier,
           let selectedVoice = agentSayVoices.first(where: { $0.identifier == identifier }) {
            if store.agentSayVoiceLanguage != selectedVoice.language {
                store.agentSayVoiceLanguage = selectedVoice.language
            }
            return
        }

        if store.agentSayVoiceIdentifier != nil {
            store.agentSayVoiceIdentifier = nil
        }

        if let language = store.agentSayVoiceLanguage,
           agentSayLanguages.contains(language) {
            return
        }

        let preferred = Locale.preferredLanguages.first { preferredLanguage in
            agentSayLanguages.contains(preferredLanguage)
        } ?? Locale.preferredLanguages.compactMap { preferredLanguage in
            let preferredPrefix = Locale(identifier: preferredLanguage).language.languageCode?.identifier
            return agentSayLanguages.first { candidate in
                Locale(identifier: candidate).language.languageCode?.identifier == preferredPrefix
            }
        }.first

        store.agentSayVoiceLanguage = preferred ?? agentSayLanguages.first
    }

    private func selectedSpeechLanguage() -> String? {
        if let identifier = store.agentSayVoiceIdentifier,
           let voice = agentSayVoices.first(where: { $0.identifier == identifier }) {
            return voice.language
        }
        if let language = store.agentSayVoiceLanguage,
           agentSayLanguages.contains(language) {
            return language
        }
        return agentSayLanguages.first
    }

    private func voices(for language: String?) -> [AVSpeechSynthesisVoice] {
        guard let language else { return agentSayVoices }
        return agentSayVoices.filter { $0.language == language }
    }

    private func refreshLanguageButtonTitle() {
        if let language = selectedSpeechLanguage() {
            agentSayLanguageButton.setTitle(languageDisplayName(language), for: .normal)
        } else {
            agentSayLanguageButton.setTitle("System Default", for: .normal)
        }
    }

    private func refreshVoiceButtonTitle() {
        if let identifier = store.agentSayVoiceIdentifier,
           let voice = agentSayVoices.first(where: { $0.identifier == identifier }) {
            agentSayVoiceButton.setTitle(voiceMenuTitle(voice), for: .normal)
        } else if let language = selectedSpeechLanguage() {
            agentSayVoiceButton.setTitle("Default for \(languageDisplayName(language))", for: .normal)
        } else {
            agentSayVoiceButton.setTitle("System Default", for: .normal)
        }
    }

    private func languageDisplayName(_ language: String) -> String {
        Locale.current.localizedString(forIdentifier: language) ?? language
    }

    private func voiceMenuTitle(_ voice: AVSpeechSynthesisVoice) -> String {
        let quality = voiceQualityLabel(voice.quality)
        return quality.isEmpty ? voice.name : "\(voice.name) (\(quality))"
    }

    private func voiceQualityRank(_ quality: AVSpeechSynthesisVoiceQuality) -> Int {
        switch quality {
        case .premium:
            0
        case .enhanced:
            1
        default:
            2
        }
    }

    private func voiceQualityLabel(_ quality: AVSpeechSynthesisVoiceQuality) -> String {
        switch quality {
        case .premium:
            "Premium"
        case .enhanced:
            "Enhanced"
        default:
            ""
        }
    }

    @objc private func dismissSelf() {
        dismiss(animated: true)
    }

    // Helper: build a section header + a list of (label, value-label, slider)
    // rows, with an optional bottom switch row and optional footnote.
    // Returns a vertical stack.
    private func makeSection(
        title: String,
        rows: [(String, UILabel, UISlider)],
        switchRow: (String, UISwitch)? = nil,
        customRows: [UIView] = [],
        footnote: String? = nil
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
        for row in customRows {
            rowsStack.addArrangedSubview(row)
        }

        let outer = UIStackView(arrangedSubviews: [header, rowsStack])
        outer.axis = .vertical
        outer.spacing = 8

        if let footnote {
            let foot = UILabel()
            foot.text = footnote
            foot.font = .preferredFont(forTextStyle: .caption2)
            foot.textColor = .secondaryLabel
            foot.numberOfLines = 0
            outer.addArrangedSubview(foot)
        }

        return outer
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

    private func makeLanguageRow() -> UIStackView {
        makeMenuRow(name: "Language", button: agentSayLanguageButton)
    }

    private func makeVoiceRow() -> UIStackView {
        makeMenuRow(name: "Voice", button: agentSayVoiceButton)
    }

    private func makeMenuRow(name: String, button: UIButton) -> UIStackView {
        let nameLabel = UILabel()
        nameLabel.text = name
        nameLabel.font = .preferredFont(forTextStyle: .body)
        nameLabel.setContentCompressionResistancePriority(.required, for: .horizontal)

        button.titleLabel?.font = .preferredFont(forTextStyle: .body)
        button.titleLabel?.lineBreakMode = .byTruncatingMiddle

        let row = UIStackView(arrangedSubviews: [nameLabel, button])
        row.axis = .horizontal
        row.spacing = 8
        row.alignment = .center
        return row
    }
}
