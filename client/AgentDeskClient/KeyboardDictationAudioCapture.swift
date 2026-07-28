import AVFoundation
import Foundation

struct KeyboardDictationPCMFrame: Sendable {
    let captureSessionID: UUID
    let sequence: Int
    let samples: Data
}

enum KeyboardDictationAudioError: LocalizedError {
    case microphoneDenied
    case inputUnavailable
    case conversionFailed
    case queueOverflow
    case interrupted

    var errorDescription: String? {
        switch self {
        case .microphoneDenied:
            "Microphone access is required for keyboard dictation."
        case .inputUnavailable:
            "The iPhone microphone is unavailable."
        case .conversionFailed:
            "The microphone audio could not be converted to 16 kHz mono."
        case .queueOverflow:
            "The Mac connection could not keep up with microphone audio."
        case .interrupted:
            "Keyboard dictation stopped because iOS interrupted audio capture."
        }
    }
}

/// Audio-thread state. The engine always invokes the tap while the service is
/// armed, but this object returns before conversion unless an explicit capture
/// is active. Idle buffers therefore never enter App Group storage or transport.
final class KeyboardDictationCaptureSink:
    VoiceAudioBufferSink,
    @unchecked Sendable
{
    typealias FrameHandler = @Sendable (KeyboardDictationPCMFrame) -> Void
    typealias MeterHandler = @Sendable (UUID, Float) -> Void
    typealias FailureHandler = @Sendable (UUID, Error) -> Void

    private let lock = NSLock()
    private let converter = VoiceBufferConverter()
    private let outputFormat: AVAudioFormat
    private let frameHandler: FrameHandler
    private let meterHandler: MeterHandler
    private let failureHandler: FailureHandler
    private var capturing = false
    private var captureSessionID: UUID?
    private var samples: [Float] = []
    private var readOffset = 0
    private var nextSequence = 0
    private var lastMeterPublish = ContinuousClock.now

    init(
        outputFormat: AVAudioFormat,
        frameHandler: @escaping FrameHandler,
        meterHandler: @escaping MeterHandler,
        failureHandler: @escaping FailureHandler
    ) {
        self.outputFormat = outputFormat
        self.frameHandler = frameHandler
        self.meterHandler = meterHandler
        self.failureHandler = failureHandler
    }

    func begin(captureSessionID: UUID) {
        lock.withLock {
            capturing = true
            self.captureSessionID = captureSessionID
            samples.removeAll(keepingCapacity: true)
            readOffset = 0
            nextSequence = 0
            lastMeterPublish = .now
        }
    }

    /// Stops acceptance synchronously on the audio thread boundary and emits a
    /// final short frame. The returned sequence is a flush fence for the actor
    /// queue, not a sample count.
    func finish() -> Int {
        lock.withLock {
            guard capturing else { return nextSequence - 1 }
            capturing = false
            if readOffset < samples.count {
                emit(Array(samples[readOffset...]))
            }
            let lastSequence = nextSequence - 1
            captureSessionID = nil
            samples.removeAll(keepingCapacity: true)
            readOffset = 0
            return lastSequence
        }
    }

    func accept(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        guard capturing else {
            lock.unlock()
            return
        }
        do {
            let converted = try converter.convert(buffer, to: outputFormat)
            guard let channel = converted.floatChannelData?[0] else {
                let failedSessionID = captureSessionID
                capturing = false
                captureSessionID = nil
                lock.unlock()
                if let failedSessionID {
                    failureHandler(
                        failedSessionID,
                        KeyboardDictationAudioError.conversionFailed
                    )
                }
                return
            }
            let count = Int(converted.frameLength)
            if count > 0 {
                samples.append(contentsOf: UnsafeBufferPointer(
                    start: channel,
                    count: count
                ))
                while samples.count - readOffset >= 2_048 {
                    emit(Array(samples[readOffset..<(readOffset + 2_048)]))
                    readOffset += 2_048
                }
                if readOffset >= 16_384 {
                    samples.removeFirst(readOffset)
                    readOffset = 0
                }
            }
            let shouldPublishMeter = lastMeterPublish.duration(
                to: .now
            ) >= .milliseconds(100)
            if shouldPublishMeter {
                lastMeterPublish = .now
            }
            let meterSessionID = shouldPublishMeter
                ? captureSessionID
                : nil
            lock.unlock()
            if let meterSessionID {
                meterHandler(meterSessionID, Self.meterLevel(buffer))
            }
        } catch {
            let failedSessionID = captureSessionID
            capturing = false
            captureSessionID = nil
            lock.unlock()
            if let failedSessionID {
                failureHandler(
                    failedSessionID,
                    KeyboardDictationAudioError.conversionFailed
                )
            }
        }
    }

    private func emit(_ frameSamples: [Float]) {
        guard let captureSessionID else { return }
        let data = frameSamples.withUnsafeBytes { Data($0) }
        frameHandler(KeyboardDictationPCMFrame(
            captureSessionID: captureSessionID,
            sequence: nextSequence,
            samples: data
        ))
        nextSequence += 1
    }

    private static func meterLevel(_ buffer: AVAudioPCMBuffer) -> Float {
        guard let channel = buffer.floatChannelData?[0],
              buffer.frameLength > 0
        else {
            return 0
        }
        var sum: Float = 0
        for sample in UnsafeBufferPointer(
            start: channel,
            count: Int(buffer.frameLength)
        ) {
            sum += sample * sample
        }
        let rms = sqrt(sum / Float(buffer.frameLength))
        let decibels = 20 * log10(max(rms, 0.000_001))
        return min(max((decibels + 50) / 32, 0), 1)
    }
}

