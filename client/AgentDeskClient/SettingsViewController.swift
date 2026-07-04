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
    private let crispOverlaySwitch = UISwitch()
    private let hostCursorSwitch = UISwitch()
    private let adaptiveMediaQualitySwitch = UISwitch()
    private let manualMediaBitrateSlider = UISlider()
    private let manualMediaBitrateLabel = UILabel()
    private let manualMediaFpsControl = UISegmentedControl(items: ["6", "10", "15", "24", "30"])
    private let manualMediaResolutionControl = UISegmentedControl(items: ["33%", "50%", "75%", "100%"])
    private let manualMediaRows = UIStackView()
    private let videoTouchControl = VideoTouchControl()
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
    private let disconnectButton = UIButton(type: .system)
    private let unpairButton = UIButton(type: .system)

    // Ends the current session but keeps the pairing: the phone stays paired and
    // the host shows "Paired but not currently connected". Set by the presenter.
    var onDisconnect: (() -> Void)?
    // Forgets the host on this phone AND tells the host to drop the pairing, so both
    // sides forget each other and pairing must be redone. Set by the presenter.
    var onUnpair: (() -> Void)?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        title = "Agent Desk Settings"

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

        let videoTouchSection = makeSection(
            title: "Touch mode",
            rows: [],
            customRows: [videoTouchControl],
            footnote: "Full expands the video and hides the trackpad strip. Touch mode makes video taps click the Mac and video drags scroll it."
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

        // Crisp text overlay: the host paints settled text at full sharpness on top of
        // the video stream. Off falls back to the plain video, which is lighter on the
        // host but softer on static text.
        let crispSection = makeSection(
            title: "Crisp text",
            rows: [],
            switchRow: ("Sharp text overlay", crispOverlaySwitch),
            footnote: "Overlays crisp text on settled regions for sharper reading. Turn off for a lighter, video-only stream."
        )

        // The client always draws its own sharp cursor overlay; this only controls whether
        // the host ALSO bakes the cursor into the video. Off by default (no double-draw).
        let hostCursorSection = makeSection(
            title: "Cursor",
            rows: [],
            switchRow: ("Show host cursor in video", hostCursorSwitch),
            footnote: "Also draws the Mac cursor inside the video stream. Off by default; the phone already shows a sharp cursor overlay, so this is usually redundant."
        )

        let mediaQualitySection = makeSection(
            title: "Video quality",
            rows: [],
            switchRow: ("Adaptive quality ladder", adaptiveMediaQualitySwitch),
            customRows: [manualMediaRows],
            footnote: "Automatically lowers bitrate, frame rate, and video resolution when the link cannot keep up. Turn off to pin the stream to the manual target below."
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

        // Connection: the only place to end a live session or unpair while
        // connected, since the connected screen shows just the gear button (the
        // pairing screen's controls are hidden once connected). Disconnect keeps the
        // pairing; Unpair forgets it on both sides.
        disconnectButton.setTitle("Disconnect", for: .normal)
        disconnectButton.titleLabel?.font = .preferredFont(forTextStyle: .body)
        disconnectButton.contentHorizontalAlignment = .leading
        disconnectButton.accessibilityIdentifier = "disconnect-button"
        disconnectButton.addTarget(self, action: #selector(disconnectTapped), for: .touchUpInside)

        unpairButton.setTitle("Unpair / Forget host", for: .normal)
        unpairButton.setTitleColor(.systemRed, for: .normal)
        unpairButton.titleLabel?.font = .preferredFont(forTextStyle: .body)
        unpairButton.contentHorizontalAlignment = .leading
        unpairButton.accessibilityIdentifier = "unpair-button"
        unpairButton.addTarget(self, action: #selector(unpairTapped), for: .touchUpInside)

        let connectionSection = makeSection(
            title: "Connection",
            rows: [],
            customRows: [disconnectButton, unpairButton],
            footnote: "Disconnect ends the current session but stays paired, so you can reconnect with one tap. Unpair forgets this Mac and needs pairing again from the Mac."
        )

        let stack = UIStackView(arrangedSubviews: [cursorSection, scrollSection, videoTouchSection, spacesSection, previewsSection, crispSection, hostCursorSection, mediaQualitySection, speechSection, accessorySection, connectionSection])
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
        // Scroll now renders smoothly enough that 0.5x is still too fast for
        // fine reading; allow a 0.1x slow-precision floor for scroll only. The
        // slider is continuous, so this just extends the bottom of the range;
        // scrollSpeed is an unclamped multiplier in GestureTranslator.
        scrollSpeedSlider.minimumValue = 0.1
        cursorSpeedSlider.addTarget(self, action: #selector(cursorSpeedChanged), for: .valueChanged)
        cursorAccelSlider.addTarget(self, action: #selector(cursorAccelChanged), for: .valueChanged)
        scrollSpeedSlider.addTarget(self, action: #selector(scrollSpeedChanged), for: .valueChanged)
        scrollDirectionSwitch.addTarget(self, action: #selector(scrollDirectionChanged), for: .valueChanged)
        spacesDirectionSwitch.addTarget(self, action: #selector(spacesDirectionChanged), for: .valueChanged)
        showSpacePreviewsSwitch.addTarget(self, action: #selector(showSpacePreviewsChanged), for: .valueChanged)
        crispOverlaySwitch.addTarget(self, action: #selector(crispOverlayChanged), for: .valueChanged)
        hostCursorSwitch.addTarget(self, action: #selector(hostCursorChanged), for: .valueChanged)
        adaptiveMediaQualitySwitch.addTarget(self, action: #selector(adaptiveMediaQualityChanged), for: .valueChanged)
        manualMediaBitrateSlider.minimumValue = Float(SettingsStore.manualMediaBitrateKbpsRange.lowerBound)
        manualMediaBitrateSlider.maximumValue = Float(SettingsStore.manualMediaBitrateKbpsRange.upperBound)
        manualMediaBitrateSlider.isContinuous = true
        manualMediaBitrateSlider.addTarget(self, action: #selector(manualMediaBitrateChanged), for: .valueChanged)
        manualMediaFpsControl.addTarget(self, action: #selector(manualMediaFpsChanged), for: .valueChanged)
        manualMediaResolutionControl.addTarget(self, action: #selector(manualMediaResolutionChanged), for: .valueChanged)
        configureManualMediaRows()
        videoTouchControl.addTarget(self, action: #selector(videoTouchChanged), for: .valueChanged)

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
        crispOverlaySwitch.isOn = store.crispTextOverlayEnabled
        hostCursorSwitch.isOn = store.showHostCursorInVideo
        adaptiveMediaQualitySwitch.isOn = store.adaptiveMediaQualityEnabled
        manualMediaBitrateSlider.value = Float(store.manualMediaBitrateKbps)
        manualMediaFpsControl.selectedSegmentIndex = index(for: store.manualMediaFps, in: manualFpsValues())
        manualMediaResolutionControl.selectedSegmentIndex = index(for: store.manualMediaResolutionScale, in: manualResolutionValues())
        videoTouchControl.layoutMode = store.videoLayoutMode
        videoTouchControl.videoTouchEnabled = store.videoTouchEnabled
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
        manualMediaBitrateLabel.text = "\(roundedManualBitrate()) kbps"
        manualMediaRows.isHidden = adaptiveMediaQualitySwitch.isOn
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

    @objc private func crispOverlayChanged() {
        // Writing the store posts changedNotification, which PairingViewController observes
        // and resends the client-config from (carrying this crisp preference to the host).
        store.crispTextOverlayEnabled = crispOverlaySwitch.isOn
    }

    @objc private func hostCursorChanged() {
        store.showHostCursorInVideo = hostCursorSwitch.isOn
    }

    @objc private func adaptiveMediaQualityChanged() {
        store.adaptiveMediaQualityEnabled = adaptiveMediaQualitySwitch.isOn
        refreshLabels()
    }

    @objc private func manualMediaBitrateChanged() {
        store.manualMediaBitrateKbps = roundedManualBitrate()
        refreshLabels()
    }

    @objc private func manualMediaFpsChanged() {
        let values = manualFpsValues()
        let index = manualMediaFpsControl.selectedSegmentIndex
        guard values.indices.contains(index) else { return }
        store.manualMediaFps = values[index]
    }

    @objc private func manualMediaResolutionChanged() {
        let values = manualResolutionValues()
        let index = manualMediaResolutionControl.selectedSegmentIndex
        guard values.indices.contains(index) else { return }
        store.manualMediaResolutionScale = values[index]
    }

    @objc private func videoTouchChanged() {
        // Writing the store posts changedNotification, which PairingViewController
        // observes and applies via applyVideoTouchState.
        store.setVideoTouch(
            layoutMode: videoTouchControl.layoutMode,
            enabled: videoTouchControl.videoTouchEnabled
        )
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

    @objc private func disconnectTapped() {
        // Non-destructive (pairing is kept), so no confirmation. Dismiss first so the
        // pairing/reconnect screen is what remains on screen.
        dismiss(animated: true) { [weak self] in
            self?.onDisconnect?()
        }
    }

    @objc private func unpairTapped() {
        let alert = UIAlertController(
            title: "Unpair this Mac?",
            message: "This forgets the pairing on both your phone and the Mac. You'll need to pair again from the Mac to reconnect.",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Unpair", style: .destructive) { [weak self] _ in
            guard let self else { return }
            self.dismiss(animated: true) {
                self.onUnpair?()
            }
        })
        present(alert, animated: true)
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

    private func configureManualMediaRows() {
        manualMediaRows.axis = .vertical
        manualMediaRows.spacing = 12
        manualMediaRows.addArrangedSubview(makeSliderRow(
            name: "Manual bitrate",
            valueLabel: manualMediaBitrateLabel,
            slider: manualMediaBitrateSlider
        ))
        manualMediaRows.addArrangedSubview(makeSegmentedRow(
            name: "Manual FPS",
            control: manualMediaFpsControl
        ))
        manualMediaRows.addArrangedSubview(makeSegmentedRow(
            name: "Manual resolution",
            control: manualMediaResolutionControl
        ))
    }

    private func makeSegmentedRow(name: String, control: UISegmentedControl) -> UIStackView {
        let nameLabel = UILabel()
        nameLabel.text = name
        nameLabel.font = .preferredFont(forTextStyle: .body)

        let row = UIStackView(arrangedSubviews: [nameLabel, control])
        row.axis = .vertical
        row.spacing = 6
        return row
    }

    private func roundedManualBitrate() -> Int {
        Int((manualMediaBitrateSlider.value / 50).rounded() * 50)
    }

    private func manualFpsValues() -> [Int] {
        SettingsStore.manualMediaFpsValues
    }

    private func manualResolutionValues() -> [Double] {
        SettingsStore.manualMediaResolutionScaleValues
    }

    private func index<T: Equatable>(for value: T, in values: [T]) -> Int {
        values.firstIndex(of: value) ?? max(values.count - 1, 0)
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
