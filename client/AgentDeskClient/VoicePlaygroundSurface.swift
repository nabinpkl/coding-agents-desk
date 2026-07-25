import AVFoundation
import UIKit

// Playground surface for an experimental recognition-context comparison.
//
// One take of audio, two transcription passes, and the difference between them
// shown side by side. This exists to answer one question before any model work
// is committed: does seeding `AnalysisContext.contextualStrings` produce an
// observable context-sensitivity signal on real speech?
//
// It is deliberately a probe, not a product surface. No persistence, no scoring
// model, no reference comparison.
@available(iOS 26.0, *)
final class VoicePlaygroundSurface: UIView {
    // Short contrasting words make context-induced recognition differences easy
    // to inspect without implying that the recognizer evaluated the speaker.
    private static let presets = ["think", "sink", "rice", "very", "ship", "sheep"]

    private let scrollView = UIScrollView()
    private let stack = UIStackView()
    private let targetField = UITextField()
    private let statusLabel = UILabel()
    private let recordButton = UIButton(type: .system)
    private let speakButton = UIButton(type: .system)
    private let verdictLabel = UILabel()
    private let unaidedLabel = UILabel()
    private let aidedLabel = UILabel()
    private let confusionsLabel = UILabel()

    private let probe = VoiceContextProbe()
    private let synthesizer = AVSpeechSynthesizer()
    private var isPrepared = false
    private var preparationTask: Task<Void, Never>?
    private var recordingTask: Task<Void, Never>?
    private var readingsTask: Task<Void, Never>?
    private var referenceSessionActive = false

    override init(frame: CGRect) {
        super.init(frame: frame)
        configure()
        synthesizer.delegate = self
        probe.onCaptureInterrupted = { [weak self] message in
            self?.recordButton.setTitle("Record", for: .normal)
            self?.statusLabel.text = message
        }
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
        stack.addArrangedSubview(presetRow())

        speakButton.setTitle("Hear reference", for: .normal)
        speakButton.addTarget(self, action: #selector(speakTarget), for: .touchUpInside)
        stack.addArrangedSubview(speakButton)

        recordButton.setTitle("Record", for: .normal)
        recordButton.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        recordButton.addTarget(self, action: #selector(toggleRecording), for: .touchUpInside)
        recordButton.accessibilityLabel = "Record"
        stack.addArrangedSubview(recordButton)

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
            ("Heard instead", confusionsLabel)
        ] {
            label.font = .monospacedSystemFont(ofSize: 14, weight: .regular)
            label.numberOfLines = 0
            stack.addArrangedSubview(self.caption(caption))
            stack.addArrangedSubview(label)
        }
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

    private func presetRow() -> UIView {
        let row = UIStackView()
        row.axis = .horizontal
        row.spacing = 8
        row.distribution = .fillEqually
        for word in Self.presets {
            let button = UIButton(type: .system)
            button.setTitle(word, for: .normal)
            button.titleLabel?.font = .preferredFont(forTextStyle: .footnote)
            button.addTarget(self, action: #selector(presetTapped(_:)), for: .touchUpInside)
            row.addArrangedSubview(button)
        }
        return row
    }

    // MARK: - Actions

    @objc private func dismissKeyboard() {
        targetField.resignFirstResponder()
    }

    @objc private func presetTapped(_ sender: UIButton) {
        targetField.text = sender.title(for: .normal)
    }

    @objc private func speakTarget() {
        guard let target = targetField.text, !target.isEmpty else { return }
        // Playing the reference mid-take would put the synthesized voice into the
        // recording and fight the probe for the audio session category.
        guard !probe.isRecording else {
            statusLabel.text = "Stop recording before playing the reference."
            return
        }
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
            probe.stopRecording()
            recordButton.setTitle("Record", for: .normal)
            statusLabel.text = "Transcribing both passes…"
            readingsTask?.cancel()
            readingsTask = Task { [weak self] in
                await self?.runReadings()
            }
        } else {
            synthesizer.stopSpeaking(at: .immediate)
            deactivateReferenceAudioSession()
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
        do {
            try await probe.startRecording()
            guard !Task.isCancelled else {
                probe.stopRecording()
                return
            }
            recordButton.setTitle("Stop", for: .normal)
            statusLabel.text = "Recording. Tap Stop when finished."
        } catch {
            guard !Task.isCancelled else { return }
            statusLabel.text = "Record failed: \(error.localizedDescription)"
        }
    }

    private func runReadings() async {
        let target = targetField.text ?? ""
        do {
            let (unaided, aided) = try await probe.readings(target: target)
            let verdict = VoiceContextComparison.verdict(
                target: target,
                withoutContext: unaided,
                withContext: aided
            )
            let confusions = VoiceContextComparison.confusions(target: target, reading: unaided)

            verdictLabel.text = Self.describe(verdict)
            unaidedLabel.text = Self.describe(reading: unaided)
            aidedLabel.text = Self.describe(reading: aided)
            confusionsLabel.text = confusions.isEmpty ? "—" : confusions.joined(separator: ", ")
            statusLabel.text = "Done."
        } catch {
            guard !Task.isCancelled else { return }
            statusLabel.text = "Transcribe failed: \(error.localizedDescription)"
        }
    }

    private static func describe(_ verdict: VoiceGapVerdict) -> String {
        switch verdict {
        case .clear:
            return "Unaided match: the target appeared without contextual bias."
        case .contextRescued:
            return "Context-sensitive: the target appeared only with contextual bias."
        case .missed:
            return "No match: the target did not appear in either transcription."
        case .inconsistent:
            return "Inconsistent: the target appeared only in the unaided transcription."
        }
    }

    private static func describe(reading: VoiceReading) -> String {
        var lines = [reading.text.isEmpty ? "(nothing)" : reading.text]
        if let confidence = reading.confidence {
            lines.append(String(format: "confidence %.3f", confidence))
        }
        if !reading.alternatives.isEmpty {
            lines.append("alts: " + reading.alternatives.joined(separator: " | "))
        }
        return lines.joined(separator: "\n")
    }

    func suspend() {
        recordingTask?.cancel()
        recordingTask = nil
        readingsTask?.cancel()
        readingsTask = nil
        let wasRecording = probe.isRecording
        probe.stopRecording()
        synthesizer.stopSpeaking(at: .immediate)
        deactivateReferenceAudioSession()
        if wasRecording {
            recordButton.setTitle("Record", for: .normal)
            statusLabel.text = "Recording stopped."
        }
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
extension VoicePlaygroundSurface: AVSpeechSynthesizerDelegate {
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
