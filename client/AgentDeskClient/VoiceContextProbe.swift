import AVFoundation
import Foundation
import Speech
import os

// Records one utterance, then transcribes that SAME audio twice: once with an
// empty recognition context, once with the target phrase seeded into
// `AnalysisContext.contextualStrings`.
//
// Both passes must run over identical audio. Recording twice would confound the
// comparison with ordinary utterance-to-utterance variation, which is the whole
// measurement — so capture is buffered once and replayed into two analyzers.
//
// Everything here is on-device. `SpeechTranscriber` needs no network and no
// account, but its per-locale model is a downloadable asset that is not
// guaranteed present, so `prepare()` installs it on demand.

/// Mirrors probe diagnostics to stderr as well as os_log.
///
/// `just iphone-console-run` captures stdout/stderr to
/// `/tmp/agentdesk-client-console.log`; os_log does not reach that stream, and
/// pulling it off the device needs `sudo log collect`. Anything needed to
/// diagnose a failed take therefore goes to both, matching the `[dom-mirror]`
/// and owned-media trace conventions.
///
/// Deliberately outside the main-actor-isolated probe so analyzer work can
/// report failures without acquiring UI state. The audio tap itself never logs.
enum VoiceProbeTrace {
    private static let logger = Logger(
        subsystem: Config.logSubsystem,
        category: "voice-probe"
    )

    static func emit(_ line: String) {
        logger.debug("\(line, privacy: .public)")
        FileHandle.standardError.write(Data(("[voice-probe] " + line + "\n").utf8))
    }
}

@available(iOS 26.0, *)
struct VoiceCapturedTake {
    let startedAt: Date
    let format: AVAudioFormat
    let buffers: [AVAudioPCMBuffer]

    var frameCount: AVAudioFramePosition {
        buffers.reduce(0) { $0 + AVAudioFramePosition($1.frameLength) }
    }

    var durationSeconds: TimeInterval {
        Double(frameCount) / format.sampleRate
    }
}

/// Audio-thread side of capture: owns the resampler and the accumulating
/// buffers.
///
/// `@unchecked Sendable` with an explicit lock, because the engine tap runs on a
/// real-time audio thread while the probe reads from the main actor. The lock is
/// the actual synchronization; the annotation just tells the compiler so.
@available(iOS 26.0, *)
final class CaptureSink: @unchecked Sendable {
    private let lock = NSLock()
    private let converter = VoiceBufferConverter()
    private let outputFormat: AVAudioFormat
    private var buffers: [AVAudioPCMBuffer] = []
    private var failures = 0
    private var level: Float = 0

    init(outputFormat: AVAudioFormat) {
        self.outputFormat = outputFormat
    }

    /// Resamples a tap buffer into the transcriber's negotiated format and
    /// retains it. A conversion error increments a counter rather than being
    /// swallowed, so a systematically broken format negotiation is visible in
    /// `failureCount` instead of showing up as mysteriously empty audio.
    ///
    /// Called on the real-time audio thread, so it captures no main-actor state
    /// and performs no logging or UI work.
    func accept(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        defer { lock.unlock() }
        do {
            let converted = try converter.convert(buffer, to: outputFormat)
            if converted.frameLength > 0 {
                level = VoiceAudioLevel.normalized(buffer: buffer)
                buffers.append(converted)
            }
        } catch {
            failures += 1
        }
    }

    func snapshot() -> [AVAudioPCMBuffer] {
        lock.withLock { buffers }
    }

    var failureCount: Int {
        lock.withLock { failures }
    }

    var currentLevel: Float {
        lock.withLock { level }
    }
}

/// Maps PCM amplitude or AVAudioPlayer power onto the same 0...1 speech display range.
///
/// The display curve gates very quiet room tone and reaches full visual height
/// around ordinary close-mic speech. This is presentation scaling only; the
/// captured PCM remains untouched for later analysis.
@available(iOS 26.0, *)
enum VoiceAudioLevel {
    private static let noiseFloorDecibels: Float = -50
    private static let speechPeakDecibels: Float = -18
    private static let displayExponent: Float = 1.35

    static func normalized(decibels: Float) -> Float {
        guard decibels.isFinite else { return 0 }
        let linearLevel = min(
            max(
                (decibels - noiseFloorDecibels)
                    / (speechPeakDecibels - noiseFloorDecibels),
                0
            ),
            1
        )
        return pow(linearLevel, displayExponent)
    }

