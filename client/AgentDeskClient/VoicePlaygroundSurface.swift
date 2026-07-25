import AVFoundation
import UIKit

// Evidence-retaining surface for an experimental recognition-context comparison.
//
// One take of audio, two transcription passes, and the difference between them
// shown side by side. The exact analyzer-format audio and a versioned metadata
// record are retained together so later model work can replay the evidence
// instead of relying on a transient label or the user's recollection.
//
// It remains a recognition probe, not a pronunciation score or reference
// comparison.
@available(iOS 26.0, *)
final class VoicePlaygroundSurface: UIView {
    private static let retentionDefaultsKey = "VoiceProbeRetainsAttempts"

    private let scrollView = UIScrollView()
    private let stack = UIStackView()
    private let targetField = UITextField()
    private let statusLabel = UILabel()
    private let recordButton = UIButton(type: .system)
    private let speakButton = UIButton(type: .system)
    private let levelMeterStack = UIStackView()
    private let levelMeterLabel = UILabel()
    private let levelMeter = UIProgressView(progressViewStyle: .bar)
    private let verdictLabel = UILabel()
    private let unaidedLabel = UILabel()
    private let aidedLabel = UILabel()
    private let confusionsLabel = UILabel()
    private let retentionSwitch = UISwitch()
    private let deleteAllButton = UIButton(type: .system)
    private let matrixLabel = UILabel()
    private let savedAttemptsStack = UIStackView()

    private let probe = VoiceContextProbe()
    private let attemptStore = VoiceAttemptStore()
    private let synthesizer = AVSpeechSynthesizer()
    private var audioPlayer: AVAudioPlayer?
    private var replayingAttemptID: UUID?
    private var savedAttempts: [VoiceSavedAttempt] = []
    private var activeTarget: String?
    private var activeAttemptID: UUID?
    private var activeShouldRetain = true
    private var isPrepared = false
    private var preparationTask: Task<Void, Never>?
    private var recordingTask: Task<Void, Never>?
    private var readingsTask: Task<Void, Never>?
    private var referenceSessionActive = false
    private var levelMeterTask: Task<Void, Never>?
    private var levelMeterSource: LevelMeterSource?
    private var displayedLevel: Float = 0

    private enum LevelMeterSource {
        case recording
        case replay
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        configure()
        synthesizer.delegate = self
        probe.onCaptureInterrupted = { [weak self] message in
            self?.retainInterruptedCapture(message: message)
        }
        refreshSavedAttempts()
        preparationTask = Task { [weak self] in
            await self?.prepareModel()
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is unavailable")
    }

    // MARK: - Layout

