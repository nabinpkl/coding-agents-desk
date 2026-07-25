import AVFoundation
import Dispatch
import Testing

private final class VoiceTapBlockBox: @unchecked Sendable {
    let block: AVAudioNodeTapBlock

    init(_ block: @escaping AVAudioNodeTapBlock) {
        self.block = block
    }
}

struct VoiceContextProbeTests {
    /// AVFAudio owns the tap queue. Form the callback while isolated to the main
    /// actor, then invoke it on an ordinary dispatch queue just as the audio
    /// engine does. A callback that accidentally inherits `MainActor` traps
    /// here before it can append the buffer.
    @Test @MainActor
    func tapCallbackCanRunOutsideMainActor() async {
        guard #available(iOS 26.0, *) else { return }
        let format = AVAudioFormat(
            standardFormatWithSampleRate: 48_000,
            channels: 1
        )!
        let sink = CaptureSink(outputFormat: format)
        let callback = VoiceTapBlockBox(VoiceAudioCallbacks.tap(for: sink))

        await withCheckedContinuation { continuation in
            DispatchQueue(label: "voice-probe-test.audio-tap").async {
                let callbackFormat = AVAudioFormat(
                    standardFormatWithSampleRate: 48_000,
                    channels: 1
                )!
                let buffer = AVAudioPCMBuffer(
                    pcmFormat: callbackFormat,
                    frameCapacity: 256
                )!
                buffer.frameLength = 256
                callback.block(
                    buffer,
                    AVAudioTime(sampleTime: 0, atRate: callbackFormat.sampleRate)
                )
                continuation.resume()
            }
        }

        #expect(sink.snapshot().count == 1)
    }

    @Test
    func audioLevelMapsSilenceAndSpeechAmplitude() {
        guard #available(iOS 26.0, *) else { return }
        #expect(VoiceAudioLevel.normalized(decibels: -.infinity) == 0)
        #expect(VoiceAudioLevel.normalized(decibels: -50) == 0)
        #expect(VoiceAudioLevel.normalized(decibels: -18) == 1)
        #expect(VoiceAudioLevel.normalized(decibels: 6) == 1)

        let roomTone = VoiceAudioLevel.normalized(decibels: -42)
        let ordinarySpeech = VoiceAudioLevel.normalized(decibels: -24)
        #expect(roomTone < 0.2)
        #expect(ordinarySpeech > 0.7)
        #expect(ordinarySpeech > roomTone * 4)

        let format = AVAudioFormat(
            standardFormatWithSampleRate: 48_000,
            channels: 1
        )!
        let buffer = AVAudioPCMBuffer(
            pcmFormat: format,
            frameCapacity: 256
        )!
        buffer.frameLength = 256
        for frame in 0..<Int(buffer.frameLength) {
            buffer.floatChannelData![0][frame] = 0.5
        }

        let level = VoiceAudioLevel.normalized(buffer: buffer)
        #expect(level == 1)

        let sink = CaptureSink(outputFormat: format)
        sink.accept(buffer)
        #expect(sink.currentLevel == level)
    }
}
