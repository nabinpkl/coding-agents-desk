import AVFoundation
import os

// Captures the default input device entirely in memory: an AVAudioEngine
// tap feeds an AVAudioConverter that downsamples to 16 kHz mono 16-bit PCM,
// accumulated in a Data buffer. stop() returns a finished WAV. Nothing is
// written to disk, so AVAudioRecorder (which requires a file URL) is not
// usable here.
//
// Not @MainActor: the input tap fires on a realtime audio thread. The
// accumulator is guarded by a lock; start()/stop() touch only the engine
// and are called from the main thread.
final class MicRecorder {
    enum RecorderError: Error {
        case engineUnavailable
        case converterUnavailable
        case engineStartFailed
    }

    static let sampleRate = 16_000

    // Invoked from the realtime audio thread with the peak amplitude of the
    // latest buffer, normalised to 0...1. Set once before start() so the tap
    // never races a mid-recording reassignment; the consumer hops to the
    // main actor to drive the meter.
    var onLevel: ((Float) -> Void)?

    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "mic")
    private let engine = AVAudioEngine()
    private let lock = NSLock()
    private var converter: AVAudioConverter?
    private var outputFormat: AVAudioFormat?
    private var pcm = Data()
    private var isRecording = false

    static func authorizationStatus() -> AVAuthorizationStatus {
        AVCaptureDevice.authorizationStatus(for: .audio)
    }

    static func requestAccess() async -> Bool {
        await withCheckedContinuation { continuation in
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                continuation.resume(returning: granted)
            }
        }
    }

    func start() throws {
        guard !isRecording else { return }
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
            throw RecorderError.engineUnavailable
        }
        guard let outputFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: Double(Self.sampleRate),
            channels: 1,
            interleaved: true
        ) else {
            throw RecorderError.converterUnavailable
        }
        guard let converter = AVAudioConverter(from: inputFormat, to: outputFormat) else {
            throw RecorderError.converterUnavailable
        }
        self.outputFormat = outputFormat
        self.converter = converter

        lock.lock()
        pcm.removeAll(keepingCapacity: true)
        lock.unlock()

        input.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buffer, _ in
            self?.appendConverted(buffer)
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            logger.error("audio engine start failed: \(String(describing: error), privacy: .public)")
            throw RecorderError.engineStartFailed
        }
        isRecording = true
        logger.notice("mic recording started in=\(inputFormat.sampleRate, privacy: .public)Hz")
    }

    func stop() -> Data {
        guard isRecording else { return Data() }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        isRecording = false
        converter = nil
        outputFormat = nil

        lock.lock()
        let captured = pcm
        pcm = Data()
        lock.unlock()

        logger.notice("mic recording stopped bytes=\(captured.count, privacy: .public)")
        return WAVEncoder.encode(pcm16LE: captured, sampleRate: Self.sampleRate, channels: 1)
    }

    // Runs on the audio thread. Pushes one input buffer through the
    // stateful converter (it carries resampler state across calls) and
    // copies the resulting int16 samples into the accumulator under lock.
    private func appendConverted(_ buffer: AVAudioPCMBuffer) {
        guard let converter, let outputFormat else { return }
        let ratio = outputFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 16
        guard let outBuffer = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { return }

        var consumed = false
        var conversionError: NSError?
        let status = converter.convert(to: outBuffer, error: &conversionError) { _, inputStatus in
            if consumed {
                inputStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            inputStatus.pointee = .haveData
            return buffer
        }
        guard status != .error, let channel = outBuffer.int16ChannelData, outBuffer.frameLength > 0 else { return }
        let frames = Int(outBuffer.frameLength)
        let samples = channel[0]
        let byteCount = frames * MemoryLayout<Int16>.size
        let chunk = Data(bytes: samples, count: byteCount)
        lock.lock()
        pcm.append(chunk)
        lock.unlock()

        if onLevel != nil {
            var peak: Int32 = 0
            for i in 0..<frames {
                let magnitude = abs(Int32(samples[i]))
                if magnitude > peak { peak = magnitude }
            }
            onLevel?(Float(peak) / Float(Int16.max))
        }
    }
}
