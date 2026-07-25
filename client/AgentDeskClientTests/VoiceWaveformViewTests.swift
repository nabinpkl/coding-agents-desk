import Testing
import UIKit

@MainActor
struct VoiceWaveformViewTests {
    @Test func keepsABoundedRollingWindowAndClampsSamples() {
        let waveform = VoiceWaveformView()

        for index in 0..<(VoiceWaveformView.sampleCapacity + 3) {
            waveform.append(level: Float(index) / 100)
        }

        #expect(waveform.levels.count == VoiceWaveformView.sampleCapacity)
        #expect(abs(waveform.levels[0] - 0.03) < 0.0001)
        #expect(
            abs(
                waveform.levels[VoiceWaveformView.sampleCapacity - 1] - 0.50
            ) < 0.0001
        )

        waveform.append(level: 2)
        #expect(waveform.levels.last == 1)
        waveform.append(level: -.infinity)
        #expect(waveform.levels.last == 0)
    }

    @Test func barGeometryIsCenteredAndTracksAmplitude() {
        let bounds = CGRect(x: 8, y: 8, width: 320, height: 64)
        let frames = VoiceWaveformView.barFrames(
            levels: [0, 0.5, 1],
            in: bounds
        )

        #expect(frames.count == 3)
        #expect(frames.allSatisfy { abs($0.midY - bounds.midY) < 0.0001 })
        #expect(frames[0].height < frames[1].height)
        #expect(frames[1].height < frames[2].height)
        #expect(abs(frames[2].height - bounds.height) < 0.0001)
        #expect(frames.allSatisfy { bounds.contains($0) })
        #expect(VoiceWaveformView.preferredHeight == 112)
        #expect(VoiceWaveformView().intrinsicContentSize.height == 112)

        let narrowBounds = CGRect(x: 0, y: 0, width: 12, height: 20)
        let narrowFrames = VoiceWaveformView.barFrames(
            levels: Array(repeating: 0.5, count: VoiceWaveformView.sampleCapacity),
            in: narrowBounds
        )
        #expect(narrowFrames.allSatisfy { narrowBounds.contains($0) })
    }

    @Test func resetClearsTheGraphAndAccessibleLevel() {
        let waveform = VoiceWaveformView()
        waveform.append(level: 0.75)

        waveform.reset()

        #expect(waveform.levels.allSatisfy { $0 == 0 })
        #expect(waveform.accessibilityValue == "0 percent")
        #expect(waveform.accessibilityTraits.contains(.updatesFrequently))
    }
}
