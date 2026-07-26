import AVFoundation

enum VoiceAudioFileReader {
    enum ReadError: LocalizedError {
        case recordingTooLarge
        case unsupportedPCMFormat
        case incompleteRead(expected: Int64, actual: Int64)

        var errorDescription: String? {
            switch self {
            case .recordingTooLarge:
                return "The saved recording is too large to read."
            case .unsupportedPCMFormat:
                return "The saved recording could not be decoded as Float32 PCM."
            case .incompleteRead(let expected, let actual):
                return "The saved recording ended at \(actual) of \(expected) frames."
            }
        }
    }

    static func readAll(from file: AVAudioFile) throws -> AVAudioPCMBuffer {
        guard file.length > 0,
              file.length <= Int64(UInt32.max)
        else {
            throw ReadError.recordingTooLarge
        }
        guard let output = AVAudioPCMBuffer(
            pcmFormat: file.processingFormat,
            frameCapacity: AVAudioFrameCount(file.length)
        ) else {
            throw ReadError.recordingTooLarge
        }
        guard let outputChannels = output.floatChannelData else {
            throw ReadError.unsupportedPCMFormat
        }
        let channelCount = Int(file.processingFormat.channelCount)
        var frameOffset = 0
        while frameOffset < Int(file.length) {
            let requested = min(8_192, Int(file.length) - frameOffset)
            guard let chunk = AVAudioPCMBuffer(
                pcmFormat: file.processingFormat,
                frameCapacity: AVAudioFrameCount(requested)
            ) else {
                throw ReadError.recordingTooLarge
            }
            try file.read(
                into: chunk,
                frameCount: AVAudioFrameCount(requested)
            )
            guard chunk.frameLength > 0 else { break }
            guard let chunkChannels = chunk.floatChannelData else {
                throw ReadError.unsupportedPCMFormat
            }
            let copiedFrames = Int(chunk.frameLength)
            for channel in 0..<channelCount {
                outputChannels[channel]
                    .advanced(by: frameOffset)
                    .update(
                        from: chunkChannels[channel],
                        count: copiedFrames
                    )
            }
            frameOffset += copiedFrames
            output.frameLength = AVAudioFrameCount(frameOffset)
        }
        guard frameOffset == Int(file.length) else {
            throw ReadError.incompleteRead(
                expected: file.length,
                actual: Int64(frameOffset)
            )
        }
        return output
    }
}

// Resamples microphone buffers into the format `SpeechAnalyzer` negotiated.
//
// This follows Apple's SpeechAnalyzer sample `BufferConverter` rather than a
// hand-rolled conversion, because the failure mode of getting it wrong is
// silent: the input node runs at the hardware rate (typically 48 kHz) while the
// analyzer wants its own, and feeding unconverted buffers builds and runs fine
// while producing zero transcription.
//
// `primeMethod = .none` is load-bearing for live capture. The default priming
// pushes the converter's latency into the output as leading silence and drifts
// the timestamps away from the source, which matters here because two passes
// over the same recording are compared against each other.
final class VoiceBufferConverter {
    private final class InputState: @unchecked Sendable {
        let buffer: AVAudioPCMBuffer
        var consumed = false

        init(buffer: AVAudioPCMBuffer) {
            self.buffer = buffer
        }
    }

    enum ConversionError: Error {
        case converterUnavailable
        case bufferAllocationFailed
        case conversionFailed(NSError?)
    }

    private var converter: AVAudioConverter?

    func convert(
        _ buffer: AVAudioPCMBuffer,
        to format: AVAudioFormat
    ) throws -> AVAudioPCMBuffer {
        let inputFormat = buffer.format
        guard inputFormat != format else { return buffer }

        if converter == nil || converter?.outputFormat != format
            || converter?.inputFormat != inputFormat {
            converter = AVAudioConverter(from: inputFormat, to: format)
            converter?.primeMethod = .none
        }
        guard let converter else { throw ConversionError.converterUnavailable }

        let ratio = converter.outputFormat.sampleRate / converter.inputFormat.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up))
        guard capacity > 0,
              let output = AVAudioPCMBuffer(
                pcmFormat: converter.outputFormat,
                frameCapacity: capacity
              ) else {
            throw ConversionError.bufferAllocationFailed
        }

        // The input block hands the source buffer over exactly once and then
        // reports "no data" so the converter drains rather than asking again.
        // Apple's sample tracks that with a captured `var`, which Swift 6 rejects
        // in a `@Sendable` closure. The box is `@unchecked Sendable` because
        // `convert` invokes the block synchronously on the calling thread, so
        // there is no concurrent access to guard against.
        let state = InputState(buffer: buffer)
        var nsError: NSError?
        let status = converter.convert(to: output, error: &nsError) { _, inputStatus in
            inputStatus.pointee = state.consumed ? .noDataNow : .haveData
            defer { state.consumed = true }
            return state.consumed ? nil : state.buffer
        }

        // Status is the authoritative signal; `error` can be nil on a failed
        // conversion, so checking only the error would let a bad buffer through.
        guard status != .error else { throw ConversionError.conversionFailed(nsError) }
        return output
    }
}
