import AVFoundation
import Foundation
import Testing

private final class VoicePronunciationScoringTestBundleMarker: NSObject {}

enum VoicePronunciationScoringFixtures {
    static func features(
        alignedLogitMargin: Double = 0.8,
        substitutionMargin: Double = 0.6,
        substitutionDeletionMargin: Double = 0.4,
        blankFrameRatio: Double = 0.2,
        effectiveNonBlankFrameCount: Int = 4
    ) -> VoicePhoneScoreFeatures {
        VoicePhoneScoreFeatures(
            featureVersion: VoicePhoneScoreFeatures.currentVersion,
            alignedTargetMeanLogit: 1.5,
            alignedStrongestCompetitorMeanLogit:
                1.5 - alignedLogitMargin,
            alignedLogitMargin: alignedLogitMargin,
            canonicalSequenceLogProbability: -2,
            substitutionSequenceLogSumProbability:
                -2 - substitutionMargin,
            deletionSequenceLogProbability: -3,
            alignmentFreeSubstitutionMargin: substitutionMargin,
            alignmentFreeSubstitutionDeletionMargin:
                substitutionDeletionMargin,
            blankFrameRatio: blankFrameRatio,
            effectiveNonBlankFrameCount: effectiveNonBlankFrameCount
        )
    }

    static func alignedEvidence(
        targetPhone: String = "θ",
        posteriorMargin: Double = 1,
        features: VoicePhoneScoreFeatures = features()
    ) -> VoiceAlignedPhoneEvidence {
        VoiceAlignedPhoneEvidence(
            targetPhone: targetPhone,
            startSeconds: 0,
            endSeconds: 0.02,
            targetLogPosterior: -0.2,
            observedPhone: VoicePhoneHypothesis(
                tokenID: 52,
                phone: targetPhone,
                logPosterior: -0.2
            ),
            competingPhones: [
                VoicePhoneHypothesis(
                    tokenID: 6,
                    phone: "t",
                    logPosterior: -1.2
                )
            ],
            posteriorMargin: posteriorMargin,
            scoreFeatures: features
        )
    }

    static func evidence(
        localeIdentifier: String = "en-US",
        sourceDurationSeconds: Double = 1,
        clippedSampleRatio: Double = 0,
        alignedPhone: VoiceAlignedPhoneEvidence = alignedEvidence()
    ) -> VoicePhoneEvidence {
        let model = VoicePhoneModelManifest(
            schemaVersion: 1,
            identifier: "test-model",
            upstreamModel: "upstream",
            upstreamLicense: "Apache-2.0",
            conversionRepository: "conversion",
            conversionRevision: "revision",
            conversionID: "conversion-id",
            sourceWeightSHA256: "source",
            modelWeightSHA256: VoicePhoneModelManifest.selectedWeightSHA256,
            vocabularySHA256: "vocab",
            modelBytes: 100,
            minimumIOSVersion: 26,
            sampleRate: 16_000,
            sampleCount: 64_000,
            frameCount: 199,
            vocabularySize: 392,
            blankTokenID: 0
        )
        return VoicePhoneEvidence(
            schemaVersion: VoicePhoneEvidence.currentSchemaVersion,
            attemptID: UUID(uuidString: "A21A2636-6C84-4F68-A4EF-10A8EDB17135")!,
            createdAt: Date(timeIntervalSince1970: 1_700_000_000),
            audioSHA256: "audio",
            localeIdentifier: localeIdentifier,
            model: model,
            pronunciation: VoiceTargetPronunciation(
                word: "think",
                source: "CMUdict",
                sourceRevision: VoicePronunciationLexicon.sourceRevision,
                arpabet: ["TH"],
                phones: [alignedPhone.targetPhone]
            ),
            frames: [],
            alignedPhones: [alignedPhone],
            metrics: VoicePhoneInferenceMetrics(
                sourceDurationSeconds: sourceDurationSeconds,
                analyzedOffsetSeconds: 0,
                analyzedDurationSeconds: min(sourceDurationSeconds, 4),
                preprocessingMilliseconds: 1,
                modelLoadMilliseconds: 2,
                inferenceMilliseconds: 3,
                observedResidentMemoryDeltaBytes: nil,
                peakAbsoluteSample: clippedSampleRatio > 0 ? 1 : 0.5,
                clippedSampleRatio: clippedSampleRatio
            )
        )
    }

