import AVFoundation
import Foundation
import Testing

struct VoiceAttemptStoreTests {
    @Test @MainActor
    func savesLosslessAudioAndFinalRecognitionMetadata() throws {
        guard #available(iOS 26.0, *) else { return }
        let root = temporaryRoot(name: "round-trip")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = VoiceAttemptStore(rootDirectory: root)
        let capture = makeCapture()

        let pending = try store.save(
            capture: capture,
            targetPhrase: "think",
            locale: Locale(identifier: "en-US"),
            build: VoiceBuildIdentity(
                bundleIdentifier: "voice.tests",
                marketingVersion: "1.2.3",
                buildNumber: "456",
                gitSHA: "abc1234"
            )
        )

        #expect(pending.analysis == nil)
        #expect(pending.durationSeconds == 512.0 / 16_000.0)
        #expect(pending.frameCount == 512)
        #expect(pending.analyzerFormat.codec == "linearPCM")
        #expect(pending.analyzerFormat.container == "caf")
        #expect(pending.build.gitSHA == "abc1234")

        let audioFile = try AVAudioFile(forReading: store.audioURL(for: pending))
        #expect(audioFile.length == 512)
        #expect(audioFile.fileFormat.settings[AVFormatIDKey] as? UInt32 == kAudioFormatLinearPCM)

        let withoutContext = reading(
            "thank",
            confidence: 0.61,
            alternatives: [("think", 0.42)]
        )
        let withContext = reading("think", confidence: 0.88)
        let completed = try store.finishAnalysis(
            attemptID: pending.id,
            withoutContext: withoutContext,
            withContext: withContext
        )

        #expect(completed.analysis?.withoutContext == withoutContext)
        #expect(completed.analysis?.withContext == withContext)
        #expect(completed.analysis?.withoutContextTargetMatch == .alternative)
        #expect(completed.analysis?.withContextTargetMatch == .topResult)
        #expect(completed.analysis?.verdict == .clear)

        let listed = try store.attempts()
        #expect(listed == [completed])

        try store.delete(attemptID: pending.id)
        #expect(try store.attempts().isEmpty)
    }

    @Test @MainActor
    func retainsAudioWhenAnalysisFailsAndDeleteAllRemovesIt() throws {
        guard #available(iOS 26.0, *) else { return }
        let root = temporaryRoot(name: "analysis-failure")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = VoiceAttemptStore(rootDirectory: root)
        let pending = try store.save(
            capture: makeCapture(),
            targetPhrase: "ship",
            locale: Locale(identifier: "en-US")
        )

        let failed = try store.recordAnalysisFailure(
            attemptID: pending.id,
            message: "analyzer stopped"
        )

        #expect(failed.analysis == nil)
        #expect(failed.analysisFailure == "analyzer stopped")
        #expect(FileManager.default.fileExists(atPath: try store.audioURL(for: failed).path))

        try store.deleteAll()
        #expect(try store.attempts().isEmpty)
    }

    @MainActor
    private func makeCapture() -> VoiceCapturedTake {
        let format = AVAudioFormat(
            standardFormatWithSampleRate: 16_000,
            channels: 1
        )!
        let buffers = (0..<2).map { bufferIndex in
            let buffer = AVAudioPCMBuffer(
                pcmFormat: format,
                frameCapacity: 256
            )!
            buffer.frameLength = 256
            for frame in 0..<Int(buffer.frameLength) {
                buffer.floatChannelData![0][frame] = Float(bufferIndex * 256 + frame) / 512
            }
            return buffer
        }
        return VoiceCapturedTake(
            startedAt: Date(timeIntervalSince1970: 1_700_000_000),
            format: format,
            buffers: buffers
        )
    }

    private func reading(
        _ top: String,
        confidence: Double?,
        alternatives: [(String, Double?)] = []
    ) -> VoiceReading {
        VoiceReading(
            top: VoiceRecognitionCandidate(text: top, confidence: confidence),
            alternatives: alternatives.map {
                VoiceRecognitionCandidate(text: $0.0, confidence: $0.1)
            }
        )
    }

    private func temporaryRoot(name: String) -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent(
            "voice-attempt-store-\(name)-\(UUID().uuidString)",
            isDirectory: true
        )
    }
}
