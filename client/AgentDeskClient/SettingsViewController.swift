import AVFoundation
import InteractionPanel
import KeyboardDictation
import UIKit

// Modal settings screen presented from PairingViewController's gear icon.
// Direct edits to SettingsStore on each control event so changes take
// effect immediately without a separate "save" step.
final class SettingsViewController: UIViewController {
    private let store = SettingsStore.shared
    private let keyboardDictationStore: KeyboardDictationStore?

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
    private let cursorDisplayModeControl = UISegmentedControl(
        items: CursorDisplayMode.allCases.map(\.title)
    )
    private let adaptiveMediaQualitySwitch = UISwitch()
    private let diagnosticScreenshotsSwitch = UISwitch()
    // All three manual axes are stepped sliders over the store's own stop lists, so the labels
    // cannot drift from the values they select.
    private let manualMediaBitrateRow = SteppedSliderRow(
        title: "Manual bitrate",
        stops: SettingsStore.manualMediaBitrateKbpsValues.map { kbps in
            SteppedSliderRow.Stop(
                title: "\(kbps) kbps",
                caption: SettingsStore.manualMediaBitrateCaptionedKbps.contains(kbps)
                    ? (kbps >= 1_000 ? String(format: "%.3gk", Double(kbps) / 1_000) : "\(kbps)")
                    : nil
            )
        }
    )
    private let manualMediaFpsRow = SteppedSliderRow(
        title: "Manual FPS",
        stops: SettingsStore.manualMediaFpsValues.map { fps in
            SteppedSliderRow.Stop(
                title: "\(fps)",
                caption: SettingsStore.manualMediaFpsCaptionedValues.contains(fps) ? "\(fps)" : nil
            )
        }
    )
    private let manualMediaResolutionRow = SteppedSliderRow(
        title: "Manual resolution",
        stops: SettingsStore.manualMediaResolutionScaleValues.map { scale in
            let percent = Int((scale * 100).rounded())
            return SteppedSliderRow.Stop(
                title: "\(percent)%",
                caption: SettingsStore.manualMediaResolutionCaptionedPercents.contains(percent)
                    ? "\(percent)%"
                    : nil
            )
        }
    )
    private let manualMediaRows = UIStackView()
    private let remoteInputModeControl = RemoteInputModeControl()
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
    private let keyboardDictationButton = UIButton(type: .system)
    private let keyHapticsSwitch = UISwitch()

    // Ends the current session but keeps the pairing: the phone stays paired and
    // the host shows "Paired but not currently connected". Set by the presenter.
    var onDisconnect: (() -> Void)?
    // Forgets the host on this phone AND tells the host to drop the pairing, so both
    // sides forget each other and pairing must be redone. Set by the presenter.
    var onUnpair: (() -> Void)?
    var onKeyboardDictation: (() -> Void)?

