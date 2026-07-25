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

        let audioSHA256 = try store.audioSHA256(for: completed)
        let evidence = phoneEvidence(
            attemptID: completed.id,
            audioSHA256: audioSHA256
        )
        let storedPhoneAnalysis = try store.savePhoneEvidence(evidence)
        #expect(storedPhoneAnalysis.evidence == evidence)
        #expect(try store.phoneAnalysis(for: completed) == storedPhoneAnalysis)

        let replacement = phoneEvidence(
            attemptID: completed.id,
            audioSHA256: audioSHA256,
            createdAt: Date(timeIntervalSince1970: 1_700_000_002),
            inferenceMilliseconds: 7
        )
        let replacedPhoneAnalysis = try store.savePhoneEvidence(replacement)
        #expect(replacedPhoneAnalysis.evidence == replacement)
        #expect(try store.phoneAnalysis(for: completed) == replacedPhoneAnalysis)
        #expect(
            FileManager.default.fileExists(
                atPath: root
                    .appendingPathComponent(completed.id.uuidString)
                    .appendingPathComponent("phone-evidence.json")
                    .path
            )
        )

        try store.delete(attemptID: pending.id)
        #expect(try store.attempts().isEmpty)
    }

    @Test @MainActor
    func phoneFailureRoundTripsAndStaleAudioEvidenceIsRejected() throws {
        guard #available(iOS 26.0, *) else { return }
        let root = temporaryRoot(name: "phone-failure")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = VoiceAttemptStore(rootDirectory: root)
        let attempt = try store.save(
            capture: makeCapture(),
            targetPhrase: "think",
            locale: Locale(identifier: "en-US")
        )

        let failed = try store.recordPhoneAnalysisFailure(
            attemptID: attempt.id,
            message: "model asset missing",
            modelWeightSHA256: nil
        )
        #expect(failed.failure == "model asset missing")
        let reloadedFailure = try store.phoneAnalysis(for: attempt)
        #expect(reloadedFailure?.attemptID == failed.attemptID)
        #expect(reloadedFailure?.audioSHA256 == failed.audioSHA256)
        #expect(reloadedFailure?.modelWeightSHA256 == nil)
        #expect(reloadedFailure?.failure == failed.failure)
        #expect(reloadedFailure?.evidence == nil)

        let stale = phoneEvidence(
            attemptID: attempt.id,
            audioSHA256: "stale-audio"
        )
        #expect(throws: VoiceAttemptStore.StoreError.self) {
            try store.savePhoneEvidence(stale)
        }
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

    private func phoneEvidence(
        attemptID: UUID,
        audioSHA256: String,
        createdAt: Date = Date(timeIntervalSince1970: 1_700_000_001),
        inferenceMilliseconds: Double = 3
    ) -> VoicePhoneEvidence {
        let model = VoicePhoneModelManifest(
            schemaVersion: 1,
            identifier: "test",
            upstreamModel: "test",
            upstreamLicense: "Apache-2.0",
            conversionRepository: "test",
            conversionRevision: "test",
            conversionID: "test",
            sourceWeightSHA256: "source",
            modelWeightSHA256: VoicePhoneModelManifest.selectedWeightSHA256,
            modelSpecificationSHA256:
                VoicePhoneModelManifest.selectedSpecificationSHA256,
            vocabularySHA256: "vocab",
            modelBytes: 1,
            minimumIOSVersion: 26,
            sampleRate: 16_000,
            sampleCount: 64_000,
            frameCount: 199,
            vocabularySize: 392,
            blankTokenID: 0
        )
        let pronunciation = VoiceTargetPronunciation(
            word: "think",
            source: "CMUdict",
            sourceRevision: VoicePronunciationLexicon.sourceRevision,
            arpabet: ["TH", "IH1", "NG", "K"],
            phones: ["θ", "ɪ", "ŋ", "k"]
        )
        return VoicePhoneEvidence(
            schemaVersion: 1,
            attemptID: attemptID,
            createdAt: createdAt,
            audioSHA256: audioSHA256,
            localeIdentifier: "en-US",
            model: model,
            pronunciation: pronunciation,
            frames: [],
            alignedPhones: [],
            metrics: VoicePhoneInferenceMetrics(
                sourceDurationSeconds: 0.032,
                analyzedOffsetSeconds: 0,
                analyzedDurationSeconds: 0.032,
                preprocessingMilliseconds: 1,
                modelLoadMilliseconds: 2,
                inferenceMilliseconds: inferenceMilliseconds,
                observedResidentMemoryDeltaBytes: nil
            )
        )
    }
}
