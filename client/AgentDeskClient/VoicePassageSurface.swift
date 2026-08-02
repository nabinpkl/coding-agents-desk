import AVFoundation
import UIKit

@available(iOS 26.0, *)
@MainActor
final class VoicePassageSurface: UIView {
    private let stack = UIStackView()
    private let libraryStack = UIStackView()
    private let detailStack = UIStackView()

    private let recordButton = UIButton(type: .system)
    private let libraryStatusLabel = UILabel()
    private let recordingWaveformContainer = UIStackView()
    private let recordingWaveformView = VoiceWaveformView()
    private let samplesStack = UIStackView()
    private let recordingsStack = UIStackView()

    private let detailTitleLabel = UILabel()
    private let detailMetadataLabel = UILabel()
    private let detailStatusLabel = UILabel()
    private let playButton = UIButton(type: .system)
    private let reanalyzeButton = UIButton(type: .system)
    private let deleteButton = UIButton(type: .system)
    private let phoneModelControl = UISegmentedControl(
        items: VoicePassagePhoneModel.allCases.map(\.displayName)
    )
    private let playbackWaveformContainer = UIStackView()
    private let playbackWaveformView = VoiceWaveformView()
    private let transcriptView = UITextView()
    private let observedPhonesLabel = UILabel()
    private let referencePhonesLabel = UILabel()
    private let referenceDetailLabel = UILabel()

    private let probe = VoiceContextProbe()
    private let phoneAnalyzer: VoicePassagePhoneAnalyzer
    private let pronouncer = VoicePassagePronouncer()
    private let recordingStore: VoicePassageRecordingStore
    private let resourceBundle: Bundle
    private let userDefaults: UserDefaults

    private var recordings: [VoicePassageRecording] = []
    private var selectedRecordingID: UUID?
    private var isPrepared = false
    private var preparationTask: Task<Void, Never>?
    private var recordingTask: Task<Void, Never>?
    private var analysisTask: Task<Void, Never>?
    private var referenceUpdateTask: Task<Void, Never>?
    private var waveformTask: Task<Void, Never>?
    private var recordingLimitTask: Task<Void, Never>?
    private var audioPlayer: AVAudioPlayer?
    private var displayedLevel: Float = 0

    override init(frame: CGRect) {
        recordingStore = VoicePassageRecordingStore()
        resourceBundle = .main
        userDefaults = .standard
        phoneAnalyzer = VoicePassagePhoneAnalyzer()
        super.init(frame: frame)
        configure()
        loadLibrary()
        probe.onCaptureInterrupted = { [weak self] message in
            self?.finishRecording(interruptionMessage: message)
        }
    }

