import AVFoundation
import UIKit

@available(iOS 26.0, *)
final class VoicePassageSurface: UIView {
    private let stack = UIStackView()
    private let recordButton = UIButton(type: .system)
    private let statusLabel = UILabel()
    private let waveformContainer = UIStackView()
    private let waveformView = VoiceWaveformView()
    private let transcriptView = UITextView()
    private let observedPhonesLabel = UILabel()
    private let referencePhonesLabel = UILabel()
    private let referenceDetailLabel = UILabel()

    private let probe = VoiceContextProbe()
    private let phoneAnalyzer = VoicePhoneAnalyzer()
    private let pronouncer = VoicePassagePronouncer()
    private let sessionStore = VoicePassageSessionStore()
    private var currentSession: VoicePassageSession?
    private var isPrepared = false
    private var preparationTask: Task<Void, Never>?
    private var recordingTask: Task<Void, Never>?
    private var analysisTask: Task<Void, Never>?
    private var referenceUpdateTask: Task<Void, Never>?
    private var waveformTask: Task<Void, Never>?
    private var recordingLimitTask: Task<Void, Never>?
    private var displayedLevel: Float = 0

    override init(frame: CGRect) {
        super.init(frame: frame)
        configure()
        restoreCurrentSession()
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
                try await probe.prepare { [weak self] message in
                    self?.statusLabel.text = message
                }
                guard !Task.isCancelled else { return }
                isPrepared = true
                recordButton.isEnabled = true
                statusLabel.text = currentSession == nil
                    ? "Ready. Record a passage of up to two minutes."
                    : "Ready. Record again or edit the transcript."
            } catch {
                guard !Task.isCancelled else { return }
                statusLabel.text =
                    "Speech setup failed: \(error.localizedDescription)"
            }
            preparationTask = nil
        }
    }

    func suspend() {
        recordingTask?.cancel()
        recordingTask = nil
        recordingLimitTask?.cancel()
        recordingLimitTask = nil
        if probe.isRecording {
            probe.stopRecording()
            stopWaveform()
            recordButton.configuration?.title = "Record"
            recordButton.configuration?.image = UIImage(
                systemName: "mic.fill"
            )
            do {
                let capture = try probe.capturedTake()
                let session = try sessionStore.save(
                    capture: capture,
                    locale: probe.analysisLocale
                )
                currentSession = session
                transcriptView.text =
                    "The recording was saved before transcription completed."
                transcriptView.isEditable = false
                observedPhonesLabel.text =
                    "The saved recording has not been decoded."
                referencePhonesLabel.text =
                    "Record again to create a transcript and reference sequence."
                referenceDetailLabel.isHidden = true
                statusLabel.text =
                    "Recording saved when you left Passage. Record again to analyze."
            } catch {
                statusLabel.text =
                    "Interrupted recording could not be saved: \(error.localizedDescription)"
            }
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

        let title = UILabel()
        title.text = "Passage comparison"
        title.font = .preferredFont(forTextStyle: .title2)
        title.adjustsFontForContentSizeCategory = true
        stack.addArrangedSubview(title)

        let controls = UIStackView()
        controls.axis = .horizontal
        controls.spacing = 10
        controls.alignment = .center

        var recordConfiguration = UIButton.Configuration.filled()
        recordConfiguration.title = "Record"
        recordConfiguration.image = UIImage(systemName: "mic.fill")
        recordConfiguration.imagePadding = 8
        recordConfiguration.cornerStyle = .capsule
        recordButton.configuration = recordConfiguration
        recordButton.isEnabled = false
        recordButton.accessibilityIdentifier = "voice-passage-record"
        recordButton.addTarget(
            self,
            action: #selector(toggleRecording),
            for: .touchUpInside
        )
        controls.addArrangedSubview(recordButton)

        statusLabel.font = .preferredFont(forTextStyle: .footnote)
        statusLabel.adjustsFontForContentSizeCategory = true
        statusLabel.textColor = .secondaryLabel
        statusLabel.numberOfLines = 0
        statusLabel.text = "Preparing speech recognition…"
        statusLabel.accessibilityIdentifier = "voice-passage-status"
        controls.addArrangedSubview(statusLabel)
        stack.addArrangedSubview(controls)

        waveformContainer.axis = .vertical
        waveformContainer.spacing = 6
        waveformContainer.isHidden = true
        let waveformCaption = detailLabel("Live microphone")
        waveformContainer.addArrangedSubview(waveformCaption)
        waveformView.tintColor = .systemRed
        waveformView.accessibilityIdentifier = "voice-passage-waveform"
        waveformContainer.addArrangedSubview(waveformView)
        stack.addArrangedSubview(waveformContainer)

        transcriptView.font = .preferredFont(forTextStyle: .body)
        transcriptView.adjustsFontForContentSizeCategory = true
        transcriptView.backgroundColor = .clear
        transcriptView.textContainerInset = .zero
        transcriptView.textContainer.lineFragmentPadding = 0
        transcriptView.isScrollEnabled = false
        transcriptView.isEditable = false
        transcriptView.delegate = self
        transcriptView.text =
            "Record a passage. The transcript will appear here and remain editable."
        transcriptView.accessibilityIdentifier = "voice-passage-transcript"
        transcriptView.heightAnchor.constraint(
            greaterThanOrEqualToConstant: 112
        ).isActive = true
        stack.addArrangedSubview(
            card(
                title: "Transcript",
                detail: "Editable after transcription",
                content: transcriptView,
                identifier: "voice-passage-transcript-card"
            )
        )

        configurePhoneLabel(observedPhonesLabel)
        observedPhonesLabel.text =
            "Record a passage to decode phonemes from the raw audio."
        observedPhonesLabel.accessibilityIdentifier =
            "voice-passage-observed-phones"
        stack.addArrangedSubview(
            card(
                title: "Phonemes heard",
                detail: "Raw audio model",
                content: observedPhonesLabel,
                identifier: "voice-passage-observed-card"
            )
        )

        configurePhoneLabel(referencePhonesLabel)
        referencePhonesLabel.text =
            "The reference sequence will follow the editable transcript."
        referencePhonesLabel.accessibilityIdentifier =
            "voice-passage-reference-phones"
        referenceDetailLabel.font = .preferredFont(forTextStyle: .caption1)
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
        stack.addArrangedSubview(
            card(
                title: "Reference phonemes",
                detail: "CMUdict from transcript",
                content: referenceContent,
                identifier: "voice-passage-reference-card"
            )
        )
    }

    private func configurePhoneLabel(_ label: UILabel) {
        label.font = .monospacedSystemFont(ofSize: 17, weight: .regular)
        label.adjustsFontForContentSizeCategory = true
        label.numberOfLines = 0
        label.lineBreakMode = .byWordWrapping
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
        detailLabel.setContentHuggingPriority(.required, for: .horizontal)
        header.addArrangedSubview(detailLabel)
        container.addArrangedSubview(header)
        container.addArrangedSubview(content)
        return container
    }

    private func detailLabel(_ text: String) -> UILabel {
        let label = UILabel()
        label.text = text
        label.font = .preferredFont(forTextStyle: .caption1)
        label.adjustsFontForContentSizeCategory = true
        label.textColor = .secondaryLabel
        return label
    }

    @objc private func toggleRecording() {
        endEditing(true)
        if probe.isRecording {
            finishRecording(interruptionMessage: nil)
            return
        }
        analysisTask?.cancel()
        analysisTask = nil
        recordingTask?.cancel()
        recordingTask = Task { [weak self] in
            await self?.beginRecording()
        }
    }

    private func beginRecording() async {
        guard isPrepared else {
            statusLabel.text = "Still preparing speech recognition."
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
            transcriptView.isEditable = false
            statusLabel.text = "Recording. Tap Stop when finished."
            startWaveform()
            startRecordingLimit()
        } catch {
            guard !Task.isCancelled else { return }
            statusLabel.text = "Record failed: \(error.localizedDescription)"
        }
        recordingTask = nil
    }

    private func finishRecording(interruptionMessage: String?) {
        guard probe.isRecording || interruptionMessage != nil else { return }
        recordingTask?.cancel()
        recordingTask = nil
        recordingLimitTask?.cancel()
        recordingLimitTask = nil
        probe.stopRecording()
        stopWaveform()
        recordButton.configuration?.title = "Record"
        recordButton.configuration?.image = UIImage(systemName: "mic.fill")

        do {
            let capture = try probe.capturedTake()
            let session = try sessionStore.save(
                capture: capture,
                locale: probe.analysisLocale
            )
            currentSession = session
            transcriptView.isEditable = false
            transcriptView.text = "Transcribing…"
            observedPhonesLabel.text = "Decoding raw audio…"
            referencePhonesLabel.text = "Waiting for transcript…"
            referenceDetailLabel.isHidden = true
            statusLabel.text = interruptionMessage
                ?? "Recording saved. Transcribing and decoding phonemes…"
            analysisTask = Task { [weak self] in
                await self?.analyze(session: session)
            }
        } catch {
            statusLabel.text =
                "Recording could not be saved: \(error.localizedDescription)"
        }
    }

    private func analyze(session: VoicePassageSession) async {
        defer { analysisTask = nil }
        var updatedSession = session
        do {
            let reading = try await probe.unaidedReading()
            guard !Task.isCancelled, currentSession?.id == session.id else {
                return
            }
            updatedSession.transcript = reading.top.text
            currentSession = updatedSession
            transcriptView.text = reading.top.text
            transcriptView.isEditable = true
            try sessionStore.save(updatedSession)
        } catch {
            guard !Task.isCancelled else { return }
            transcriptView.text = ""
            transcriptView.isEditable = true
            statusLabel.text =
                "The recording was saved, but transcription failed: "
                    + error.localizedDescription
        }

        await updateReference(
            transcript: updatedSession.transcript,
            sessionID: session.id
        )
        guard !Task.isCancelled, currentSession?.id == session.id else {
            return
        }

        do {
            let manifest = try VoicePhoneModelAssets.loadManifest()
            let observation = try await phoneAnalyzer.analyzePassage(
                VoicePhoneAnalyzer.PassageRequest(
                    analysisID: session.id,
                    audioURL: sessionStore.audioURL(for: session),
                    localeIdentifier: session.localeIdentifier,
                    modelManifest: manifest
                )
            )
            guard !Task.isCancelled, currentSession?.id == session.id else {
                return
            }
            observedPhonesLabel.text = observation.displayText
            updatedSession = currentSession ?? updatedSession
            updatedSession.observedPhones = observation.phones
            updatedSession.modelWeightSHA256 =
                observation.modelWeightSHA256
            currentSession = updatedSession
            try sessionStore.save(updatedSession)
            statusLabel.text = """
            Done. The transcript is editable; changing it updates only the \
            reference phonemes.
            """
        } catch {
            guard !Task.isCancelled else { return }
            observedPhonesLabel.text =
                "Raw-audio phoneme decoding failed: \(error.localizedDescription)"
            statusLabel.text =
                "Transcript ready. Raw-audio phoneme decoding failed."
        }
    }

    private func updateReference(
        transcript: String,
        sessionID: UUID
    ) async {
        guard !Task.isCancelled,
              var transcriptSession = currentSession,
              transcriptSession.id == sessionID
        else {
            return
        }
        transcriptSession.transcript = transcript
        do {
            try sessionStore.save(transcriptSession)
            currentSession = transcriptSession
        } catch {
            statusLabel.text =
                "Transcript could not be saved: \(error.localizedDescription)"
            return
        }

        let result: VoicePassagePronunciationResult
        do {
            result = try await pronouncer.pronunciation(for: transcript)
        } catch {
            guard !Task.isCancelled, currentSession?.id == sessionID else {
                return
            }
            referencePhonesLabel.text =
                "Reference generation failed: \(error.localizedDescription)"
            referenceDetailLabel.isHidden = true
            return
        }
        guard !Task.isCancelled, currentSession?.id == sessionID else {
            return
        }
        referencePhonesLabel.text = result.displayText
        if result.unknownWords.isEmpty {
            referenceDetailLabel.isHidden = true
            referenceDetailLabel.text = nil
        } else {
            referenceDetailLabel.isHidden = false
            referenceDetailLabel.text =
                "No dictionary entry: "
                    + result.unknownWords.joined(separator: ", ")
        }
        if var session = currentSession {
            session.referencePhones = result.phones
            session.unknownReferenceWords = result.unknownWords
            currentSession = session
            do {
                try sessionStore.save(session)
            } catch {
                statusLabel.text =
                    "Reference shown, but metadata could not be saved: "
                        + error.localizedDescription
            }
        }
    }

    private func restoreCurrentSession() {
        do {
            guard let session = try sessionStore.load() else { return }
            currentSession = session
            transcriptView.text = session.transcript.isEmpty
                ? "The last recording ended before transcription completed."
                : session.transcript
            transcriptView.isEditable = !session.transcript.isEmpty
            observedPhonesLabel.text = session.observedPhones.isEmpty
                ? "The last recording has no decoded phonemes."
                : session.observedPhones.joined(separator: "  ")
            referencePhonesLabel.text = session.referencePhones.isEmpty
                ? "Edit the transcript to generate reference phonemes."
                : session.referencePhones.joined(separator: "  ")
            referenceDetailLabel.isHidden =
                session.unknownReferenceWords.isEmpty
            referenceDetailLabel.text = session.unknownReferenceWords.isEmpty
                ? nil
                : "No dictionary entry: "
                    + session.unknownReferenceWords.joined(separator: ", ")
        } catch {
            statusLabel.text =
                "Saved passage could not be read: \(error.localizedDescription)"
        }
    }

    private func startWaveform() {
        stopWaveform()
        waveformContainer.isHidden = false
        waveformView.reset()
        displayedLevel = 0
        waveformTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .milliseconds(50))
                } catch {
                    return
                }
                guard let self, !Task.isCancelled else { return }
                let measured = probe.currentAudioLevel
                let response: Float = measured >= displayedLevel ? 0.85 : 0.12
                displayedLevel += (measured - displayedLevel) * response
                waveformView.append(level: displayedLevel)
            }
        }
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
                    "Two-minute recording limit reached. Recording saved."
            )
        }
    }

    private func stopWaveform() {
        waveformTask?.cancel()
        waveformTask = nil
        displayedLevel = 0
        waveformView.reset()
        waveformContainer.isHidden = true
    }
}

@available(iOS 26.0, *)
extension VoicePassageSurface: UITextViewDelegate {
    func textViewDidChange(_ textView: UITextView) {
        guard let sessionID = currentSession?.id else { return }
        referenceUpdateTask?.cancel()
        referencePhonesLabel.text = "Updating reference phonemes…"
        let transcript = textView.text ?? ""
        referenceUpdateTask = Task { [weak self] in
            do {
                try await Task.sleep(for: .milliseconds(250))
            } catch {
                return
            }
            await self?.updateReference(
                transcript: transcript,
                sessionID: sessionID
            )
        }
    }
}
