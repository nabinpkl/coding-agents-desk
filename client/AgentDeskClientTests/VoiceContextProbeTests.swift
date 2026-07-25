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
}