    static func normalized(buffer: AVAudioPCMBuffer) -> Float {
        let frameCount = Int(buffer.frameLength)
        let channelCount = Int(buffer.format.channelCount)
        guard frameCount > 0, channelCount > 0 else { return 0 }

        let sampleCount = frameCount * channelCount
        let sumOfSquares: Double

        switch buffer.format.commonFormat {
        case .pcmFormatFloat32:
            guard let channels = buffer.floatChannelData else { return 0 }
            sumOfSquares = sumSquares(
                channels: channels,
                frameCount: frameCount,
                channelCount: channelCount,
                isInterleaved: buffer.format.isInterleaved,
                scale: 1
            )
        case .pcmFormatFloat64:
            return 0
        case .pcmFormatInt16:
            guard let channels = buffer.int16ChannelData else { return 0 }
            sumOfSquares = sumSquares(
                channels: channels,
                frameCount: frameCount,
                channelCount: channelCount,
                isInterleaved: buffer.format.isInterleaved,
                scale: 1 / Double(Int16.max)
            )
        case .pcmFormatInt32:
            guard let channels = buffer.int32ChannelData else { return 0 }
            sumOfSquares = sumSquares(
                channels: channels,
                frameCount: frameCount,
                channelCount: channelCount,
                isInterleaved: buffer.format.isInterleaved,
                scale: 1 / Double(Int32.max)
            )
        case .otherFormat:
            return 0
        @unknown default:
            return 0
        }

        let rootMeanSquare = sqrt(sumOfSquares / Double(sampleCount))
        guard rootMeanSquare > 0 else { return 0 }
        return normalized(decibels: Float(20 * log10(rootMeanSquare)))
    }

    private static func sumSquares<Sample: BinaryInteger>(
        channels: UnsafePointer<UnsafeMutablePointer<Sample>>,
        frameCount: Int,
        channelCount: Int,
        isInterleaved: Bool,
        scale: Double
    ) -> Double {
        var sum = 0.0
        if isInterleaved {
            for index in 0..<(frameCount * channelCount) {
                let scaled = Double(channels[0][index]) * scale
                sum += scaled * scaled
            }
        } else {
            for channel in 0..<channelCount {
                for frame in 0..<frameCount {
                    let scaled = Double(channels[channel][frame]) * scale
                    sum += scaled * scaled
                }
            }
        }
        return sum
    }

    private static func sumSquares(
        channels: UnsafePointer<UnsafeMutablePointer<Float>>,
        frameCount: Int,
        channelCount: Int,
        isInterleaved: Bool,
        scale: Double
    ) -> Double {
        var sum = 0.0
        if isInterleaved {
            for index in 0..<(frameCount * channelCount) {
                let scaled = Double(channels[0][index]) * scale
                sum += scaled * scaled
            }
        } else {
            for channel in 0..<channelCount {
                for frame in 0..<frameCount {
                    let scaled = Double(channels[channel][frame]) * scale
                    sum += scaled * scaled
                }
            }
        }
        return sum
    }
}

/// Constructs callbacks outside `VoiceContextProbe`'s main-actor
/// isolation. AVFAudio invokes tap blocks on its own real-time queue; forming
/// the block inside a `@MainActor` method makes Swift 6 attach a main-actor
/// precondition that traps as soon as the first microphone buffer arrives.
@available(iOS 26.0, *)
enum VoiceAudioCallbacks {
    nonisolated static func tap(for sink: CaptureSink) -> AVAudioNodeTapBlock {
        { buffer, _ in sink.accept(buffer) }
    }

    nonisolated static func configurationChange(
        handler: @escaping @MainActor @Sendable () -> Void
    ) -> @Sendable (Notification) -> Void {
        { _ in
            Task { @MainActor in handler() }
        }
    }
}

@available(iOS 26.0, *)
@MainActor
final class VoiceContextProbe {
    enum ProbeError: LocalizedError {
        case transcriberUnavailable
        case localeUnsupported(String)
        case microphonePermissionDenied
        case noAudioCaptured
        case audioFormatUnavailable
        case inputUnavailable(String)