    static func calibration(
        displayEnabled: Bool = true,
        selectedCandidate: VoicePronunciationScoreCandidate =
            .alignedPosteriorMargin,
        supportedPhones: [String] =
            VoiceARPABETPhoneMapping.productPhones.sorted(),
        validationPearson: Double = 0.6
    ) -> VoicePhoneCalibrationManifest {
        VoicePhoneCalibrationManifest(
            schemaVersion: VoicePhoneCalibrationManifest.currentSchemaVersion,
            identifier: displayEnabled ? "test-calibration" : "unvalidated",
            generatedAt: "2026-07-26T00:00:00Z",
            displayEnabled: displayEnabled,
            disabledReason: displayEnabled
                ? nil
                : "The calibration has not passed its release gates.",
            sourceCorpus: "SpeechOcean762",
            sourceRevision: "test-revision",
            sourceSHA256: "corpus",
            sourceLicense: "CC BY 4.0",
            sourcePopulation: "Mandarin-L1 test population",
            localeIdentifiers: ["en-US"],
            featureVersion: VoicePhoneScoreFeatures.currentVersion,
            selectedCandidate: selectedCandidate,
            modelWeightSHA256: VoicePhoneModelManifest.selectedWeightSHA256,
            vocabularySHA256: "vocab",
            minimumEffectiveNonBlankFrameCount: 2,
            maximumBlankFrameRatio: 0.95,
            maximumClippedSampleRatio: 0.01,
            maximumSourceDurationSeconds: 4,
            needsAttentionUpperBound: 1,
            closeUpperBound: 1.5,
            mappings: displayEnabled
                ? [
                    VoicePhoneCalibrationMapping(
                        phone: nil,
                        knots: [
                            VoicePhoneCalibrationKnot(
                                margin: -1,
                                expectedGrade: 0
                            ),
                            VoicePhoneCalibrationKnot(
                                margin: 0,
                                expectedGrade: 1
                            ),
                            VoicePhoneCalibrationKnot(
                                margin: 1,
                                expectedGrade: 2
                            )
                        ]
                    )
                ]
                : [],
            supportedPhones: displayEnabled
                ? supportedPhones.map {
                    VoicePhoneCalibrationSupport(
                        phone: $0,
                        trainingCount: 120,
                        testCount: 30,
                        lowGradeTrainingCount: 20,
                        highGradeTrainingCount: 30,
                        lowGradeTestCount: 10,
                        highGradeTestCount: 10,
                        testPearsonCorrelation: 0.6,
                        testMeanAbsoluteError: 0.25
                    )
                }
                : [],
            validation: displayEnabled
                ? VoicePhoneCalibrationValidation(
                    testPearsonCorrelation: validationPearson,
                    testSpearmanCorrelation: 0.6,
                    testMeanAbsoluteError: 0.25,
                    testAUROC: 0.85,
                    testCalibrationError: 0.08,
                    speakerBootstrapPearsonLowerBound: 0.5,
                    l2ArcticOverallAUROC: 0.72,
                    l2ArcticWorstL1AUROC: 0.6,
                    l2ArcticWorstRecallGap: 0.15
                )
                : nil
        )
    }
}

struct VoiceCTCSequenceProbabilityTests {
    private struct ParityFixture: Decodable {
        struct CTC: Decodable {
            let logPosteriors: [[Double]]
            let targetTokenIDs: [Int]
            let targetIndex: Int
            let assessmentTokenIDs: [Int]
            let blankTokenID: Int
            let expectedCanonicalLogProbability: Double
            let expectedSubstitutionLogSumProbability: Double
            let expectedDeletionLogProbability: Double
            let expectedAlignedPosteriorMargin: Double
            let expectedAlignedLogitMargin: Double
            let expectedBlankFrameRatio: Double
            let expectedEffectiveNonBlankFrameCount: Int
        }

        struct AudioNormalization: Decodable {
            let pcm16: [Int16]
            let expectedFloat32: [Float]
        }

        struct Calibration: Decodable {
            let knots: [VoicePhoneCalibrationKnot]
            let margin: Double
            let expectedGrade: Double
        }

        let schemaVersion: Int
        let ctc: CTC
        let audioNormalization: AudioNormalization
        let calibration: Calibration
    }