    /// `resourceBundle` still resolves the sample recording, which is small
    /// enough to keep shipping in the app. `assets` resolves the models, which
    /// are not in any bundle any more, so the two are separate arguments.
    init(
        frame: CGRect,
        recordingStore: VoicePassageRecordingStore,
        resourceBundle: Bundle,
        assets: VoiceAssetCache = .shared,
        userDefaults: UserDefaults = .standard
    ) {
        self.recordingStore = recordingStore
        self.resourceBundle = resourceBundle
        self.userDefaults = userDefaults
        phoneAnalyzer = VoicePassagePhoneAnalyzer(
            assets: assets
        )
        super.init(frame: frame)
        configure()
        loadLibrary()
        probe.onCaptureInterrupted = { [weak self] message in
            self?.finishRecording(interruptionMessage: message)
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is unavailable")
    }

    func activate() {
        guard preparationTask == nil, !isPrepared else { return }
        preparationTask = Task { [weak self] in
            guard let self else { return }
            do {
                try await probe.preparePassageCapture {
                    [weak self] message in
                    self?.libraryStatusLabel.text = message
                }
                guard !Task.isCancelled else { return }
                isPrepared = true
                recordButton.isEnabled = true
                libraryStatusLabel.text = probe.transcriptionAvailable
                    ? "Ready. Record a passage of up to two minutes."
                    : """
                    Ready to record. Transcription is unavailable here; \
                    saved audio and samples can still be analyzed.
                    """
            } catch {
                guard !Task.isCancelled else { return }
                libraryStatusLabel.text =
                    "Audio setup failed: \(error.localizedDescription)"
            }
            preparationTask = nil
        }
    }

    func suspend() {
        recordingTask?.cancel()
        recordingTask = nil
        recordingLimitTask?.cancel()
        recordingLimitTask = nil
        stopPlayback()
        if probe.isRecording {
            finishRecording(
                interruptionMessage:
                    "Recording stopped and saved when you left Passage."
            )
        }
    }

    func teardown() {
        suspend()
        preparationTask?.cancel()
        preparationTask = nil
        referenceUpdateTask?.cancel()
        referenceUpdateTask = nil
        analysisTask?.cancel()
        analysisTask = nil
        waveformTask?.cancel()
        waveformTask = nil
        probe.onCaptureInterrupted = nil
    }

    private func configure() {
        stack.axis = .vertical
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor)
        ])

        configureLibrary()
        configureDetail()
        stack.addArrangedSubview(libraryStack)
        stack.addArrangedSubview(detailStack)
        detailStack.isHidden = true
    }

    private func configureLibrary() {
        libraryStack.axis = .vertical
        libraryStack.spacing = 12
        libraryStack.accessibilityIdentifier = "voice-passage-library"

        let title = heading("Passage recordings")
        libraryStack.addArrangedSubview(title)
        libraryStack.addArrangedSubview(
            detailLabel(
                "Record freely, or open a saved take to replay and "
                    + "reanalyze the same audio."
            )
        )

        var configuration = UIButton.Configuration.filled()
        configuration.title = "Record"
        configuration.image = UIImage(systemName: "mic.fill")
        configuration.imagePadding = 8
        configuration.cornerStyle = .capsule
        recordButton.configuration = configuration
        recordButton.isEnabled = false
        recordButton.accessibilityIdentifier = "voice-passage-record"
        recordButton.addTarget(
            self,
            action: #selector(toggleRecording),
            for: .touchUpInside
        )
        libraryStack.addArrangedSubview(recordButton)

        libraryStatusLabel.font = .preferredFont(
            forTextStyle: .footnote
        )
        libraryStatusLabel.adjustsFontForContentSizeCategory = true
        libraryStatusLabel.textColor = .secondaryLabel
        libraryStatusLabel.numberOfLines = 0
        libraryStatusLabel.text = "Preparing audio capture…"
        libraryStatusLabel.accessibilityIdentifier =
            "voice-passage-status"
        libraryStack.addArrangedSubview(libraryStatusLabel)

        recordingWaveformContainer.axis = .vertical
        recordingWaveformContainer.spacing = 6
        recordingWaveformContainer.isHidden = true
        recordingWaveformContainer.addArrangedSubview(
            detailLabel("Live microphone")
        )
        recordingWaveformView.tintColor = .systemRed
        recordingWaveformView.accessibilityIdentifier =
            "voice-passage-waveform"
        recordingWaveformContainer.addArrangedSubview(
            recordingWaveformView
        )
        libraryStack.addArrangedSubview(recordingWaveformContainer)

        libraryStack.addArrangedSubview(sectionLabel("Samples"))
        samplesStack.axis = .vertical
        samplesStack.spacing = 10
        samplesStack.accessibilityIdentifier =
            "voice-passage-samples"
        libraryStack.addArrangedSubview(samplesStack)

        libraryStack.addArrangedSubview(
            sectionLabel("Saved recordings")
        )
        recordingsStack.axis = .vertical
        recordingsStack.spacing = 10
        recordingsStack.accessibilityIdentifier =
            "voice-passage-recordings"
        libraryStack.addArrangedSubview(recordingsStack)
    }

    private func configureDetail() {
        detailStack.axis = .vertical
        detailStack.spacing = 12
        detailStack.accessibilityIdentifier = "voice-passage-detail"

        let backButton = UIButton(type: .system)
        var backConfiguration = UIButton.Configuration.plain()
        backConfiguration.title = "Back to recordings"
        backConfiguration.image = UIImage(
            systemName: "chevron.backward"
        )
        backConfiguration.imagePadding = 6
        backConfiguration.contentInsets = .zero
        backButton.configuration = backConfiguration
        backButton.contentHorizontalAlignment = .leading
        backButton.accessibilityIdentifier =
            "voice-passage-back-to-recordings"
        backButton.addTarget(
            self,
            action: #selector(showLibrary),
            for: .touchUpInside
        )
        detailStack.addArrangedSubview(backButton)

        detailTitleLabel.font = .preferredFont(
            forTextStyle: .title2
        )
        detailTitleLabel.adjustsFontForContentSizeCategory = true
        detailTitleLabel.numberOfLines = 0
        detailStack.addArrangedSubview(detailTitleLabel)

        detailMetadataLabel.font = .preferredFont(
            forTextStyle: .footnote
        )
        detailMetadataLabel.adjustsFontForContentSizeCategory = true
        detailMetadataLabel.textColor = .secondaryLabel
        detailMetadataLabel.numberOfLines = 0
        detailStack.addArrangedSubview(detailMetadataLabel)

        let actions = UIStackView()
        actions.axis = .horizontal
        actions.spacing = 8
        actions.distribution = .fillEqually

        playButton.setTitle("Play", for: .normal)
        playButton.setImage(
            UIImage(systemName: "play.fill"),
            for: .normal
        )
        playButton.accessibilityIdentifier =
            "voice-passage-play"
        playButton.addTarget(
            self,
            action: #selector(togglePlayback),
            for: .touchUpInside
        )
        actions.addArrangedSubview(playButton)

        reanalyzeButton.setTitle("Reanalyze", for: .normal)
        reanalyzeButton.setImage(
            UIImage(systemName: "waveform.badge.magnifyingglass"),
            for: .normal
        )
        reanalyzeButton.accessibilityIdentifier =
            "voice-passage-reanalyze"
        reanalyzeButton.addTarget(
            self,
            action: #selector(reanalyzeSelectedRecording),
            for: .touchUpInside
        )
        actions.addArrangedSubview(reanalyzeButton)

        deleteButton.setTitle("Delete", for: .normal)
        deleteButton.setImage(
            UIImage(systemName: "trash"),
            for: .normal
        )
        deleteButton.setTitleColor(.systemRed, for: .normal)
        deleteButton.tintColor = .systemRed
        deleteButton.accessibilityIdentifier =
            "voice-passage-delete"
        deleteButton.addTarget(
            self,
            action: #selector(deleteSelectedRecording),
            for: .touchUpInside
        )
        actions.addArrangedSubview(deleteButton)
        detailStack.addArrangedSubview(actions)

        let modelChooser = UIStackView()
        modelChooser.axis = .vertical
        modelChooser.spacing = 6
        modelChooser.addArrangedSubview(
            detailLabel("Phone model for the next analysis")
        )
        phoneModelControl.selectedSegmentIndex =
            VoicePassagePhoneModel.allCases.firstIndex(
                of: selectedPhoneModel
            ) ?? 0
        phoneModelControl.accessibilityIdentifier =
            "voice-passage-phone-model"
        phoneModelControl.addTarget(
            self,
            action: #selector(phoneModelChanged),
            for: .valueChanged
        )
        modelChooser.addArrangedSubview(phoneModelControl)
        detailStack.addArrangedSubview(modelChooser)

        playbackWaveformContainer.axis = .vertical
        playbackWaveformContainer.spacing = 6
        playbackWaveformContainer.isHidden = true
        playbackWaveformContainer.addArrangedSubview(
            detailLabel("Saved recording playback")
        )
        playbackWaveformView.tintColor = .systemBlue
        playbackWaveformView.accessibilityIdentifier =
            "voice-passage-playback-waveform"
        playbackWaveformContainer.addArrangedSubview(
            playbackWaveformView
        )
        detailStack.addArrangedSubview(
            playbackWaveformContainer
        )

        detailStatusLabel.font = .preferredFont(
            forTextStyle: .footnote
        )
        detailStatusLabel.adjustsFontForContentSizeCategory = true
        detailStatusLabel.textColor = .secondaryLabel
        detailStatusLabel.numberOfLines = 0
        detailStatusLabel.accessibilityIdentifier =
            "voice-passage-detail-status"
        detailStack.addArrangedSubview(detailStatusLabel)

        transcriptView.font = .preferredFont(forTextStyle: .body)
        transcriptView.adjustsFontForContentSizeCategory = true
        transcriptView.backgroundColor = .clear
        transcriptView.textContainerInset = .zero
        transcriptView.textContainer.lineFragmentPadding = 0
        transcriptView.isScrollEnabled = false
        transcriptView.delegate = self
        transcriptView.accessibilityIdentifier =
            "voice-passage-transcript"
        transcriptView.heightAnchor.constraint(
            greaterThanOrEqualToConstant: 112
        ).isActive = true
        detailStack.addArrangedSubview(
            card(
                title: "Transcript",
                detail: "Saved and editable",
                content: transcriptView,
                identifier: "voice-passage-transcript-card"
            )
        )

        configurePhoneLabel(observedPhonesLabel)
        observedPhonesLabel.accessibilityIdentifier =
            "voice-passage-observed-phones"
        detailStack.addArrangedSubview(
            card(
                title: "Phonemes heard",
                detail: "Transcript-aligned",
                content: observedPhonesLabel,
                identifier: "voice-passage-observed-card"
            )
        )

        configurePhoneLabel(referencePhonesLabel)
        referencePhonesLabel.accessibilityIdentifier =
            "voice-passage-reference-phones"
        referenceDetailLabel.font = .preferredFont(
            forTextStyle: .caption1
        )
        referenceDetailLabel.adjustsFontForContentSizeCategory = true
        referenceDetailLabel.textColor = .systemOrange
        referenceDetailLabel.numberOfLines = 0
        referenceDetailLabel.isHidden = true
        let referenceContent = UIStackView(
            arrangedSubviews: [
                referencePhonesLabel,
                referenceDetailLabel
            ]
        )
        referenceContent.axis = .vertical
        referenceContent.spacing = 8
        detailStack.addArrangedSubview(
            card(
                title: "Reference phonemes",
                detail: "CMUdict by word",
                content: referenceContent,
                identifier: "voice-passage-reference-card"
            )
        )
    }

    private func loadLibrary() {
        do {
            _ = try recordingStore.seedBundledSample(
                bundle: resourceBundle
            )
            refreshRecordings()
        } catch {
            libraryStatusLabel.text =
                "Saved recordings could not be loaded: "
                    + error.localizedDescription
        }
    }

    private func refreshRecordings() {
        do {
            recordings = try recordingStore.recordings()
            rebuildLibrary()
            if selectedRecordingID != nil {
                renderSelectedRecording()
            }
        } catch {
            recordings = []
            rebuildLibrary()
            libraryStatusLabel.text =
                "Saved recordings could not be read: "
                    + error.localizedDescription
        }
    }

    private func rebuildLibrary() {
        clearArrangedSubviews(samplesStack)
        clearArrangedSubviews(recordingsStack)

        let samples = recordings.filter {
            $0.source == .bundledSample
        }
        let saved = recordings.filter { $0.source == .microphone }

        if samples.isEmpty {
            samplesStack.addArrangedSubview(
                detailLabel("No bundled samples are available.")
            )
        } else {
            for recording in samples {
                samplesStack.addArrangedSubview(
                    recordingRow(recording)
                )
            }
        }

        if saved.isEmpty {
            recordingsStack.addArrangedSubview(
                detailLabel("No saved recordings yet.")
            )
        } else {
            for recording in saved {
                recordingsStack.addArrangedSubview(
                    recordingRow(recording)
                )
            }
        }
    }

    private func recordingRow(
        _ recording: VoicePassageRecording
    ) -> UIView {
        let container = UIStackView()
        container.axis = .vertical
        container.spacing = 8
        container.isLayoutMarginsRelativeArrangement = true
        container.layoutMargins = UIEdgeInsets(
            top: 12,
            left: 14,
            bottom: 12,
            right: 14
        )
        container.layer.cornerRadius = 12
        container.backgroundColor = .secondarySystemBackground
        container.accessibilityIdentifier =
            "voice-passage-recording-\(recording.id.uuidString)"

        let title = UILabel()
        title.font = .preferredFont(forTextStyle: .headline)
        title.adjustsFontForContentSizeCategory = true
        title.numberOfLines = 0
        title.text = recording.title
        container.addArrangedSubview(title)

        let summary = detailLabel(
            recording.source == .bundledSample
                ? String(
                    format: "Bundled sample • %.1f sec",
                    recording.durationSeconds
                )
                : String(
                    format: "%@ • %.1f sec",
                    Self.dateFormatter.string(
                        from: recording.createdAt
                    ),
                    recording.durationSeconds
                )
        )
        summary.numberOfLines = 0
        container.addArrangedSubview(summary)

        let open = UIButton(type: .system)
        var configuration = UIButton.Configuration.tinted()
        configuration.title = recording.source == .bundledSample
            ? "Open sample"
            : "Open recording"
        configuration.image = UIImage(
            systemName: "chevron.forward.circle.fill"
        )
        configuration.imagePadding = 8
        open.configuration = configuration
        open.contentHorizontalAlignment = .leading
        if recording.source == .bundledSample {
            open.accessibilityIdentifier =
                "voice-passage-open-sample"
        }
        open.addAction(UIAction { [weak self] _ in
            self?.showRecording(id: recording.id)
        }, for: .touchUpInside)
        container.addArrangedSubview(open)
        return container
    }

    func showRecording(id: UUID) {
        selectedRecordingID = id
        libraryStack.isHidden = true
        detailStack.isHidden = false
        renderSelectedRecording()
        if let recording = recordings.first(
            where: { $0.id == id }
        ), recording.wordPhoneGroups == nil
        {
            scheduleReferenceUpdate(
                transcript: recording.transcript,
                recordingID: id,
                delay: .zero,
                markTranscriptEdited: false
            )
        }
    }

    @objc private func showLibrary() {
        endEditing(true)
        stopPlayback()
        selectedRecordingID = nil
        detailStack.isHidden = true
        libraryStack.isHidden = false
        refreshRecordings()
    }

    private func renderSelectedRecording() {
        guard let selectedRecordingID,
              let recording = recordings.first(
                  where: { $0.id == selectedRecordingID }
              )
        else {
            return
        }
        detailTitleLabel.text = recording.title
        detailMetadataLabel.text = recording.source == .bundledSample
            ? String(
                format: "Bundled sample • %.1f sec • %@",
                recording.durationSeconds,
                recording.localeIdentifier
            )
            : String(
                format: "%@ • %.1f sec • %@",
                Self.dateFormatter.string(
                    from: recording.createdAt
                ),
                recording.durationSeconds,
                recording.localeIdentifier
            )
        transcriptView.text = recording.transcript
        transcriptView.isEditable = analysisTask == nil
        phoneModelControl.selectedSegmentIndex =
            VoicePassagePhoneModel.allCases.firstIndex(
                of: selectedPhoneModel
            ) ?? 0
        if let groups = recording.wordPhoneGroups,
           !groups.isEmpty
        {
            observedPhonesLabel.attributedText =
                Self.groupedPhoneText(
                    groups,
                    column: .heard
                )
            referencePhonesLabel.attributedText =
                Self.groupedPhoneText(
                    groups,
                    column: .reference
                )
        } else {
            observedPhonesLabel.attributedText = nil
            observedPhonesLabel.text =
                recording.observedPhones.isEmpty
                ? recording.phoneAnalysisFailure.map {
                "Raw-audio phoneme decoding failed: \($0)"
                } ?? (
                    recording.wordPhoneGroups == nil
                        ? "Grouping phonemes by transcript…"
                        : "Tap Reanalyze to decode the saved audio."
                )
                : "Grouping decoded phonemes by transcript…"
            referencePhonesLabel.attributedText = nil
            referencePhonesLabel.text =
                recording.wordPhoneGroups == nil
                ? "Grouping reference phonemes by word…"
                : "Edit the transcript to generate reference phonemes."
        }
        referenceDetailLabel.isHidden =
            recording.unknownReferenceWords.isEmpty
        referenceDetailLabel.text =
            recording.unknownReferenceWords.isEmpty
                ? nil
                : "No dictionary entry: "
                    + recording.unknownReferenceWords.joined(
                        separator: ", "
                    )
        reanalyzeButton.isEnabled = analysisTask == nil
        playButton.isEnabled = analysisTask == nil
        deleteButton.isEnabled = analysisTask == nil
        phoneModelControl.isEnabled = analysisTask == nil
        deleteButton.isHidden =
            recording.source == .bundledSample
        if analysisTask == nil {
            if let failure = recording.phoneAnalysisFailure {
                let attemptedModel =
                    VoicePassagePhoneModel.displayName(
                        forModelIdentifier:
                            recording.lastAttemptedPhoneModelIdentifier
                    ) ?? "Phone model"
                let retainedModel = VoicePassagePhoneModel.displayName(
                    forModelIdentifier: recording.phoneModelIdentifier
                ).map {
                    " The visible phonemes remain from the last successful \($0) analysis."
                } ?? ""
                detailStatusLabel.text =
                    "\(attemptedModel) analysis failed: \(failure)."
                    + retainedModel
            } else if let lastAnalyzedAt = recording.lastAnalyzedAt {
                let modelName = VoicePassagePhoneModel.displayName(
                    forModelIdentifier: recording.phoneModelIdentifier
                ).map { " using \($0)" } ?? ""
                detailStatusLabel.text =
                    "Saved analysis from "
                    + Self.dateFormatter.string(
                        from: lastAnalyzedAt
                    )
                    + modelName
                    + ". Reanalyze uses this same audio with the selected model."
            } else if recording.source == .bundledSample {
                detailStatusLabel.text =
                    "Sample ready. Tap Reanalyze to run the raw-audio "
                    + "model in the simulator or on device."
            } else {
                detailStatusLabel.text =
                    "Recording saved. Tap Reanalyze at any time."
            }
        }
    }

    @objc private func toggleRecording() {
        endEditing(true)
        if probe.isRecording {
            finishRecording(interruptionMessage: nil)
            return
        }
        recordingTask?.cancel()
        recordingTask = Task { [weak self] in
            await self?.beginRecording()
        }
    }

    private func beginRecording() async {
        guard isPrepared else {
            libraryStatusLabel.text =
                "Still preparing audio capture."
            return
        }
        do {
            try await probe.startRecording()
            guard !Task.isCancelled else {
                probe.stopRecording()
                return
            }
            recordButton.configuration?.title = "Stop"
            recordButton.configuration?.image = UIImage(
                systemName: "stop.fill"
            )
            libraryStatusLabel.text =
                "Recording. Tap Stop when finished."
            startRecordingWaveform()
            startRecordingLimit()
        } catch {
            guard !Task.isCancelled else { return }
            libraryStatusLabel.text =
                "Record failed: \(error.localizedDescription)"
        }
        recordingTask = nil
    }

    private func finishRecording(
        interruptionMessage: String?
    ) {
        guard probe.isRecording || interruptionMessage != nil else {
            return
        }
        recordingTask?.cancel()
        recordingTask = nil
        recordingLimitTask?.cancel()
        recordingLimitTask = nil
        probe.stopRecording()
        stopWaveform()
        recordButton.configuration?.title = "Record"
        recordButton.configuration?.image = UIImage(
            systemName: "mic.fill"
        )

        do {
            let recording = try recordingStore.save(
                capture: probe.capturedTake(),
                locale: probe.analysisLocale
            )
            refreshRecordings()
            showRecording(id: recording.id)
            detailStatusLabel.text = interruptionMessage
                ?? "Recording saved. Analyzing the retained audio…"
            analyze(recordingID: recording.id)
        } catch {
            libraryStatusLabel.text =
                "Recording could not be saved: "
                    + error.localizedDescription
        }
    }

    @objc private func reanalyzeSelectedRecording() {
        guard let selectedRecordingID else { return }
        analyze(recordingID: selectedRecordingID)
    }

    @objc private func phoneModelChanged() {
        let models = VoicePassagePhoneModel.allCases
        guard models.indices.contains(
            phoneModelControl.selectedSegmentIndex
        ) else {
            return
        }
        selectPhoneModel(models[phoneModelControl.selectedSegmentIndex])
    }

    func selectPhoneModel(_ model: VoicePassagePhoneModel) {
        phoneModelControl.selectedSegmentIndex =
            VoicePassagePhoneModel.allCases.firstIndex(of: model) ?? 0
        model.select(in: userDefaults)
        detailStatusLabel.text =
            "\(model.displayName) selected. Tap Reanalyze to run it on the saved audio."
    }

    private func analyze(recordingID: UUID) {
        guard analysisTask == nil else {
            detailStatusLabel.text =
                "Wait for the current analysis to finish."
            return
        }
        stopPlayback()
        transcriptView.isEditable = false
        reanalyzeButton.isEnabled = false
        playButton.isEnabled = false
        deleteButton.isEnabled = false
        phoneModelControl.isEnabled = false
        let model = selectedPhoneModel
        detailStatusLabel.text =
            "Reanalyzing the saved audio with \(model.displayName)…"
        analysisTask = Task { [weak self] in
            await self?.runAnalysis(
                recordingID: recordingID,
                model: model
            )
        }
    }

    private func runAnalysis(
        recordingID: UUID,
        model: VoicePassagePhoneModel
    ) async {
        defer {
            analysisTask = nil
            refreshRecordings()
        }
        do {
            var recording = try recordingStore.recording(
                id: recordingID
            )
            if probe.transcriptionAvailable {
                do {
                    let reading = try await probe.unaidedReading(
                        audioURL: recordingStore.audioURL(
                            for: recording
                        ),
                        localeIdentifier:
                            recording.localeIdentifier
                    )
                    guard !Task.isCancelled else { return }
                    if !reading.top.text.isEmpty {
                        recording.applyRecognizedTranscript(
                            reading.top.text
                        )
                    }
                    recording.transcriptionFailure = nil
                } catch {
                    guard !Task.isCancelled else { return }
                    recording.transcriptionFailure =
                        error.localizedDescription
                }
            } else {
                recording.transcriptionFailure =
                    "Speech transcription is unavailable on this device."
            }
            try recordingStore.save(recording)
            refreshRecordings()
            await updateReference(
                transcript: recording.transcript,
                recordingID: recordingID,
                markTranscriptEdited: false
            )
            guard !Task.isCancelled else { return }

            recording = try recordingStore.recording(
                id: recordingID
            )
            let observation = try await phoneAnalyzer.analyze(
                model: model,
                analysisID: recording.id,
                audioURL: recordingStore.audioURL(
                    for: recording
                ),
                localeIdentifier: recording.localeIdentifier
            )
            guard !Task.isCancelled else { return }
            recording = try recordingStore.recording(
                id: recordingID
            )
            recording.observedPhones = observation.phones
            let words = Self.wordPronunciations(
                from: recording.wordPhoneGroups ?? []
            )
            recording.wordPhoneGroups =
                VoicePassagePhoneGrouper.group(
                    observedPhones: observation.phones,
                    words: words
                )
            recording.modelWeightSHA256 =
                observation.modelWeightSHA256
            recording.phoneModelIdentifier =
                model.modelIdentifier
            recording.lastAttemptedPhoneModelIdentifier =
                model.modelIdentifier
            recording.phoneAnalysisFailure = nil
            recording.lastAnalyzedAt = Date()
            try recordingStore.save(recording)
            detailStatusLabel.text = recording.transcriptionFailure
                == nil
                ? "\(model.displayName) analysis complete and saved."
                : """
                \(model.displayName) raw-audio analysis complete and saved. Transcription \
                was unavailable; the saved editable transcript was kept.
                """
        } catch let analysisError {
            guard !Task.isCancelled else { return }
            do {
                var recording = try recordingStore.recording(
                    id: recordingID
                )
                recording.lastAttemptedPhoneModelIdentifier =
                    model.modelIdentifier
                recording.phoneAnalysisFailure =
                    analysisError.localizedDescription
                try recordingStore.save(recording)
            } catch let persistenceError {
                detailStatusLabel.text =
                    "Analysis and failure persistence both failed: "
                        + persistenceError.localizedDescription
                return
            }
            detailStatusLabel.text =
                "Raw-audio analysis failed: "
                    + analysisError.localizedDescription
        }
    }

    private var selectedPhoneModel: VoicePassagePhoneModel {
        VoicePassagePhoneModel.selected(in: userDefaults)
    }

    private func scheduleReferenceUpdate(
        transcript: String,
        recordingID: UUID,
        delay: Duration = .milliseconds(250),
        markTranscriptEdited: Bool = true
    ) {
        referenceUpdateTask?.cancel()
        referencePhonesLabel.text =
            "Updating reference phonemes…"
        referenceUpdateTask = Task { [weak self] in
            if delay != .zero {
                do {
                    try await Task.sleep(for: delay)
                } catch {
                    return
                }
            }
            await self?.updateReference(
                transcript: transcript,
                recordingID: recordingID,
                markTranscriptEdited: markTranscriptEdited
            )
        }
    }

    private func updateReference(
        transcript: String,
        recordingID: UUID,
        markTranscriptEdited: Bool
    ) async {
        do {
            var recording = try recordingStore.recording(
                id: recordingID
            )
            if markTranscriptEdited {
                recording.applyTranscriptEdit(transcript)
            } else {
                recording.transcript = transcript
            }
            try recordingStore.save(recording)

            let result = try await pronouncer.pronunciation(
                for: transcript
            )
            guard !Task.isCancelled else { return }
            recording = try recordingStore.recording(
                id: recordingID
            )
            recording.transcript = transcript
            recording.referencePhones = result.phones
            recording.wordPhoneGroups =
                VoicePassagePhoneGrouper.group(
                    observedPhones: recording.observedPhones,
                    words: result.wordPronunciations
                )
            recording.unknownReferenceWords = result.unknownWords
            try recordingStore.save(recording)
            refreshRecordings()
        } catch {
            guard !Task.isCancelled else { return }
            detailStatusLabel.text =
                "Reference update failed: "
                    + error.localizedDescription
        }
    }

    @objc private func togglePlayback() {
        if audioPlayer != nil {
            stopPlayback()
            detailStatusLabel.text = "Playback stopped."
            return
        }
        guard let selectedRecordingID else { return }
        do {
            let recording = try recordingStore.recording(
                id: selectedRecordingID
            )
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(
                .playback,
                mode: .spokenAudio
            )
            try session.setActive(true)
            let player = try AVAudioPlayer(
                contentsOf: recordingStore.audioURL(
                    for: recording
                )
            )
            player.delegate = self
            player.isMeteringEnabled = true
            guard player.prepareToPlay(), player.play() else {
                throw VoicePassageRecordingStore.StoreError
                    .invalidRecording(recording.id)
            }
            audioPlayer = player
            playButton.setTitle("Stop", for: .normal)
            playButton.setImage(
                UIImage(systemName: "stop.fill"),
                for: .normal
            )
            detailStatusLabel.text =
                "Playing the saved recording."
            startPlaybackWaveform()
        } catch {
            stopPlayback()
            detailStatusLabel.text =
                "Playback failed: \(error.localizedDescription)"
        }
    }

    @objc private func deleteSelectedRecording() {
        guard let selectedRecordingID else { return }
        do {
            try recordingStore.delete(
                recordingID: selectedRecordingID
            )
            showLibrary()
            libraryStatusLabel.text =
                "Saved recording deleted."
        } catch {
            detailStatusLabel.text =
                "Delete failed: \(error.localizedDescription)"
        }
    }

    private func startRecordingWaveform() {
        stopWaveform()
        recordingWaveformContainer.isHidden = false
        recordingWaveformView.reset()
        displayedLevel = 0
        waveformTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .milliseconds(50))
                } catch {
                    return
                }
                guard let self, !Task.isCancelled else { return }
                appendSmoothedLevel(
                    probe.currentAudioLevel,
                    to: recordingWaveformView
                )
            }
        }
    }

    private func startPlaybackWaveform() {
        stopWaveform()
        playbackWaveformContainer.isHidden = false
        playbackWaveformView.reset()
        displayedLevel = 0
        waveformTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .milliseconds(50))
                } catch {
                    return
                }
                guard let self, let audioPlayer,
                      !Task.isCancelled
                else {
                    return
                }
                audioPlayer.updateMeters()
                appendSmoothedLevel(
                    VoiceAudioLevel.normalized(
                        decibels: audioPlayer.averagePower(
                            forChannel: 0
                        )
                    ),
                    to: playbackWaveformView
                )
            }
        }
    }

    private func appendSmoothedLevel(
        _ measured: Float,
        to waveform: VoiceWaveformView
    ) {
        let response: Float =
            measured >= displayedLevel ? 0.85 : 0.12
        displayedLevel +=
            (measured - displayedLevel) * response
        waveform.append(level: displayedLevel)
    }

    private func stopWaveform() {
        waveformTask?.cancel()
        waveformTask = nil
        displayedLevel = 0
        recordingWaveformView.reset()
        playbackWaveformView.reset()
        recordingWaveformContainer.isHidden = true
        playbackWaveformContainer.isHidden = true
    }

    private func stopPlayback() {
        audioPlayer?.stop()
        audioPlayer = nil
        playButton.setTitle("Play", for: .normal)
        playButton.setImage(
            UIImage(systemName: "play.fill"),
            for: .normal
        )
        stopWaveform()
        try? AVAudioSession.sharedInstance().setActive(
            false,
            options: [.notifyOthersOnDeactivation]
        )
    }

    private func startRecordingLimit() {
        recordingLimitTask?.cancel()
        recordingLimitTask = Task { @MainActor [weak self] in
            do {
                try await Task.sleep(
                    for: .seconds(
                        VoicePassagePhoneObservation
                            .maximumDurationSeconds - 1
                    )
                )
            } catch {
                return
            }
            guard let self, probe.isRecording else { return }
            finishRecording(
                interruptionMessage:
                    "Two-minute limit reached. Recording saved."
            )
        }
    }

    private func card(
        title: String,
        detail: String,
        content: UIView,
        identifier: String
    ) -> UIView {
        let container = UIStackView()
        container.axis = .vertical
        container.spacing = 12
        container.isLayoutMarginsRelativeArrangement = true
        container.layoutMargins = UIEdgeInsets(
            top: 16,
            left: 16,
            bottom: 16,
            right: 16
        )
        container.backgroundColor = .secondarySystemBackground
        container.layer.cornerRadius = 14
        container.accessibilityIdentifier = identifier

        let header = UIStackView()
        header.axis = .horizontal
        header.alignment = .firstBaseline
        header.spacing = 8
        let titleLabel = UILabel()
        titleLabel.text = title
        titleLabel.font = .preferredFont(forTextStyle: .headline)
        titleLabel.adjustsFontForContentSizeCategory = true
        header.addArrangedSubview(titleLabel)
        let detailLabel = detailLabel(detail)
        detailLabel.textAlignment = .right
        detailLabel.setContentHuggingPriority(
            .required,
            for: .horizontal
        )
        header.addArrangedSubview(detailLabel)
        container.addArrangedSubview(header)
        container.addArrangedSubview(content)
        return container
    }

    private func configurePhoneLabel(_ label: UILabel) {
        label.font = .monospacedSystemFont(
            ofSize: 17,
            weight: .regular
        )
        label.adjustsFontForContentSizeCategory = true
        label.numberOfLines = 0
        label.lineBreakMode = .byWordWrapping
    }

    private enum PhoneGroupColumn {
        case heard
        case reference
    }

    private static func groupedPhoneText(
        _ groups: [VoicePassageWordPhoneGroup],
        column: PhoneGroupColumn
    ) -> NSAttributedString {
        let result = NSMutableAttributedString(string: "")
        let wordFont = UIFontMetrics(
            forTextStyle: .subheadline
        ).scaledFont(
            for: .systemFont(
                ofSize: 15,
                weight: .semibold
            )
        )
        let phoneFont = UIFontMetrics(
            forTextStyle: .body
        ).scaledFont(
            for: .monospacedSystemFont(
                ofSize: 17,
                weight: .regular
            )
        )

        for (index, group) in groups.enumerated() {
            if index > 0 {
                result.append(
                    NSAttributedString(string: "      ")
                )
            }
            let wordLabel = group.word ?? "No word anchor"
            result.append(
                NSAttributedString(
                    string: wordLabel,
                    attributes: [
                        .font: wordFont,
                        .foregroundColor:
                            UIColor.secondaryLabel
                    ]
                )
            )
            result.append(
                NSAttributedString(
                    string: "\u{00A0}\u{00A0}",
                    attributes: [
                        .font: wordFont,
                        .foregroundColor:
                            UIColor.tertiaryLabel
                    ]
                )
            )

            let phones: [String]
            let emptyText: String
            let color: UIColor
            switch column {
            case .heard:
                phones = group.heardPhones
                emptyText = "No raw phones aligned"
                color = phones.isEmpty
                    ? .tertiaryLabel
                    : .label
            case .reference:
                phones = group.referencePhones
                if group.word == nil {
                    emptyText = "Raw phones only"
                    color = .tertiaryLabel
                } else {
                    emptyText =
                        group.hasReferencePronunciation
                        ? "No reference phones"
                        : "No dictionary entry"
                    color =
                        group.hasReferencePronunciation
                        ? (
                            phones.isEmpty
                                ? .tertiaryLabel
                                : .label
                        )
                        : .systemOrange
                }
            }
            result.append(
                NSAttributedString(
                    string: phones.isEmpty
                        ? emptyText
                        : phones.joined(
                            separator: "\u{00A0}\u{00A0}"
                        ),
                    attributes: [
                        .font: phoneFont,
                        .foregroundColor: color
                    ]
                )
            )
        }
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = 7
        result.addAttribute(
            .paragraphStyle,
            value: paragraph,
            range: NSRange(
                location: 0,
                length: result.length
            )
        )
        return result
    }

    private static func wordPronunciations(
        from groups: [VoicePassageWordPhoneGroup]
    ) -> [VoicePassageWordPronunciation] {
        groups.compactMap { group in
            guard let word = group.word else { return nil }
            return VoicePassageWordPronunciation(
                word: word,
                phones: group.referencePhones,
                isKnown: group.hasReferencePronunciation
            )
        }
    }

    private func heading(_ text: String) -> UILabel {
        let label = UILabel()
        label.text = text
        label.font = .preferredFont(forTextStyle: .title2)
        label.adjustsFontForContentSizeCategory = true
        label.numberOfLines = 0
        return label
    }

    private func sectionLabel(_ text: String) -> UILabel {
        let label = UILabel()
        label.text = text
        label.font = .preferredFont(forTextStyle: .headline)
        label.adjustsFontForContentSizeCategory = true
        return label
    }

    private func detailLabel(_ text: String) -> UILabel {
        let label = UILabel()
        label.text = text
        label.font = .preferredFont(forTextStyle: .caption1)
        label.adjustsFontForContentSizeCategory = true
        label.textColor = .secondaryLabel
        label.numberOfLines = 0
        return label
    }

    private func clearArrangedSubviews(_ stack: UIStackView) {
        for view in stack.arrangedSubviews {
            stack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
    }

    private static let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter
    }()
}

@available(iOS 26.0, *)
extension VoicePassageSurface: UITextViewDelegate {
    func textViewDidChange(_ textView: UITextView) {
        guard let selectedRecordingID else { return }
        scheduleReferenceUpdate(
            transcript: textView.text ?? "",
            recordingID: selectedRecordingID
        )
    }
}

@available(iOS 26.0, *)
extension VoicePassageSurface: AVAudioPlayerDelegate {
    nonisolated func audioPlayerDidFinishPlaying(
        _ player: AVAudioPlayer,
        successfully flag: Bool
    ) {
        Task { @MainActor [weak self] in
            self?.stopPlayback()
            self?.detailStatusLabel.text = flag
                ? "Saved recording playback finished."
                : "Saved recording playback stopped early."
        }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(
        _ player: AVAudioPlayer,
        error: (any Error)?
    ) {
        Task { @MainActor [weak self] in
            self?.stopPlayback()
            self?.detailStatusLabel.text =
                "Playback failed: "
                + (
                    error?.localizedDescription
                        ?? "audio decode error"
                )
        }
    }
}