        var errorDescription: String? {
            switch self {
            case .transcriberUnavailable:
                return "Speech transcription is unavailable on this device."
            case .localeUnsupported(let identifier):
                return "No transcription model for \(identifier)."
            case .microphonePermissionDenied:
                return "Microphone access denied. Enable it in Settings."
            case .noAudioCaptured:
                return "No audio was captured."
            case .audioFormatUnavailable:
                return "Could not negotiate an audio format with the transcriber."
            case .inputUnavailable(let detail):
                return "Microphone input unavailable (\(detail))."
            }
        }
    }

    private let requestedLocale: Locale
    /// Built per take, never up front. `AVAudioEngine` binds to the audio
    /// hardware configuration present when it is created. Activating the
    /// `.record` session first keeps the engine and input node formats aligned
    /// with the route used for the take.
    private var engine: AVAudioEngine?
    private var configurationObserver: NSObjectProtocol?
    private var sink: CaptureSink?
    private var resolvedLocale: Locale?
    private var analyzerFormat: AVAudioFormat?
    private var recordingStartedAt: Date?
    private var tapInstalled = false
    private var sessionActivated = false

    private(set) var isRecording = false
    private(set) var transcriptionAvailable = false
    var analysisLocale: Locale { resolvedLocale ?? requestedLocale }
    var currentAudioLevel: Float { sink?.currentLevel ?? 0 }
    var onCaptureInterrupted: (@MainActor @Sendable (String) -> Void)?

    init(locale: Locale = Locale(identifier: "en-US")) {
        self.requestedLocale = locale
    }

    // MARK: - Model readiness

    /// Resolves the locale and installs the transcription assets if missing.
    /// Progress is reported so a slow first run is visible rather than looking
    /// like a hang.
    func prepare(progress: @escaping (String) -> Void) async throws {
        guard SpeechTranscriber.isAvailable else {
            throw ProbeError.transcriberUnavailable
        }

        guard let supported = await SpeechTranscriber.supportedLocale(
            equivalentTo: requestedLocale
        ) else {
            throw ProbeError.localeUnsupported(requestedLocale.identifier)
        }
        try await prepareTranscription(
            locale: supported,
            progress: progress
        )
        progress("Ready.")
    }