    init(
        keyboardDictationStore: KeyboardDictationStore? =
            SettingsViewController.makeKeyboardDictationStore()
    ) {
        self.keyboardDictationStore = keyboardDictationStore
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        keyboardDictationStore =
            SettingsViewController.makeKeyboardDictationStore()
        super.init(coder: coder)
    }

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
            ],
            customRows: [makeSegmentedRow(
                name: "Visible cursor",
                control: cursorDisplayModeControl
            )],
            footnote: "Client draws the sharp low-latency overlay. Host draws the Mac cursor into the video. Both shows both cursors."
        )

        let scrollSection = makeSection(
            title: "Scroll",
            rows: [
                ("Speed", scrollSpeedLabel, scrollSpeedSlider)
            ],
            switchRow: ("Natural scrolling", scrollDirectionSwitch)
        )

        let spacesSection = makeSection(
            title: "Spaces",
            rows: [],
            switchRow: ("Match Mac swipe direction", spacesDirectionSwitch)
        )

        let videoTouchSection = makeSection(
            title: "Remote input",
            rows: [],
            customRows: [remoteInputModeControl],
            footnote: "Full expands the video and hides the trackpad strip. Touch turns the video surface into remote input for taps and drags; off keeps the video local-only. Auto Key opens the iPhone keyboard after text-field clicks."
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

        diagnosticScreenshotsSwitch.accessibilityIdentifier = "diagnostic-screenshots-enabled"
        diagnosticScreenshotsSwitch.accessibilityLabel = "Allow diagnostic screenshots"
        diagnosticScreenshotsSwitch.accessibilityHint = "Allows the paired Mac to request an image, including sensitive visible text, while AgentDesk is open."
        let diagnosticsSection = makeSection(
            title: "Diagnostics",
            rows: [],
            switchRow: ("Allow paired Mac screenshots", diagnosticScreenshotsSwitch),
            footnote: "Off by default. When enabled, the paired Mac can request the visible AgentDesk app surface while the app is foregrounded. Screenshots may include sensitive text from terminal, browser, workspace, or remote desktop content."
        )

        keyboardDictationButton.setTitle(
            "Activate Keyboard Dictation",
            for: .normal
        )
        keyboardDictationButton.titleLabel?.font = .preferredFont(
            forTextStyle: .body
        )
        keyboardDictationButton.contentHorizontalAlignment = .leading
        keyboardDictationButton.accessibilityIdentifier =
            "keyboard-dictation-settings-button"
        keyboardDictationButton.addTarget(
            self,
            action: #selector(keyboardDictationTapped),
            for: .touchUpInside
        )
        keyHapticsSwitch.accessibilityIdentifier =
            "keyboard-dictation-key-haptics"
        keyHapticsSwitch.accessibilityLabel = "Key haptics"
        keyHapticsSwitch.accessibilityHint =
            "Controls AgentDesk keyboard vibration. Key clicks follow iOS Sounds settings."
        keyHapticsSwitch.addTarget(
            self,
            action: #selector(keyHapticsChanged),
            for: .valueChanged
        )
        let keyboardDictationSection = makeSection(
            title: "Keyboard Dictation",
            rows: [],
            switchRow: ("Key haptics", keyHapticsSwitch),
            customRows: [keyboardDictationButton],
            footnote: "Key clicks follow the iOS Sounds setting. Key haptics controls only AgentDesk vibration. Activate Dictation to connect the systemwide keyboard to the Mac voice service."
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

        let stack = UIStackView(arrangedSubviews: [cursorSection, scrollSection, videoTouchSection, spacesSection, previewsSection, crispSection, mediaQualitySection, speechSection, accessorySection, keyboardDictationSection, diagnosticsSection, connectionSection])
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

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        loadKeyboardDictationServiceState()
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
        // Dragging updates the labels; only letting go writes the store.
        //
        // Writing per `valueChanged` tick meant a full settings commit at touch-sampling
        // rate (up to 120Hz): a UserDefaults write, a global `changedNotification`, a
        // client-config resend over the network, two diagnostics events, and a keyboard
        // accessory rebuild -- measured at 3.45ms of main-thread block per tick, which is
        // most of what made the settings page feel stuck while video was busy. The commit
        // events below cover every way a drag can end.
        for slider in [cursorSpeedSlider, cursorAccelSlider, scrollSpeedSlider] {
            slider.addTarget(self, action: #selector(sliderCommitted), for: .touchUpInside)
            slider.addTarget(self, action: #selector(sliderCommitted), for: .touchUpOutside)
            slider.addTarget(self, action: #selector(sliderCommitted), for: .touchCancel)
        }
        cursorSpeedSlider.addTarget(self, action: #selector(cursorSpeedChanged), for: .valueChanged)
        cursorAccelSlider.addTarget(self, action: #selector(cursorAccelChanged), for: .valueChanged)
        scrollSpeedSlider.addTarget(self, action: #selector(scrollSpeedChanged), for: .valueChanged)
        scrollDirectionSwitch.addTarget(self, action: #selector(scrollDirectionChanged), for: .valueChanged)
        spacesDirectionSwitch.addTarget(self, action: #selector(spacesDirectionChanged), for: .valueChanged)
        showSpacePreviewsSwitch.addTarget(self, action: #selector(showSpacePreviewsChanged), for: .valueChanged)
        crispOverlaySwitch.addTarget(self, action: #selector(crispOverlayChanged), for: .valueChanged)
        cursorDisplayModeControl.accessibilityIdentifier = "cursor-display-mode"
        cursorDisplayModeControl.accessibilityLabel = "Visible cursor"
        cursorDisplayModeControl.addTarget(
            self,
            action: #selector(cursorDisplayModeChanged),
            for: .valueChanged
        )
        adaptiveMediaQualitySwitch.addTarget(self, action: #selector(adaptiveMediaQualityChanged), for: .valueChanged)
        diagnosticScreenshotsSwitch.addTarget(self, action: #selector(diagnosticScreenshotsChanged), for: .valueChanged)
        manualMediaBitrateRow.onSelect = { [weak self] index in
            self?.manualMediaBitrateSelected(index)
        }
        manualMediaFpsRow.onSelect = { [weak self] index in
            self?.manualMediaFpsSelected(index)
        }
        manualMediaResolutionRow.onSelect = { [weak self] index in
            self?.manualMediaResolutionSelected(index)
        }
        configureManualMediaRows()
        remoteInputModeControl.addTarget(self, action: #selector(remoteInputModeChanged), for: .valueChanged)

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

    @objc private func keyboardDictationTapped() {
        dismiss(animated: true) { [weak self] in
            self?.onKeyboardDictation?()
        }
    }

    private func loadFromStore() {
        cursorSpeedSlider.value = Float(store.cursorSpeed)
        cursorAccelSlider.value = Float(store.cursorAcceleration)
        scrollSpeedSlider.value = Float(store.scrollSpeed)
        scrollDirectionSwitch.isOn = store.naturalScrolling
        spacesDirectionSwitch.isOn = store.useMacOSSpacesDirection
        showSpacePreviewsSwitch.isOn = store.showSpacePreviews
        crispOverlaySwitch.isOn = store.crispTextOverlayEnabled
        cursorDisplayModeControl.selectedSegmentIndex = CursorDisplayMode.allCases.firstIndex(
            of: store.cursorDisplayMode
        ) ?? 0
        adaptiveMediaQualitySwitch.isOn = store.adaptiveMediaQualityEnabled
        diagnosticScreenshotsSwitch.isOn = store.diagnosticScreenshotsEnabled
        loadKeyboardDictationPreferences()
        loadKeyboardDictationServiceState()
        manualMediaBitrateRow.selectedIndex = index(
            for: store.manualMediaBitrateKbps,
            in: SettingsStore.manualMediaBitrateKbpsValues
        )
        manualMediaFpsRow.selectedIndex = index(for: store.manualMediaFps, in: manualFpsValues())
        manualMediaResolutionRow.selectedIndex = index(
            for: store.manualMediaResolutionScale,
            in: manualResolutionValues()
        )
        remoteInputModeControl.layoutMode = store.videoLayoutMode
        remoteInputModeControl.videoTouchEnabled = store.videoTouchEnabled
        remoteInputModeControl.autoKeyboardEnabled = store.autoKeyboardEnabled
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
        manualMediaRows.isHidden = adaptiveMediaQualitySwitch.isOn
    }

    private func formatted(_ value: Float) -> String {
        String(format: "%.1fx", value)
    }

    private func formattedPoints(_ value: Float) -> String {
        String(format: "%.0fpt", value)
    }

    /// Live feedback while dragging. The store is written by `sliderCommitted`.
    ///
    /// A slider changed by anything other than a finger (VoiceOver adjustment, a
    /// programmatic set) emits `valueChanged` with no touch-up to follow, so those commit
    /// here instead -- `isTracking` is the difference between the two.
    @objc private func cursorSpeedChanged() {
        refreshLabels()
        if !cursorSpeedSlider.isTracking { commitSliderValues() }
    }

    @objc private func cursorAccelChanged() {
        refreshLabels()
        if !cursorAccelSlider.isTracking { commitSliderValues() }
    }

    @objc private func scrollSpeedChanged() {
        refreshLabels()
        if !scrollSpeedSlider.isTracking { commitSliderValues() }
    }

    @objc private func sliderCommitted() {
        commitSliderValues()
    }

    /// Writes only what actually moved: each setter posts `changedNotification`, and that
    /// notification costs a client-config resend, so three unconditional writes would be
    /// three round trips for one drag.
    private func commitSliderValues() {
        let cursorSpeed = Double(cursorSpeedSlider.value)
        if store.cursorSpeed != cursorSpeed { store.cursorSpeed = cursorSpeed }
        let cursorAcceleration = Double(cursorAccelSlider.value)
        if store.cursorAcceleration != cursorAcceleration { store.cursorAcceleration = cursorAcceleration }
        let scrollSpeed = Double(scrollSpeedSlider.value)
        if store.scrollSpeed != scrollSpeed { store.scrollSpeed = scrollSpeed }
        refreshLabels()
    }

    @objc private func scrollDirectionChanged() {
        store.naturalScrolling = scrollDirectionSwitch.isOn
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

    @objc private func cursorDisplayModeChanged() {
        let modes = CursorDisplayMode.allCases
        guard modes.indices.contains(cursorDisplayModeControl.selectedSegmentIndex) else {
            return
        }
        store.cursorDisplayMode = modes[cursorDisplayModeControl.selectedSegmentIndex]
    }

    @objc private func adaptiveMediaQualityChanged() {
        store.adaptiveMediaQualityEnabled = adaptiveMediaQualitySwitch.isOn
        refreshLabels()
    }

    @objc private func diagnosticScreenshotsChanged() {
        store.diagnosticScreenshotsEnabled = diagnosticScreenshotsSwitch.isOn
    }

    @objc private func keyHapticsChanged() {
        guard let keyboardDictationStore else {
            keyHapticsSwitch.isOn = false
            return
        }
        do {
            var preferences = try keyboardDictationStore.preferences()
            preferences.hapticsEnabled = keyHapticsSwitch.isOn
            try keyboardDictationStore.savePreferences(preferences)
        } catch {
            loadKeyboardDictationPreferences()
            presentKeyboardPreferenceError(error)
        }
    }

    private func manualMediaBitrateSelected(_ index: Int) {
        let values = SettingsStore.manualMediaBitrateKbpsValues
        guard values.indices.contains(index) else { return }
        store.manualMediaBitrateKbps = values[index]
    }

    private func manualMediaFpsSelected(_ index: Int) {
        let values = manualFpsValues()
        guard values.indices.contains(index) else { return }
        store.manualMediaFps = values[index]
    }

    private func manualMediaResolutionSelected(_ index: Int) {
        let values = manualResolutionValues()
        guard values.indices.contains(index) else { return }
        store.manualMediaResolutionScale = values[index]
    }

    @objc private func remoteInputModeChanged() {
        // Writing the store posts changedNotification, which PairingViewController
        // observes and applies via applyVideoTouchState.
        store.setRemoteInputModes(
            layoutMode: remoteInputModeControl.layoutMode,
            videoTouchEnabled: remoteInputModeControl.videoTouchEnabled,
            autoKeyboardEnabled: remoteInputModeControl.autoKeyboardEnabled
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
        agentSayVoices = NativeSpeechVoiceCatalog.currentVoices()
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
        let selection = NativeSpeechVoiceCatalog.resolvedSelection(
            voices: agentSayVoices.map(NativeSpeechVoiceDescriptor.init(voice:)),
            voiceIdentifier: store.agentSayVoiceIdentifier,
            language: store.agentSayVoiceLanguage,
            preferredLanguages: Locale.preferredLanguages,
            languageOrder: agentSayLanguages
        )
        store.agentSayVoiceIdentifier = selection.voiceIdentifier
        store.agentSayVoiceLanguage = selection.language
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
        NativeSpeechVoiceDescriptor(voice: voice).displayName
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

        manualMediaRows.addArrangedSubview(manualMediaBitrateRow)
        manualMediaRows.addArrangedSubview(manualMediaFpsRow)
        manualMediaRows.addArrangedSubview(manualMediaResolutionRow)
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

    private func loadKeyboardDictationPreferences() {
        guard let keyboardDictationStore else {
            keyHapticsSwitch.isOn = false
            keyHapticsSwitch.isEnabled = false
            keyHapticsSwitch.accessibilityHint =
                "The keyboard App Group is unavailable."
            return
        }
        do {
            keyHapticsSwitch.isOn =
                try keyboardDictationStore.preferences().hapticsEnabled
            keyHapticsSwitch.isEnabled = true
        } catch {
            keyHapticsSwitch.isOn = false
            keyHapticsSwitch.isEnabled = false
            keyHapticsSwitch.accessibilityHint = error.localizedDescription
        }
    }

    private func loadKeyboardDictationServiceState() {
        guard let keyboardDictationStore else {
            keyboardDictationButton.setTitle(
                "Keyboard Dictation Unavailable",
                for: .normal
            )
            keyboardDictationButton.isEnabled = false
            return
        }
        do {
            let state = KeyboardDictationContainingAppState(
                snapshot: try keyboardDictationStore.serviceSnapshot()
            )
            keyboardDictationButton.setTitle(
                state.settingsActionTitle,
                for: .normal
            )
            keyboardDictationButton.isEnabled = true
            keyboardDictationButton.accessibilityHint =
                state == .inactive
                    ? "Connects the AgentDesk keyboard to Mac transcription."
                    : "Shows Keyboard Dictation status and controls."
        } catch {
            keyboardDictationButton.setTitle(
                "Keyboard Dictation Needs Attention",
                for: .normal
            )
            keyboardDictationButton.isEnabled = true
            keyboardDictationButton.accessibilityHint =
                error.localizedDescription
        }
    }

    private func presentKeyboardPreferenceError(_ error: any Error) {
        guard presentedViewController == nil else { return }
        let alert = UIAlertController(
            title: "Key haptics could not be saved",
            message: error.localizedDescription,
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        present(alert, animated: true)
    }

    private static func makeKeyboardDictationStore()
        -> KeyboardDictationStore?
    {
        do {
            return try KeyboardDictationStore(
                appGroupIdentifier: KeyboardDictationContract
                    .appGroupIdentifier()
            )
        } catch {
            return nil
        }
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