@MainActor
final class KeyboardDictationAudioCapture {
    var onFrame: (@Sendable (KeyboardDictationPCMFrame) -> Void)?
    var onMeter: (@Sendable (UUID, Float) -> Void)?
    var onCaptureFailure: (@Sendable (UUID, Error) -> Void)?
    var onServiceFailure: (@Sendable (Error) -> Void)?

    private var engine: AVAudioEngine?
    private var sink: KeyboardDictationCaptureSink?
    private var interruptionObserver: NSObjectProtocol?
    private var routeObserver: NSObjectProtocol?

    var isArmed: Bool {
        engine?.isRunning == true
    }

    func arm() async throws {
        guard await Self.requestMicrophonePermission() else {
            throw KeyboardDictationAudioError.microphoneDenied
        }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
            .playAndRecord,
            mode: .default,
            options: [.mixWithOthers, .allowBluetoothHFP]
        )
        try session.setActive(true)

        let engine = AVAudioEngine()
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0,
              inputFormat.channelCount > 0,
              let outputFormat = AVAudioFormat(
                  standardFormatWithSampleRate: 16_000,
                  channels: 1
              )
        else {
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
            throw KeyboardDictationAudioError.inputUnavailable
        }
        let frameHandler = onFrame
        let meterHandler = onMeter
        let captureFailureHandler = onCaptureFailure
        let sink = KeyboardDictationCaptureSink(
            outputFormat: outputFormat,
            frameHandler: { frame in
                frameHandler?(frame)
            },
            meterHandler: { captureSessionID, level in
                meterHandler?(captureSessionID, level)
            },
            failureHandler: { captureSessionID, error in
                captureFailureHandler?(captureSessionID, error)
            }
        )
        // `format: nil` follows the input node's actual runtime format after
        // the play-and-record route settles. The sink converts each delivered
        // buffer from its own format to 16 kHz mono.
        input.installTap(
            onBus: 0,
            bufferSize: 2_048,
            format: nil,
            block: VoiceAudioCallbacks.tap(for: sink)
        )
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
            throw error
        }
        self.engine = engine
        self.sink = sink
        installObservers()
    }

    func beginCapture(sessionID: UUID) throws {
        guard isArmed, let sink else {
            throw KeyboardDictationAudioError.inputUnavailable
        }
        sink.begin(captureSessionID: sessionID)
    }

    func stopCapture() -> Int {
        sink?.finish() ?? -1
    }

    func disarm() {
        if let interruptionObserver {
            NotificationCenter.default.removeObserver(interruptionObserver)
        }
        if let routeObserver {
            NotificationCenter.default.removeObserver(routeObserver)
        }
        interruptionObserver = nil
        routeObserver = nil
        _ = sink?.finish()
        if let engine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        engine = nil
        sink = nil
        try? AVAudioSession.sharedInstance().setActive(
            false,
            options: .notifyOthersOnDeactivation
        )
    }

    private func installObservers() {
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] notification in
            let raw = notification.userInfo?[
                AVAudioSessionInterruptionTypeKey
            ] as? UInt
            Task { @MainActor in
                guard let raw,
                      AVAudioSession.InterruptionType(rawValue: raw) == .began
                else {
                    return
                }
                self?.onServiceFailure?(
                    KeyboardDictationAudioError.interrupted
                )
            }
        }
        routeObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                guard self?.engine?.isRunning == false else { return }
                self?.onServiceFailure?(
                    KeyboardDictationAudioError.interrupted
                )
            }
        }
    }

    private static func requestMicrophonePermission() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted:
            true
        case .denied:
            false
        default:
            await withCheckedContinuation { continuation in
                AVAudioApplication.requestRecordPermission {
                    continuation.resume(returning: $0)
                }
            }
        }
    }
}