    /// Prepares passage capture even when the current hardware cannot run
    /// SpeechTranscriber. Retained audio and raw-phone analysis do not depend
    /// on transcription, and the transcript remains editable.
    func preparePassageCapture(
        progress: @escaping (String) -> Void
    ) async throws {
        if SpeechTranscriber.isAvailable,
           let supported = await SpeechTranscriber.supportedLocale(
               equivalentTo: requestedLocale
           )
        {
            try await prepareTranscription(
                locale: supported,
                progress: progress
            )
            progress("Ready.")
            return
        }

        guard let fallbackFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: 16_000,
            channels: 1,
            interleaved: false
        ) else {
            throw ProbeError.audioFormatUnavailable
        }
        resolvedLocale = requestedLocale
        analyzerFormat = fallbackFormat
        transcriptionAvailable = false
        VoiceProbeTrace.emit(
            "SpeechTranscriber unavailable; passage capture uses "
                + "16000Hz mono Float32"
        )
        progress(
            "Ready to record. Transcription is unavailable on this "
                + "device; saved audio can still be analyzed."
        )
    }

    private func prepareTranscription(
        locale: Locale,
        progress: @escaping (String) -> Void
    ) async throws {
        transcriptionAvailable = false
        resolvedLocale = locale

        let transcriber = Self.makeTranscriber(locale: locale)
        let status = await AssetInventory.status(forModules: [transcriber])
        VoiceProbeTrace.emit("asset status: \(status)")

        if status != .installed {
            progress("Installing \(locale.identifier) speech model…")
            if let request = try await AssetInventory.assetInstallationRequest(
                supporting: [transcriber]
            ) {
                try await request.downloadAndInstall()
            }
        }

        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(
            compatibleWith: [transcriber]
        ) else {
            throw ProbeError.audioFormatUnavailable
        }
        analyzerFormat = format
        transcriptionAvailable = true
        VoiceProbeTrace.emit(
            "analyzer format: \(format.sampleRate)Hz "
                + "ch=\(format.channelCount) "
                + "common=\(format.commonFormat.rawValue)"
        )
    }

    // MARK: - Capture

    func startRecording() async throws {
        guard !isRecording else { return }
        VoiceProbeTrace.emit("startRecording: requesting permission")
        guard await Self.requestMicrophonePermission() else {
            throw ProbeError.microphonePermissionDenied
        }
        try Task.checkCancellation()
        VoiceProbeTrace.emit("startRecording: permission granted")
        guard let analyzerFormat else { throw ProbeError.audioFormatUnavailable }

        // Clear captured audio and any partial engine left by a failed attempt.
        cleanupCapture(clearCapturedAudio: true)

        // `.record` with no mode or option embellishment. Nothing here needs
        // playback, Bluetooth routing, or signal-processing policy.
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.record, mode: .default)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            sessionActivated = true
            VoiceProbeTrace.emit("session active, category=record")

            // Only now build the engine, against the settled `.record` route.
            let engine = AVAudioEngine()
            self.engine = engine
            observeConfigurationChanges(of: engine)

            let input = engine.inputNode
            let inputFormat = input.outputFormat(forBus: 0)
            let hardwareFormat = input.inputFormat(forBus: 0)
            VoiceProbeTrace.emit(
                "node out: \(inputFormat.sampleRate)Hz ch=\(inputFormat.channelCount) "
                + "| node in: \(hardwareFormat.sampleRate)Hz ch=\(hardwareFormat.channelCount) "
                + "| session: \(session.sampleRate)Hz ch=\(session.inputNumberOfChannels) "
                + "inputAvailable=\(session.isInputAvailable)"
            )

            // `installTap` raises an ObjC exception on a zero-rate or
            // zero-channel format instead of throwing. Validate first so an
            // unavailable input becomes a normal error.
            guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
                throw ProbeError.inputUnavailable(
                    "\(inputFormat.sampleRate)Hz, \(inputFormat.channelCount)ch"
                )
            }

            let sink = CaptureSink(outputFormat: analyzerFormat)
            self.sink = sink

            // `format: nil` asks for the node's actual runtime format. The
            // converter derives its input format from each delivered buffer.
            input.installTap(
                onBus: 0,
                bufferSize: 8192,
                format: nil,
                block: VoiceAudioCallbacks.tap(for: sink)
            )
            tapInstalled = true

            VoiceProbeTrace.emit("tap installed, starting engine")
            engine.prepare()
            try engine.start()
            recordingStartedAt = Date()
            isRecording = true
            VoiceProbeTrace.emit("engine running")
        } catch {
            cleanupCapture(clearCapturedAudio: true)
            throw error
        }
    }

    func stopRecording() {
        cleanupCapture(clearCapturedAudio: false)
    }

    func capturedTake() throws -> VoiceCapturedTake {
        guard let analyzerFormat else { throw ProbeError.audioFormatUnavailable }
        let buffers = sink?.snapshot() ?? []
        guard !buffers.isEmpty else { throw ProbeError.noAudioCaptured }
        guard let recordingStartedAt else { throw ProbeError.noAudioCaptured }
        return VoiceCapturedTake(
            startedAt: recordingStartedAt,
            format: analyzerFormat,
            buffers: buffers
        )
    }

    private func cleanupCapture(clearCapturedAudio: Bool) {
        let wasActive = engine != nil || tapInstalled || isRecording || sessionActivated
        if wasActive {
            VoiceProbeTrace.emit("stopRecording: cleaning capture")
        }

        if let configurationObserver {
            NotificationCenter.default.removeObserver(configurationObserver)
            self.configurationObserver = nil
        }

        if let engine {
            if tapInstalled {
                engine.inputNode.removeTap(onBus: 0)
            }
            engine.stop()
        }
        engine = nil
        tapInstalled = false
        isRecording = false

        if let failures = sink?.failureCount, failures > 0 {
            VoiceProbeTrace.emit("WARNING dropped \(failures) buffers during resample")
        }
        if clearCapturedAudio {
            sink = nil
            recordingStartedAt = nil
        }

        if sessionActivated {
            do {
                try AVAudioSession.sharedInstance().setActive(
                    false,
                    options: [.notifyOthersOnDeactivation]
                )
                sessionActivated = false
            } catch {
                VoiceProbeTrace.emit("WARNING audio session deactivation failed: \(error)")
            }
        }

        if wasActive {
            VoiceProbeTrace.emit(
                "stopRecording: done, \(sink?.snapshot().count ?? 0) buffers"
            )
        }
    }

    // MARK: - The two readings

    /// Transcribes the captured audio once without vocabulary context. Passage
    /// mode uses this result as editable text; it does not know the intended
    /// phrase before recording.
    func unaidedReading() async throws -> VoiceReading {
        VoiceProbeTrace.emit("unaidedReading: entered")
        guard let locale = resolvedLocale else {
            throw ProbeError.localeUnsupported(requestedLocale.identifier)
        }
        let buffers = sink?.snapshot() ?? []
        VoiceProbeTrace.emit(
            "unaidedReading: \(buffers.count) captured buffers"
        )
        guard !buffers.isEmpty else { throw ProbeError.noAudioCaptured }
        let reading = try await Self.transcribe(
            locale: locale,
            inputs: buffers.map { AnalyzerInput(buffer: $0) },
            contextualStrings: []
        )
        VoiceProbeTrace.emit(
            "unaidedReading complete: text=\(!reading.top.text.isEmpty) "
                + "alts=\(reading.alternatives.count)"
        )
        return reading
    }

    /// Re-runs unaided transcription from retained audio. This path is
    /// independent of the current in-memory capture, so a recording remains
    /// analyzable after navigation or app restart.
    func unaidedReading(
        audioURL: URL,
        localeIdentifier: String
    ) async throws -> VoiceReading {
        VoiceProbeTrace.emit("unaidedReading(file): entered")
        guard SpeechTranscriber.isAvailable else {
            throw ProbeError.transcriberUnavailable
        }
        let requested = Locale(identifier: localeIdentifier)
        guard let locale = await SpeechTranscriber.supportedLocale(
            equivalentTo: requested
        ) else {
            throw ProbeError.localeUnsupported(localeIdentifier)
        }
        let audioFile = try AVAudioFile(forReading: audioURL)
        let reading = try await Self.transcribe(
            locale: locale,
            audioFile: audioFile
        )
        VoiceProbeTrace.emit(
            "unaidedReading(file) complete: "
                + "text=\(!reading.top.text.isEmpty) "
                + "alts=\(reading.alternatives.count)"
        )
        return reading
    }

    /// Transcribes the captured audio twice and returns the unaided reading
    /// first, the context-seeded reading second.
    func readings(
        target: String
    ) async throws -> (withoutContext: VoiceReading, withContext: VoiceReading) {
        VoiceProbeTrace.emit("readings: entered")
        guard let locale = resolvedLocale else {
            throw ProbeError.localeUnsupported(requestedLocale.identifier)
        }
        let buffers = sink?.snapshot() ?? []
        VoiceProbeTrace.emit("readings: \(buffers.count) captured buffers")
        guard !buffers.isEmpty else { throw ProbeError.noAudioCaptured }

        // `AnalyzerInput` is Sendable where `AVAudioPCMBuffer` is not, so the
        // inputs are built here on the main actor and only the Sendable values
        // cross into the analyzer's stream.
        let inputs = buffers.map { AnalyzerInput(buffer: $0) }

        let unaided = try await Self.transcribe(
            locale: locale,
            inputs: inputs,
            contextualStrings: []
        )
        VoiceProbeTrace.emit(
            "pass 1 complete: text=\(!unaided.top.text.isEmpty) alts=\(unaided.alternatives.count)"
        )
        let aided = try await Self.transcribe(
            locale: locale,
            inputs: inputs,
            contextualStrings: [target]
        )
        VoiceProbeTrace.emit(
            "pass 2 complete: text=\(!aided.top.text.isEmpty) alts=\(aided.alternatives.count)"
        )
        return (unaided, aided)
    }

    private static func makeTranscriber(locale: Locale) -> SpeechTranscriber {
        SpeechTranscriber(
            locale: locale,
            transcriptionOptions: [],
            reportingOptions: [.alternativeTranscriptions],
            attributeOptions: [.transcriptionConfidence, .audioTimeRange]
        )
    }

    private static func transcribe(
        locale: Locale,
        inputs: [AnalyzerInput],
        contextualStrings: [String]
    ) async throws -> VoiceReading {
        let transcriber = makeTranscriber(locale: locale)
        let analyzer = SpeechAnalyzer(modules: [transcriber])

        if !contextualStrings.isEmpty {
            let context = AnalysisContext()
            context.contextualStrings = [.general: contextualStrings]
            try await analyzer.setContext(context)
        }

        // Drain `results` before feeding input: the sequence must already have a
        // consumer when the analyzer emits, or finalization can complete against
        // nobody listening and the reading comes back empty.
        let collector = Task {
            var text = ""
            var alternatives: [VoiceRecognitionCandidate] = []
            var confidences: [Double] = []
            for try await result in transcriber.results {
                text += String(result.text.characters)
                alternatives += result.alternatives.map {
                    VoiceRecognitionCandidate(
                        text: String($0.characters),
                        confidence: meanConfidence(in: $0)
                    )
                }
                for run in result.text.runs {
                    if let value = run.transcriptionConfidence { confidences.append(value) }
                }
            }
            let mean = confidences.isEmpty
                ? nil
                : confidences.reduce(0, +) / Double(confidences.count)
            return (text, alternatives, mean)
        }
        defer { collector.cancel() }

        let stream = AsyncStream<AnalyzerInput> { continuation in
            for input in inputs { continuation.yield(input) }
            continuation.finish()
        }

        _ = try await analyzer.analyzeSequence(stream)
        try await analyzer.finalizeAndFinishThroughEndOfInput()

        let (text, alternatives, confidence) = try await collector.value
        return VoiceReading(
            top: VoiceRecognitionCandidate(
                text: text.trimmingCharacters(in: .whitespacesAndNewlines),
                confidence: confidence
            ),
            alternatives: alternatives
        )
    }

    private static func transcribe(
        locale: Locale,
        audioFile: AVAudioFile
    ) async throws -> VoiceReading {
        let transcriber = makeTranscriber(locale: locale)
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let collector = Task {
            var text = ""
            var alternatives: [VoiceRecognitionCandidate] = []
            var confidences: [Double] = []
            for try await result in transcriber.results {
                text += String(result.text.characters)
                alternatives += result.alternatives.map {
                    VoiceRecognitionCandidate(
                        text: String($0.characters),
                        confidence: meanConfidence(in: $0)
                    )
                }
                for run in result.text.runs {
                    if let value = run.transcriptionConfidence {
                        confidences.append(value)
                    }
                }
            }
            let mean = confidences.isEmpty
                ? nil
                : confidences.reduce(0, +) / Double(confidences.count)
            return (text, alternatives, mean)
        }
        defer { collector.cancel() }

        if let lastSample = try await analyzer.analyzeSequence(
            from: audioFile
        ) {
            try await analyzer.finalizeAndFinish(through: lastSample)
        } else {
            await analyzer.cancelAndFinishNow()
        }

        let (text, alternatives, confidence) = try await collector.value
        return VoiceReading(
            top: VoiceRecognitionCandidate(
                text: text.trimmingCharacters(
                    in: .whitespacesAndNewlines
                ),
                confidence: confidence
            ),
            alternatives: alternatives
        )
    }

    private static func meanConfidence(in text: AttributedString) -> Double? {
        let values = text.runs.compactMap(\.transcriptionConfidence)
        guard !values.isEmpty else { return nil }
        return values.reduce(0, +) / Double(values.count)
    }

    /// A route change mid-take invalidates the running graph. Stop immediately
    /// rather than analyzing a discontinuous capture.
    private func observeConfigurationChanges(of engine: AVAudioEngine) {
        if let configurationObserver {
            NotificationCenter.default.removeObserver(configurationObserver)
        }
        let handler = VoiceAudioCallbacks.configurationChange { [weak self] in
            self?.handleConfigurationChange()
        }
        configurationObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: engine,
            queue: .main,
            using: handler
        )
    }

    private func handleConfigurationChange() {
        guard engine != nil else { return }
        VoiceProbeTrace.emit("audio engine configuration changed; stopping take")
        stopRecording()
        onCaptureInterrupted?("Recording stopped because the audio route changed. Try again.")
    }

    private static func requestMicrophonePermission() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return true
        case .denied: return false
        default:
            return await withCheckedContinuation { continuation in
                AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
            }
        }
    }
}