    private func configure() {
        backgroundColor = .systemBackground
        layer.cornerRadius = 12
        clipsToBounds = true

        scrollView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(scrollView)

        stack.axis = .vertical
        stack.spacing = 12
        stack.alignment = .fill
        stack.translatesAutoresizingMaskIntoConstraints = false
        scrollView.addSubview(stack)

        NSLayoutConstraint.activate([
            scrollView.topAnchor.constraint(equalTo: topAnchor),
            scrollView.leadingAnchor.constraint(equalTo: leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: trailingAnchor),
            scrollView.bottomAnchor.constraint(equalTo: bottomAnchor),
            stack.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor, constant: 16),
            stack.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor, constant: -16),
            stack.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor, constant: -16),
            stack.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor, constant: -32)
        ])

        stack.addArrangedSubview(heading("Speech context probe"))

        targetField.text = "think"
        targetField.borderStyle = .roundedRect
        targetField.autocapitalizationType = .none
        targetField.autocorrectionType = .no
        targetField.returnKeyType = .done
        targetField.addTarget(self, action: #selector(dismissKeyboard), for: .editingDidEndOnExit)
        targetField.accessibilityLabel = "Target phrase"
        stack.addArrangedSubview(caption("Target phrase"))
        stack.addArrangedSubview(targetField)
        stack.addArrangedSubview(presetGrid())

        speakButton.setTitle("Hear reference", for: .normal)
        speakButton.addTarget(self, action: #selector(speakTarget), for: .touchUpInside)
        stack.addArrangedSubview(speakButton)

        recordButton.setTitle("Record", for: .normal)
        recordButton.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        recordButton.addTarget(self, action: #selector(toggleRecording), for: .touchUpInside)
        recordButton.accessibilityLabel = "Record"
        stack.addArrangedSubview(recordButton)

        levelMeterStack.axis = .vertical
        levelMeterStack.spacing = 6
        levelMeterStack.isHidden = true
        levelMeterLabel.font = .preferredFont(forTextStyle: .caption1)
        levelMeterLabel.textColor = .secondaryLabel
        levelMeterStack.addArrangedSubview(levelMeterLabel)
        levelMeter.progressTintColor = .systemBlue
        levelMeter.trackTintColor = .tertiarySystemFill
        levelMeter.layer.cornerRadius = 4
        levelMeter.clipsToBounds = true
        levelMeter.translatesAutoresizingMaskIntoConstraints = false
        levelMeter.heightAnchor.constraint(equalToConstant: 8).isActive = true
        levelMeter.accessibilityLabel = "Audio level"
        levelMeter.accessibilityIdentifier = "voice-live-level"
        levelMeterStack.addArrangedSubview(levelMeter)
        stack.addArrangedSubview(levelMeterStack)

        statusLabel.font = .preferredFont(forTextStyle: .footnote)
        statusLabel.textColor = .secondaryLabel
        statusLabel.numberOfLines = 0
        statusLabel.text = "Preparing…"
        statusLabel.accessibilityIdentifier = "voice-status"
        stack.addArrangedSubview(statusLabel)

        stack.addArrangedSubview(separator())

        verdictLabel.font = .preferredFont(forTextStyle: .title3)
        verdictLabel.numberOfLines = 0
        verdictLabel.accessibilityIdentifier = "voice-verdict"
        stack.addArrangedSubview(verdictLabel)

        for (caption, label) in [
            ("No context", unaidedLabel),
            ("With target as context", aidedLabel),
            ("Other recognition candidates", confusionsLabel)
        ] {
            label.font = .monospacedSystemFont(ofSize: 14, weight: .regular)
            label.numberOfLines = 0
            stack.addArrangedSubview(self.caption(caption))
            stack.addArrangedSubview(label)
        }

        stack.addArrangedSubview(separator())
        stack.addArrangedSubview(heading("Saved evidence"))

        let retentionRow = UIStackView()
        retentionRow.axis = .horizontal
        retentionRow.alignment = .center
        retentionRow.spacing = 12
        let retentionText = caption(
            "Keep new takes on this iPhone until you delete them"
        )
        retentionText.numberOfLines = 0
        retentionRow.addArrangedSubview(retentionText)
        retentionRow.addArrangedSubview(retentionSwitch)
        retentionSwitch.setContentHuggingPriority(.required, for: .horizontal)
        let defaults = UserDefaults.standard
        retentionSwitch.isOn = defaults.object(forKey: Self.retentionDefaultsKey) == nil
            ? true
            : defaults.bool(forKey: Self.retentionDefaultsKey)
        retentionSwitch.addTarget(
            self,
            action: #selector(retentionChanged),
            for: .valueChanged
        )
        retentionSwitch.accessibilityLabel = "Keep new voice recordings"
        stack.addArrangedSubview(retentionRow)

        deleteAllButton.setTitle("Delete all saved takes", for: .normal)
        deleteAllButton.setTitleColor(.systemRed, for: .normal)
        deleteAllButton.addTarget(
            self,
            action: #selector(confirmDeleteAll),
            for: .touchUpInside
        )
        stack.addArrangedSubview(deleteAllButton)

        matrixLabel.font = .preferredFont(forTextStyle: .footnote)
        matrixLabel.numberOfLines = 0
        matrixLabel.accessibilityIdentifier = "voice-context-matrix"
        stack.addArrangedSubview(caption("Saved minimal-pair matrix"))
        stack.addArrangedSubview(matrixLabel)

        savedAttemptsStack.axis = .vertical
        savedAttemptsStack.spacing = 10
        stack.addArrangedSubview(caption("Saved takes"))
        stack.addArrangedSubview(savedAttemptsStack)
    }

    private func heading(_ text: String) -> UILabel {
        let label = UILabel()
        label.text = text
        label.font = .preferredFont(forTextStyle: .title2)
        label.numberOfLines = 0
        return label
    }

    private func caption(_ text: String) -> UILabel {
        let label = UILabel()
        label.text = text
        label.font = .preferredFont(forTextStyle: .caption1)
        label.textColor = .secondaryLabel
        return label
    }

    private func separator() -> UIView {
        let view = UIView()
        view.backgroundColor = .separator
        view.heightAnchor.constraint(equalToConstant: 1).isActive = true
        return view
    }

    private func presetGrid() -> UIView {
        let grid = UIStackView()
        grid.axis = .vertical
        grid.spacing = 6
        for pair in VoiceContextMatrix.minimalPairs {
            let row = UIStackView()
            row.axis = .horizontal
            row.spacing = 8
            row.distribution = .fillEqually
            for word in pair.prompts {
                let button = UIButton(type: .system)
                button.setTitle(word, for: .normal)
                button.titleLabel?.font = .preferredFont(forTextStyle: .footnote)
                button.addTarget(
                    self,
                    action: #selector(presetTapped(_:)),
                    for: .touchUpInside
                )
                row.addArrangedSubview(button)
            }
            grid.addArrangedSubview(row)
        }
        return grid
    }

    // MARK: - Actions

    @objc private func dismissKeyboard() {
        targetField.resignFirstResponder()
    }

    @objc private func presetTapped(_ sender: UIButton) {
        targetField.text = sender.title(for: .normal)
    }

    @objc private func retentionChanged() {
        UserDefaults.standard.set(
            retentionSwitch.isOn,
            forKey: Self.retentionDefaultsKey
        )
        statusLabel.text = retentionSwitch.isOn
            ? "New takes will be saved until you delete them."
            : "New takes will be analyzed in memory and discarded."
    }

    @objc private func confirmDeleteAll() {
        guard !savedAttempts.isEmpty else { return }
        let alert = UIAlertController(
            title: "Delete all saved takes?",
            message: "This removes every retained recording and its recognition metadata.",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Delete all", style: .destructive) {
            [weak self] _ in
            self?.deleteAllSavedAttempts()
        })
        enclosingViewController?.present(alert, animated: true)
    }

    @objc private func speakTarget() {
        guard let target = targetField.text, !target.isEmpty else { return }
        // Playing the reference mid-take would put the synthesized voice into the
        // recording and fight the probe for the audio session category.
        guard !probe.isRecording else {
            statusLabel.text = "Stop recording before playing the reference."
            return
        }
        stopSavedTakePlayback()
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .spokenAudio)
            try session.setActive(true)
            referenceSessionActive = true
        } catch {
            statusLabel.text = "Reference playback failed: \(error.localizedDescription)"
            return
        }
        let utterance = AVSpeechUtterance(string: target)
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        synthesizer.speak(utterance)
    }

    @objc private func toggleRecording() {
        dismissKeyboard()
        if probe.isRecording {
            recordingTask?.cancel()
            recordingTask = nil
            stopLevelMeter(source: .recording)
            probe.stopRecording()
            recordButton.setTitle("Record", for: .normal)
            if activeShouldRetain {
                do {
                    let capture = try probe.capturedTake()
                    let saved = try attemptStore.save(
                        capture: capture,
                        targetPhrase: activeTarget ?? targetField.text ?? "",
                        locale: probe.analysisLocale
                    )
                    activeAttemptID = saved.id
                    statusLabel.text = "Recording saved. Transcribing both passes…"
                    refreshSavedAttempts()
                } catch {
                    activeAttemptID = nil
                    statusLabel.text = "Save failed; transcribing unsaved take: \(error.localizedDescription)"
                }
            } else {
                activeAttemptID = nil
                statusLabel.text = "Transcribing both passes without retaining this take…"
            }
            let target = activeTarget ?? targetField.text ?? ""
            let attemptID = activeAttemptID
            activeTarget = nil
            activeAttemptID = nil
            recordButton.isEnabled = false
            retentionSwitch.isEnabled = false
            readingsTask?.cancel()
            readingsTask = Task { [weak self] in
                await self?.runReadings(target: target, attemptID: attemptID)
            }
        } else {
            synthesizer.stopSpeaking(at: .immediate)
            deactivateReferenceAudioSession()
            stopSavedTakePlayback()
            recordingTask?.cancel()
            recordingTask = Task { [weak self] in
                await self?.beginRecording()
            }
        }
    }

    // MARK: - Probe driving

    private func prepareModel() async {
        do {
            try await probe.prepare { [weak self] message in
                self?.statusLabel.text = message
            }
            guard !Task.isCancelled else { return }
            isPrepared = true
            statusLabel.text = "Ready. Tap Record and say the target."
        } catch {
            guard !Task.isCancelled else { return }
            statusLabel.text = "Setup failed: \(error.localizedDescription)"
        }
    }

    private func beginRecording() async {
        guard isPrepared else {
            statusLabel.text = "Still preparing the speech model."
            return
        }
        let target = (targetField.text ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !target.isEmpty else {
            statusLabel.text = "Enter a target phrase before recording."
            return
        }
        do {
            try await probe.startRecording()
            guard !Task.isCancelled else {
                probe.stopRecording()
                return
            }
            activeTarget = target
            activeAttemptID = nil
            activeShouldRetain = retentionSwitch.isOn
            recordButton.setTitle("Stop", for: .normal)
            retentionSwitch.isEnabled = false
            statusLabel.text = "Recording. Tap Stop when finished."
            startLevelMeter(source: .recording)
        } catch {
            guard !Task.isCancelled else { return }
            activeTarget = nil
            activeAttemptID = nil
            retentionSwitch.isEnabled = true
            statusLabel.text = "Record failed: \(error.localizedDescription)"
        }
    }

    private func runReadings(target: String, attemptID: UUID?) async {
        defer {
            readingsTask = nil
            recordButton.isEnabled = true
            retentionSwitch.isEnabled = true
        }
        do {
            let (unaided, aided) = try await probe.readings(target: target)
            let verdict = VoiceContextComparison.verdict(
                target: target,
                withoutContext: unaided,
                withContext: aided
            )
            let confusions = VoiceContextComparison.confusions(target: target, reading: unaided)
            let unaidedMatch = VoiceContextComparison.matchLocation(
                in: unaided,
                target: target
            )
            let aidedMatch = VoiceContextComparison.matchLocation(
                in: aided,
                target: target
            )

            verdictLabel.text = Self.describe(
                verdict,
                withoutContextMatch: unaidedMatch,
                withContextMatch: aidedMatch
            )
            unaidedLabel.text = Self.describe(reading: unaided)
            aidedLabel.text = Self.describe(reading: aided)
            confusionsLabel.text = confusions.isEmpty ? "—" : confusions.joined(separator: ", ")
            if let attemptID {
                do {
                    _ = try attemptStore.finishAnalysis(
                        attemptID: attemptID,
                        withoutContext: unaided,
                        withContext: aided
                    )
                    statusLabel.text = "Done. Recording and recognition metadata saved."
                    refreshSavedAttempts()
                } catch {
                    statusLabel.text = "Analyzed, but metadata update failed: \(error.localizedDescription)"
                }
            } else {
                statusLabel.text = "Done. This take was not retained."
            }
        } catch {
            if Task.isCancelled {
                if let attemptID {
                    do {
                        _ = try attemptStore.recordAnalysisFailure(
                            attemptID: attemptID,
                            message: "Analysis stopped when the Voice surface closed."
                        )
                        refreshSavedAttempts()
                    } catch {
                        VoiceProbeTrace.emit(
                            "failed to record canceled analysis for \(attemptID): \(error)"
                        )
                    }
                }
                return
            }
            if let attemptID {
                do {
                    _ = try attemptStore.recordAnalysisFailure(
                        attemptID: attemptID,
                        message: error.localizedDescription
                    )
                    refreshSavedAttempts()
                } catch {
                    VoiceProbeTrace.emit(
                        "failed to record analysis error for \(attemptID): \(error)"
                    )
                }
            }
            statusLabel.text = "Transcribe failed: \(error.localizedDescription)"
        }
    }

    private static func describe(
        _ verdict: VoiceGapVerdict,
        withoutContextMatch: VoiceTargetMatch,
        withContextMatch: VoiceTargetMatch
    ) -> String {
        switch verdict {
        case .clear:
            if withoutContextMatch == .topResult {
                return "Unaided top-result match: context was not needed."
            }
            return "Unaided alternative-only match: the target was not the recognizer’s top result."
        case .contextRescued:
            if withContextMatch == .topResult {
                return "Context promoted the target from absent to the top result."
            }
            return "Context added the target only as an alternative candidate."
        case .missed:
            return "No match: the target did not appear in either transcription."
        case .inconsistent:
            return "Inconsistent: the target appeared only in the unaided transcription."
        }
    }

    private static func describe(reading: VoiceReading) -> String {
        var lines = [reading.top.text.isEmpty ? "(nothing)" : reading.top.text]
        if let confidence = reading.top.confidence {
            lines.append(String(format: "confidence %.3f", confidence))
        }
        if !reading.alternatives.isEmpty {
            lines.append(
                "alts: " + reading.alternatives.map { candidate in
                    guard let confidence = candidate.confidence else {
                        return candidate.text
                    }
                    return "\(candidate.text) (\(String(format: "%.3f", confidence)))"
                }
                .joined(separator: " | ")
            )
        }
        return lines.joined(separator: "\n")
    }

    // MARK: - Saved attempts

    private func refreshSavedAttempts() {
        do {
            savedAttempts = try attemptStore.attempts()
            rebuildSavedAttempts()
            updateMatrix()
            deleteAllButton.isEnabled = !savedAttempts.isEmpty
        } catch {
            savedAttempts = []
            rebuildSavedAttempts()
            matrixLabel.text = "Saved evidence could not be read: \(error.localizedDescription)"
            deleteAllButton.isEnabled = false
        }
    }

    private func rebuildSavedAttempts() {
        for view in savedAttemptsStack.arrangedSubviews {
            savedAttemptsStack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        guard !savedAttempts.isEmpty else {
            savedAttemptsStack.addArrangedSubview(caption("No saved takes yet."))
            return
        }

        for attempt in savedAttempts {
            let card = UIStackView()
            card.axis = .vertical
            card.spacing = 6
            card.isLayoutMarginsRelativeArrangement = true
            card.layoutMargins = UIEdgeInsets(top: 8, left: 10, bottom: 8, right: 10)
            card.layer.cornerRadius = 8
            card.backgroundColor = .secondarySystemBackground

            let summary = UILabel()
            summary.font = .preferredFont(forTextStyle: .footnote)
            summary.numberOfLines = 0
            summary.text = Self.savedAttemptSummary(attempt)
            card.addArrangedSubview(summary)

            let controls = UIStackView()
            controls.axis = .horizontal
            controls.spacing = 8
            controls.distribution = .fillEqually

            let review = UIButton(type: .system)
            review.setTitle("Review", for: .normal)
            review.addAction(UIAction { [weak self] _ in
                self?.reviewSavedAttempt(id: attempt.id)
            }, for: .touchUpInside)
            controls.addArrangedSubview(review)

            let replay = UIButton(type: .system)
            replay.setTitle("Replay", for: .normal)
            replay.accessibilityIdentifier = "voice-replay-\(attempt.id.uuidString)"
            replay.addAction(UIAction { [weak self] _ in
                self?.replaySavedAttempt(id: attempt.id)
            }, for: .touchUpInside)
            controls.addArrangedSubview(replay)

            let delete = UIButton(type: .system)
            delete.setTitle("Delete", for: .normal)
            delete.setTitleColor(.systemRed, for: .normal)
            delete.addAction(UIAction { [weak self] _ in
                self?.deleteSavedAttempt(id: attempt.id)
            }, for: .touchUpInside)
            controls.addArrangedSubview(delete)

            card.addArrangedSubview(controls)
            savedAttemptsStack.addArrangedSubview(card)
        }
    }

    private func updateMatrix() {
        let report = VoiceContextMatrix.evaluate(savedAttempts)
        let progress = VoiceContextMatrix.minimalPairs.map { pair in
            pair.prompts.map {
                "\($0) \(report.promptCounts[$0, default: 0])/\(VoiceContextMatrix.requiredTakesPerPrompt)"
            }
            .joined(separator: ", ")
        }
        .joined(separator: "\n")

        let decision: String
        switch report.recommendation {
        case .collectMore:
            decision = "Collect more evidence before deciding."
        case .keepContextPass:
            decision = "KEEP context pass as an experimental recognition signal."
        case .removeContextPass:
            decision = "REMOVE context pass; ordinary unaided STT remains."
        }
        matrixLabel.text = """
        \(decision)
        \(progress)
        Completed \(report.completedTakes)/\(report.requiredTakes); rank improvements \(report.rankImprovements), top-result promotions \(report.topResultPromotions), regressions \(report.regressions), improved pairs \(report.improvedPairCount)/\(VoiceContextMatrix.minimalPairs.count).
        Keep gate after full coverage: at least 4 top-result promotions across at least 2 pairs, with at most 1 regression.
        """
    }

    private func reviewSavedAttempt(id: UUID) {
        guard let attempt = savedAttempts.first(where: { $0.id == id }) else { return }
        targetField.text = attempt.targetPhrase
        if let analysis = attempt.analysis {
            verdictLabel.text = Self.describe(
                analysis.verdict,
                withoutContextMatch: analysis.withoutContextTargetMatch,
                withContextMatch: analysis.withContextTargetMatch
            )
            unaidedLabel.text = Self.describe(reading: analysis.withoutContext)
            aidedLabel.text = Self.describe(reading: analysis.withContext)
            let candidates = VoiceContextComparison.confusions(
                target: attempt.targetPhrase,
                reading: analysis.withoutContext
            )
            confusionsLabel.text = candidates.isEmpty ? "—" : candidates.joined(separator: ", ")
            statusLabel.text = "Loaded saved take \(attempt.id.uuidString.prefix(8))."
        } else if let failure = attempt.analysisFailure {
            verdictLabel.text = "Analysis failed for this retained recording."
            unaidedLabel.text = "—"
            aidedLabel.text = "—"
            confusionsLabel.text = "—"
            statusLabel.text = failure
        } else {
            verdictLabel.text = "Recognition metadata is still pending."
            unaidedLabel.text = "—"
            aidedLabel.text = "—"
            confusionsLabel.text = "—"
            statusLabel.text = "Recording retained before analysis completed."
        }
    }

    private func replaySavedAttempt(id: UUID) {
        guard !probe.isRecording else {
            statusLabel.text = "Stop recording before replaying a saved take."
            return
        }
        guard let attempt = savedAttempts.first(where: { $0.id == id }) else { return }
        synthesizer.stopSpeaking(at: .immediate)
        deactivateReferenceAudioSession()
        stopSavedTakePlayback()
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .spokenAudio)
            try session.setActive(true)
            referenceSessionActive = true

            let player = try AVAudioPlayer(contentsOf: attemptStore.audioURL(for: attempt))
            player.delegate = self
            player.isMeteringEnabled = true
            guard player.prepareToPlay(), player.play() else {
                throw VoiceAttemptStore.StoreError.invalidAttempt(attempt.id)
            }
            audioPlayer = player
            replayingAttemptID = attempt.id
            statusLabel.text = "Replaying saved take \(attempt.id.uuidString.prefix(8))."
            startLevelMeter(source: .replay)
        } catch {
            stopSavedTakePlayback()
            deactivateReferenceAudioSession()
            statusLabel.text = "Replay failed: \(error.localizedDescription)"
        }
    }

    private func deleteSavedAttempt(id: UUID) {
        if replayingAttemptID == id {
            stopSavedTakePlayback()
            deactivateReferenceAudioSession()
        }
        do {
            try attemptStore.delete(attemptID: id)
            statusLabel.text = "Saved take deleted."
            refreshSavedAttempts()
        } catch {
            statusLabel.text = "Delete failed: \(error.localizedDescription)"
        }
    }

    private func deleteAllSavedAttempts() {
        stopSavedTakePlayback()
        deactivateReferenceAudioSession()
        do {
            try attemptStore.deleteAll()
            statusLabel.text = "All saved takes deleted."
            refreshSavedAttempts()
        } catch {
            statusLabel.text = "Delete failed: \(error.localizedDescription)"
        }
    }

    private func retainInterruptedCapture(message: String) {
        stopLevelMeter(source: .recording)
        recordButton.setTitle("Record", for: .normal)
        retentionSwitch.isEnabled = true
        defer {
            activeTarget = nil
            activeAttemptID = nil
        }
        guard activeShouldRetain else {
            statusLabel.text = message
            return
        }
        do {
            let capture = try probe.capturedTake()
            let saved = try attemptStore.save(
                capture: capture,
                targetPhrase: activeTarget ?? targetField.text ?? "",
                locale: probe.analysisLocale
            )
            _ = try attemptStore.recordAnalysisFailure(
                attemptID: saved.id,
                message: message
            )
            statusLabel.text = "\(message) Partial recording retained."
            refreshSavedAttempts()
        } catch {
            statusLabel.text = "\(message) Partial recording could not be saved: \(error.localizedDescription)"
        }
    }

    private func stopSavedTakePlayback() {
        audioPlayer?.stop()
        audioPlayer = nil
        replayingAttemptID = nil
        stopLevelMeter(source: .replay)
    }

    private func startLevelMeter(source: LevelMeterSource) {
        stopLevelMeter()
        levelMeterSource = source
        displayedLevel = 0
        levelMeter.progress = 0
        levelMeterLabel.text = source == .recording
            ? "Live microphone level"
            : "Saved take level"
        levelMeter.progressTintColor = source == .recording ? .systemRed : .systemBlue
        levelMeterStack.isHidden = false
        updateLevelMeter()

        levelMeterTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .milliseconds(50))
                } catch {
                    return
                }
                guard !Task.isCancelled else { return }
                guard self != nil else { return }
                self?.updateLevelMeter()
            }
        }
    }

    private func updateLevelMeter() {
        let measuredLevel: Float
        switch levelMeterSource {
        case .recording:
            measuredLevel = probe.currentAudioLevel
        case .replay:
            guard let audioPlayer, audioPlayer.isPlaying else {
                measuredLevel = 0
                break
            }
            audioPlayer.updateMeters()
            measuredLevel = (0..<audioPlayer.numberOfChannels)
                .map { VoiceAudioLevel.normalized(decibels: audioPlayer.averagePower(forChannel: $0)) }
                .max() ?? 0
        case nil:
            return
        }

        let response: Float = measuredLevel >= displayedLevel ? 0.65 : 0.18
        displayedLevel += (measuredLevel - displayedLevel) * response
        levelMeter.setProgress(displayedLevel, animated: false)
        levelMeter.accessibilityValue = "\(Int((displayedLevel * 100).rounded())) percent"
    }

    private func stopLevelMeter(source: LevelMeterSource? = nil) {
        guard source == nil || source == levelMeterSource else { return }
        levelMeterTask?.cancel()
        levelMeterTask = nil
        levelMeterSource = nil
        displayedLevel = 0
        levelMeter.progress = 0
        levelMeter.accessibilityValue = "0 percent"
        levelMeterStack.isHidden = true
    }

    private static func savedAttemptSummary(_ attempt: VoiceSavedAttempt) -> String {
        let state: String
        if let analysis = attempt.analysis {
            state = "\(matchDescription(analysis.withoutContextTargetMatch)) → \(matchDescription(analysis.withContextTargetMatch))"
        } else if attempt.analysisFailure != nil {
            state = "analysis failed"
        } else {
            state = "analysis pending"
        }
        return """
        \(attempt.targetPhrase) · \(attempt.createdAt.formatted(date: .abbreviated, time: .standard))
        \(String(format: "%.2fs", attempt.durationSeconds)) · \(Int(attempt.analyzerFormat.sampleRate)) Hz · \(state)
        build \(attempt.build.marketingVersion) (\(attempt.build.buildNumber)) \(attempt.build.gitSHA)
        """
    }

    private static func matchDescription(_ match: VoiceTargetMatch) -> String {
        switch match {
        case .absent: "absent"
        case .topResult: "top result"
        case .alternative: "alternative only"
        }
    }

    private var enclosingViewController: UIViewController? {
        var responder: UIResponder? = next
        while let current = responder {
            if let viewController = current as? UIViewController {
                return viewController
            }
            responder = current.next
        }
        return nil
    }

    func suspend() {
        recordingTask?.cancel()
        recordingTask = nil
        readingsTask?.cancel()
        readingsTask = nil
        let wasRecording = probe.isRecording
        probe.stopRecording()
        if wasRecording {
            retainInterruptedCapture(message: "Recording stopped when the Voice surface closed.")
        }
        synthesizer.stopSpeaking(at: .immediate)
        stopSavedTakePlayback()
        stopLevelMeter()
        deactivateReferenceAudioSession()
        recordButton.isEnabled = true
        retentionSwitch.isEnabled = true
        activeTarget = nil
        activeAttemptID = nil
    }

    func teardown() {
        suspend()
        preparationTask?.cancel()
        preparationTask = nil
        probe.onCaptureInterrupted = nil
    }

    private func deactivateReferenceAudioSession() {
        guard referenceSessionActive else { return }
        do {
            try AVAudioSession.sharedInstance().setActive(
                false,
                options: [.notifyOthersOnDeactivation]
            )
            referenceSessionActive = false
        } catch {
            statusLabel.text = "Reference audio cleanup failed: \(error.localizedDescription)"
        }
    }
}

@available(iOS 26.0, *)
extension VoicePlaygroundSurface: AVAudioPlayerDelegate, AVSpeechSynthesizerDelegate {
    nonisolated func audioPlayerDidFinishPlaying(
        _ player: AVAudioPlayer,
        successfully flag: Bool
    ) {
        Task { @MainActor [weak self] in
            self?.stopSavedTakePlayback()
            self?.deactivateReferenceAudioSession()
            self?.statusLabel.text = flag
                ? "Saved take replay finished."
                : "Saved take replay stopped before completion."
        }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(
        _ player: AVAudioPlayer,
        error: (any Error)?
    ) {
        Task { @MainActor [weak self] in
            self?.stopSavedTakePlayback()
            self?.deactivateReferenceAudioSession()
            self?.statusLabel.text = "Replay failed: \(error?.localizedDescription ?? "decode error")"
        }
    }

    nonisolated func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didFinish utterance: AVSpeechUtterance
    ) {
        Task { @MainActor [weak self] in
            self?.deactivateReferenceAudioSession()
        }
    }

    nonisolated func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didCancel utterance: AVSpeechUtterance
    ) {
        Task { @MainActor [weak self] in
            self?.deactivateReferenceAudioSession()
        }
    }
}