    @Test
    func forwardSumIncludesEveryValidCTCPath() throws {
        let logPosteriors = [
            [Foundation.log(0.5), Foundation.log(0.5)],
            [Foundation.log(0.5), Foundation.log(0.5)]
        ]

        let target = try VoiceCTCAlignment.sequenceLogProbability(
            logPosteriors: logPosteriors,
            tokenIDs: [1],
            blankTokenID: 0
        )
        let deletion = try VoiceCTCAlignment.sequenceLogProbability(
            logPosteriors: logPosteriors,
            tokenIDs: [],
            blankTokenID: 0
        )

        #expect(abs(Foundation.exp(target) - 0.75) < 0.000_001)
        #expect(abs(Foundation.exp(deletion) - 0.25) < 0.000_001)
    }

    @Test
    func phoneContrastSeparatesSubstitutionAndDeletionDenominators() throws {
        let logPosteriors = [
            [Foundation.log(0.1), Foundation.log(0.6), Foundation.log(0.3)],
            [Foundation.log(0.1), Foundation.log(0.6), Foundation.log(0.3)]
        ]

        let contrast = try VoiceCTCAlignment.phoneContrastProbabilities(
            logPosteriors: logPosteriors,
            targetTokenIDs: [1],
            targetIndex: 0,
            assessmentTokenIDs: [1, 2],
            blankTokenID: 0
        )

        #expect(
            abs(
                Foundation.exp(contrast.canonicalLogProbability)
                    - 0.48
            ) < 0.000_001
        )
        #expect(
            abs(
                Foundation.exp(contrast.substitutionLogSumProbability)
                    - 0.15
            ) < 0.000_001
        )
        #expect(
            abs(Foundation.exp(contrast.deletionLogProbability) - 0.01)
                < 0.000_001
        )
    }

    @Test
    func bundledPythonSwiftParityFixtureMatchesCTCForwardSums() throws {
        let url = try #require(
            Bundle(for: VoicePronunciationScoringTestBundleMarker.self).url(
                forResource: "VoicePhoneScoringParityFixtures",
                withExtension: "json"
            )
        )
        let fixture = try JSONDecoder().decode(
            ParityFixture.self,
            from: Data(contentsOf: url)
        )
        #expect(fixture.schemaVersion == 1)
        let contrast = try VoiceCTCAlignment.phoneContrastProbabilities(
            logPosteriors: fixture.ctc.logPosteriors,
            targetTokenIDs: fixture.ctc.targetTokenIDs,
            targetIndex: fixture.ctc.targetIndex,
            assessmentTokenIDs: fixture.ctc.assessmentTokenIDs,
            blankTokenID: fixture.ctc.blankTokenID
        )

        #expect(abs(
            contrast.canonicalLogProbability
                - fixture.ctc.expectedCanonicalLogProbability
        ) < 0.000_000_001)
        #expect(abs(
            contrast.substitutionLogSumProbability
                - fixture.ctc.expectedSubstitutionLogSumProbability
        ) < 0.000_000_001)
        #expect(abs(
            contrast.deletionLogProbability
                - fixture.ctc.expectedDeletionLogProbability
        ) < 0.000_000_001)
        let averagedPosteriors = VoicePhoneAnalyzer.averagePosteriors(
            logPosteriors: fixture.ctc.logPosteriors,
            range: 0...1
        )
        let averagedLogits = VoicePhoneAnalyzer.averageLogits(
            logits: fixture.ctc.logPosteriors.map { $0.map(Float.init) },
            range: 0...1
        )
        #expect(abs(
            averagedPosteriors[1] - averagedPosteriors[2]
                - fixture.ctc.expectedAlignedPosteriorMargin
        ) < 0.000_000_001)
        #expect(abs(
            averagedLogits[1] - averagedLogits[2]
                - fixture.ctc.expectedAlignedLogitMargin
        ) < 0.000_001)
        let support = VoicePhoneAnalyzer.supportDiagnostics(
            logPosteriors: fixture.ctc.logPosteriors,
            range: 0...1,
            assessmentTokenIDs: fixture.ctc.assessmentTokenIDs,
            blankTokenID: fixture.ctc.blankTokenID
        )
        #expect(
            support.blankFrameRatio
                == fixture.ctc.expectedBlankFrameRatio
        )
        #expect(
            support.effectiveNonBlankFrameCount
                == fixture.ctc.expectedEffectiveNonBlankFrameCount
        )
        #expect(abs(
            VoicePronunciationScorer.interpolate(
                margin: fixture.calibration.margin,
                knots: fixture.calibration.knots
            ) - fixture.calibration.expectedGrade
        ) < 0.000_000_001)
    }

    @Test
    func bundledPCM16NormalizationMatchesAVAudioConverter() throws {
        let url = try #require(
            Bundle(for: VoicePronunciationScoringTestBundleMarker.self).url(
                forResource: "VoicePhoneScoringParityFixtures",
                withExtension: "json"
            )
        )
        let fixture = try JSONDecoder().decode(
            ParityFixture.self,
            from: Data(contentsOf: url)
        )
        let sourceFormat = try #require(AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: 16_000,
            channels: 1,
            interleaved: false
        ))
        let source = try #require(AVAudioPCMBuffer(
            pcmFormat: sourceFormat,
            frameCapacity: AVAudioFrameCount(
                fixture.audioNormalization.pcm16.count
            )
        ))
        source.frameLength = source.frameCapacity
        let channel = try #require(source.int16ChannelData?[0])
        for (index, value) in fixture.audioNormalization.pcm16.enumerated() {
            channel[index] = value
        }
        let targetFormat = try #require(AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: 16_000,
            channels: 1,
            interleaved: false
        ))
        let converted = try VoiceBufferConverter().convert(
            source,
            to: targetFormat
        )
        let convertedChannel = try #require(converted.floatChannelData?[0])
        let samples = (0..<Int(converted.frameLength)).map {
            convertedChannel[$0]
        }

        #expect(samples.count == fixture.audioNormalization.expectedFloat32.count)
        for (actual, expected) in zip(
            samples,
            fixture.audioNormalization.expectedFloat32
        ) {
            #expect(abs(actual - expected) < 0.000_001)
        }
    }
}

