import Foundation
import Testing

struct VoiceContextMatrixTests {
    @Test func collectsTwoSavedTakesForEveryPromptBeforeDeciding() {
        let attempts = VoiceContextMatrix.minimalPairs
            .flatMap(\.prompts)
            .map { attempt(target: $0, without: .absent, with: .topResult) }

        let report = VoiceContextMatrix.evaluate(attempts)

        #expect(report.recommendation == .collectMore)
        #expect(report.completedTakes == 8)
        #expect(report.requiredTakes == 16)
    }

    @Test func keepsContextPassOnlyForRepeatedCrossPairPromotions() {
        var attempts: [VoiceSavedAttempt] = []
        for pair in VoiceContextMatrix.minimalPairs {
            for target in pair.prompts {
                for _ in 0..<VoiceContextMatrix.requiredTakesPerPrompt {
                    let promoted = target == "think" || target == "rice"
                    attempts.append(
                        attempt(
                            target: target,
                            without: promoted ? .absent : .topResult,
                            with: .topResult
                        )
                    )
                }
            }
        }

        let report = VoiceContextMatrix.evaluate(attempts)

        #expect(report.recommendation == .keepContextPass)
        #expect(report.topResultPromotions == 4)
        #expect(report.improvedPairCount == 2)
        #expect(report.regressions == 0)
    }

    @Test func removesContextPassAfterFullCoverageWithoutUsefulChanges() {
        let attempts = VoiceContextMatrix.minimalPairs.flatMap { pair in
            pair.prompts.flatMap { target in
                (0..<VoiceContextMatrix.requiredTakesPerPrompt).map { _ in
                    attempt(target: target, without: .topResult, with: .topResult)
                }
            }
        }

        let report = VoiceContextMatrix.evaluate(attempts)

        #expect(report.recommendation == .removeContextPass)
        #expect(report.topResultPromotions == 0)
        #expect(report.regressions == 0)
    }

    private func attempt(
        target: String,
        without: VoiceTargetMatch,
        with: VoiceTargetMatch
    ) -> VoiceSavedAttempt {
        let top = VoiceReading(
            top: VoiceRecognitionCandidate(text: target, confidence: 0.8),
            alternatives: []
        )
        let analysis = VoiceAttemptAnalysis(
            withoutContext: top,
            withContext: top,
            withoutContextTargetMatch: without,
            withContextTargetMatch: with,
            verdict: .clear
        )
        return VoiceSavedAttempt(
            schemaVersion: VoiceSavedAttempt.currentSchemaVersion,
            id: UUID(),
            createdAt: Date(),
            targetPhrase: target,
            localeIdentifier: "en-US",
            durationSeconds: 1,
            frameCount: 16_000,
            audioFileName: VoiceSavedAttempt.audioFileName,
            analyzerFormat: VoiceAnalyzerFormatMetadata(
                sampleRate: 16_000,
                channelCount: 1,
                commonFormat: "pcmFloat32",
                isInterleaved: false,
                container: "caf",
                codec: "linearPCM"
            ),
            build: VoiceBuildIdentity(
                bundleIdentifier: "voice.tests",
                marketingVersion: "1",
                buildNumber: "1",
                gitSHA: "test"
            ),
            analysis: analysis,
            analysisFailure: nil
        )
    }
}
