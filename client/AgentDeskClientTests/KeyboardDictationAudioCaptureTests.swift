import AVFoundation
import Dispatch
import Foundation
import Testing

private final class KeyboardTapBlockBox: @unchecked Sendable {
    let block: AVAudioNodeTapBlock

    init(_ block: @escaping AVAudioNodeTapBlock) {
        self.block = block
    }
}

private final class KeyboardAudioFrameCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    func increment() {
        lock.withLock {
            count += 1
        }
    }

    var value: Int {
        lock.withLock { count }
    }
}

struct KeyboardDictationAudioCaptureTests {
    /// The capture owner is main-actor isolated while AVFAudio invokes its tap
    /// on a real-time queue. Forming the callback on MainActor must not make
    /// the callback itself main-actor isolated.
    @Test @MainActor
    func tapCallbackCanRunOutsideMainActor() async {
        let format = AVAudioFormat(
            standardFormatWithSampleRate: 16_000,
            channels: 1
        )!
        let counter = KeyboardAudioFrameCounter()
        let sink = KeyboardDictationCaptureSink(
            outputFormat: format,
            frameHandler: { _ in counter.increment() },
            meterHandler: { _, _ in },
            failureHandler: { _, _ in }
        )
        sink.begin(captureSessionID: UUID())
        let callback = KeyboardTapBlockBox(
            KeyboardDictationAudioCallbacks.tap(for: sink)
        )

        await withCheckedContinuation { continuation in
            DispatchQueue(
                label: "keyboard-dictation-test.audio-tap"
            ).async {
                let callbackFormat = AVAudioFormat(
                    standardFormatWithSampleRate: 16_000,
                    channels: 1
                )!
                let buffer = AVAudioPCMBuffer(
                    pcmFormat: callbackFormat,
                    frameCapacity: 2_048
                )!
                buffer.frameLength = 2_048
                callback.block(
                    buffer,
                    AVAudioTime(
                        sampleTime: 0,
                        atRate: callbackFormat.sampleRate
                    )
                )
                continuation.resume()
            }
        }

        #expect(counter.value == 1)
    }
}