struct VoicePronunciationScorerTests {
    @Test
    func selectedCandidateIsCalibratedMonotonicallyOnNativeScale() throws {
        let evidence = VoicePronunciationScoringFixtures.evidence(
            alignedPhone: VoicePronunciationScoringFixtures.alignedEvidence(
                posteriorMargin: 0.5
            )
        )
        let calibration = VoicePronunciationScoringFixtures.calibration()

        let assessment = try VoicePronunciationScorer.score(
            evidence: evidence,
            calibration: calibration,
            now: Date(timeIntervalSince1970: 1_700_000_100)
        )

        #expect(assessment.isWellFormed)
        #expect(assessment.isCurrent(for: evidence, calibration: calibration))
        #expect(assessment.phones[0].supportStatus == .supported)
        #expect(assessment.phones[0].expectedExpertGrade == 1.5)
        #expect(assessment.phones[0].band == .clear)
        #expect(assessment.phones[0].candidateMargins.alignedLogitMargin == 0.8)
    }

    @Test
    func disabledCalibrationAndUnsupportedEvidenceAbstainWithoutLosingMargins()
        throws
    {
        let evidence = VoicePronunciationScoringFixtures.evidence()
        let disabled = VoicePronunciationScoringFixtures.calibration(
            displayEnabled: false
        )
        let disabledAssessment = try VoicePronunciationScorer.score(
            evidence: evidence,
            calibration: disabled
        )
        #expect(
            disabledAssessment.phones[0].supportStatus
                == .calibrationUnavailable
        )
        #expect(disabledAssessment.phones[0].expectedExpertGrade == nil)
        #expect(
            disabledAssessment.phones[0].candidateMargins
                .alignedPosteriorMargin == 1
        )

        let unsupportedEvidence = VoicePronunciationScoringFixtures.evidence(
            alignedPhone: VoicePronunciationScoringFixtures.alignedEvidence(
                targetPhone: "z"
            )
        )
        let unsupportedAssessment = try VoicePronunciationScorer.score(
            evidence: unsupportedEvidence,
            calibration: VoicePronunciationScoringFixtures.calibration()
        )
        #expect(
            unsupportedAssessment.phones[0].supportStatus
                == .unsupportedPhone
        )
    }

    @Test
    func lowSupportClippingDurationAndLocaleEachAbstain() throws {
        let calibration = VoicePronunciationScoringFixtures.calibration()
        let lowSupport = try VoicePronunciationScorer.score(
            evidence: VoicePronunciationScoringFixtures.evidence(
                alignedPhone: VoicePronunciationScoringFixtures.alignedEvidence(
                    features: VoicePronunciationScoringFixtures.features(
                        effectiveNonBlankFrameCount: 1
                    )
                )
            ),
            calibration: calibration
        )
        #expect(lowSupport.phones[0].supportStatus == .insufficientEvidence)

        let clipped = try VoicePronunciationScorer.score(
            evidence: VoicePronunciationScoringFixtures.evidence(
                clippedSampleRatio: 0.02
            ),
            calibration: calibration
        )
        #expect(clipped.phones[0].supportStatus == .clippedAudio)

        let long = try VoicePronunciationScorer.score(
            evidence: VoicePronunciationScoringFixtures.evidence(
                sourceDurationSeconds: 4.1
            ),
            calibration: calibration
        )
        #expect(long.phones[0].supportStatus == .outOfDomainDuration)

        let locale = try VoicePronunciationScorer.score(
            evidence: VoicePronunciationScoringFixtures.evidence(
                localeIdentifier: "en-GB"
            ),
            calibration: calibration
        )
        #expect(locale.phones[0].supportStatus == .unsupportedLocale)
    }

    @Test
    func evidenceOrCalibrationChangeInvalidatesRetainedAssessment() throws {
        let evidence = VoicePronunciationScoringFixtures.evidence()
        let calibration = VoicePronunciationScoringFixtures.calibration()
        let assessment = try VoicePronunciationScorer.score(
            evidence: evidence,
            calibration: calibration
        )
        let changedEvidence = VoicePronunciationScoringFixtures.evidence(
            alignedPhone: VoicePronunciationScoringFixtures.alignedEvidence(
                posteriorMargin: 0.9
            )
        )
        let changedCalibration = VoicePronunciationScoringFixtures.calibration(
            selectedCandidate: .alignedLogitMargin
        )

        #expect(!assessment.isCurrent(
            for: changedEvidence,
            calibration: calibration
        ))
        #expect(!assessment.isCurrent(
            for: evidence,
            calibration: changedCalibration
        ))
    }

    @Test
    func manifestRejectsNonMonotonicCalibration() {
        let valid = VoicePronunciationScoringFixtures.calibration()
        let invalid = VoicePhoneCalibrationManifest(
            schemaVersion: valid.schemaVersion,
            identifier: valid.identifier,
            generatedAt: valid.generatedAt,
            displayEnabled: valid.displayEnabled,
            disabledReason: valid.disabledReason,
            sourceCorpus: valid.sourceCorpus,
            sourceRevision: valid.sourceRevision,
            sourceSHA256: valid.sourceSHA256,
            sourceLicense: valid.sourceLicense,
            sourcePopulation: valid.sourcePopulation,
            localeIdentifiers: valid.localeIdentifiers,
            featureVersion: valid.featureVersion,
            selectedCandidate: valid.selectedCandidate,
            modelWeightSHA256: valid.modelWeightSHA256,
            vocabularySHA256: valid.vocabularySHA256,
            minimumEffectiveNonBlankFrameCount:
                valid.minimumEffectiveNonBlankFrameCount,
            maximumBlankFrameRatio: valid.maximumBlankFrameRatio,
            maximumClippedSampleRatio: valid.maximumClippedSampleRatio,
            maximumSourceDurationSeconds: valid.maximumSourceDurationSeconds,
            needsAttentionUpperBound: valid.needsAttentionUpperBound,
            closeUpperBound: valid.closeUpperBound,
            mappings: [
                VoicePhoneCalibrationMapping(
                    phone: nil,
                    knots: [
                        VoicePhoneCalibrationKnot(
                            margin: -1,
                            expectedGrade: 1
                        ),
                        VoicePhoneCalibrationKnot(
                            margin: 1,
                            expectedGrade: 0
                        )
                    ]
                )
            ],
            supportedPhones: valid.supportedPhones,
            validation: valid.validation
        )

        #expect(throws: VoicePronunciationScoringError.self) {
            try VoicePronunciationScorer.validate(invalid)
        }
    }

    @Test
    func manifestRejectsEnabledCalibrationBelowReleaseGates() {
        let invalid = VoicePronunciationScoringFixtures.calibration(
            validationPearson: 0.49
        )

        #expect(throws: VoicePronunciationScoringError.self) {
            try VoicePronunciationScorer.validate(invalid)
        }
    }

    @Test
    func bundledManifestLoadsAsExplicitlyDisabledCalibration() throws {
        let manifest = try VoicePhoneCalibrationAssets.loadManifest(
            bundle: Bundle(
                for: VoicePronunciationScoringTestBundleMarker.self
            )
        )

        #expect(!manifest.displayEnabled)
        #expect(manifest.disabledReason?.isEmpty == false)
        #expect(manifest.mappings.isEmpty)
        #expect(manifest.supportedPhones.isEmpty)
        #expect(manifest.validation == nil)
    }
}
