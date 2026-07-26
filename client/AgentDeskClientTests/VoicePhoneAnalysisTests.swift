import CoreML
import Foundation
import Testing

struct VoicePronunciationLexiconTests {
    @Test
    func pinnedCMUdictEntriesMapEveryPhaseOneContrastToModelPhones() throws {
        let expected: [String: [String]] = [
            "think": ["θ", "ɪ", "ŋ", "k"],
            "sink": ["s", "ɪ", "ŋ", "k"],
            "rice": ["ɹ", "aɪ", "s"],
            "lice": ["l", "aɪ", "s"],
            "very": ["v", "ɛ", "ɹ", "iː"],
            "wary": ["w", "ɛ", "ɹ", "iː"],
            "ship": ["ʃ", "ɪ", "p"],
            "sheep": ["ʃ", "iː", "p"]
        ]

        for (word, phones) in expected {
            let pronunciations = try VoicePronunciationLexicon.pronunciations(
                for: word,
                localeIdentifier: "en-US"
            )
            #expect(pronunciations.count == 1)
            #expect(pronunciations[0].phones == phones)
            #expect(
                pronunciations[0].sourceRevision
                    == VoicePronunciationLexicon.sourceRevision
            )
        }
    }

    @Test
    func unknownWordAndNonUSLocaleFailVisibly() {
        #expect(throws: VoicePronunciationLexiconError.self) {
            try VoicePronunciationLexicon.pronunciations(
                for: "tink",
                localeIdentifier: "en-US"
            )
        }
        #expect(throws: VoicePronunciationLexiconError.self) {
            try VoicePronunciationLexicon.pronunciations(
                for: "think",
                localeIdentifier: "en-GB"
            )
        }
    }
}

struct VoicePhoneVocabularyTests {
    @Test
    func idOrderedVocabularyPreservesCanonicallyEquivalentTokens() throws {
        let decomposed = "u\u{0303}"
        let precomposed = "\u{0169}"
        #expect(decomposed == precomposed)

        let tokens = ["<pad>", decomposed, precomposed]
        let vocabulary = try VoicePhoneModelAssets.decodeVocabulary(
            data: JSONEncoder().encode(tokens),
            manifest: manifest(vocabularySize: tokens.count)
        )

        #expect(vocabulary.tokensByID.count == 3)
        #expect(vocabulary.tokenID(for: decomposed) == 1)
        #expect(vocabulary.tokenID(for: precomposed) == 2)
    }

    private func manifest(vocabularySize: Int) -> VoicePhoneModelManifest {
        VoicePhoneModelManifest(
            schemaVersion: 1,
            identifier: "test-model",
            upstreamModel: "upstream",
            upstreamLicense: "Apache-2.0",
            conversionRepository: "conversion",
            conversionRevision: "revision",
            conversionID: "conversion-id",
            sourceWeightSHA256: "source",
            modelWeightSHA256: VoicePhoneModelManifest.selectedWeightSHA256,
            modelSpecificationSHA256:
                VoicePhoneModelManifest.selectedSpecificationSHA256,
            vocabularySHA256: "vocabulary",
            modelBytes: 100,
            minimumIOSVersion: 26,
            sampleRate: 16_000,
            sampleCount: 64_000,
            frameCount: 199,
            vocabularySize: vocabularySize,
            blankTokenID: 0
        )
    }
}

struct VoiceCTCAlignmentTests {
    @Test
    func collapsesBlanksAndRepeatedTokens() throws {
        let logits: [[Float]] = [
            [5, 0, 0],
            [0, 5, 0],
            [0, 5, 0],
            [5, 0, 0],
            [0, 0, 5]
        ]
        let posteriors = try VoiceCTCAlignment.logPosteriors(logits: logits)

        #expect(
            VoiceCTCAlignment.greedyTokens(
                logPosteriors: posteriors,
                blankTokenID: 0
            ) == [1, 2]
        )
    }

    @Test
    func forcedAlignmentRetainsTargetRangesAndCompetingPhones() throws {
        let logits: [[Float]] = [
            [8, 0, 0, 0],
            [0, 8, 3, 0],
            [8, 0, 0, 0],
            [0, 0, 2, 8],
            [8, 0, 0, 0]
        ]
        let posteriors = try VoiceCTCAlignment.logPosteriors(logits: logits)
        let alignment = try VoiceCTCAlignment.align(
            logPosteriors: posteriors,
            targetTokenIDs: [1, 3],
            blankTokenID: 0
        )
        let competitors = VoiceCTCAlignment.topHypotheses(
            frame: posteriors[1],
            vocabulary: [0: "<pad>", 1: "θ", 2: "t", 3: "ɪ"],
            limit: 2,
            excludingTokenIDs: [0, 1]
        )

        #expect(alignment.tokenFrameRanges == [1...1, 3...3])
        #expect(competitors.map(\.phone) == ["t", "ɪ"])
        #expect(competitors[0].logPosterior > competitors[1].logPosterior)
    }

    @Test
    func topHypothesesRetainTheRequestedBoundAndExcludeSpecialTokens() {
        let hypotheses = VoiceCTCAlignment.topHypotheses(
            frame: [-0.01, -0.02, -0.2, -0.3, -0.4, -0.5, -0.6],
            vocabulary: [
                0: "<pad>",
                1: "<s>",
                2: "θ",
                3: "t",
                4: "s",
                5: "f",
                6: "v"
            ],
            limit: 3
        )

        #expect(hypotheses.map(\.phone) == ["θ", "t", "s"])
        #expect(hypotheses.count == 3)
    }
}

struct VoicePhoneEvidenceEncodingTests {
    @Test
    func sidecarRoundTripKeepsHashesFramesAndAlignment() throws {
        let evidence = makeEvidence()
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601

        let decoded = try decoder.decode(
            VoiceStoredPhoneAnalysis.self,
            from: encoder.encode(VoiceStoredPhoneAnalysis.completed(evidence))
        )

        #expect(decoded.isWellFormed)
        #expect(decoded.evidence?.frames == evidence.frames)
        #expect(decoded.evidence?.alignedPhones == evidence.alignedPhones)
        #expect(decoded.modelWeightSHA256 == evidence.model.modelWeightSHA256)
    }

    @Test
    func analyzerRequestHasOnlyAudioPronunciationLocaleAndPinnedModelInputs() {
        let evidence = makeEvidence()
        let request = VoicePhoneAnalyzer.Request(
            attemptID: evidence.attemptID,
            audioURL: URL(fileURLWithPath: "/tmp/audio.caf"),
            pronunciation: evidence.pronunciation,
            localeIdentifier: "en-US",
            modelManifest: evidence.model
        )

        #expect(request.pronunciation.phones == ["θ", "ɪ", "ŋ", "k"])
        #expect(request.modelManifest.modelWeightSHA256
            == VoicePhoneModelManifest.selectedWeightSHA256)
    }

    @Test @MainActor
    func savedReviewLabelsPhoneEvidenceWithoutInventingAScore() {
        let evidence = makeEvidence()
        let text = VoicePlaygroundSurface.savedPhoneAnalysisText(
            analysis: .completed(evidence),
            audioSHA256: evidence.audioSHA256,
            readFailure: nil
        )

        #expect(text.contains("Raw model evidence, not a pronunciation score."))
        #expect(text.contains("Target / θ ɪ ŋ k /"))
        #expect(text.contains("observed θ"))
        #expect(text.contains("competitors t"))
        #expect(text.contains("window 0.00–1.00s of 1.00s source"))
        #expect(!text.localizedCaseInsensitiveContains("percent"))
    }

    private func makeEvidence() -> VoicePhoneEvidence {
        let attemptID = UUID()
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
            modelSpecificationSHA256:
                VoicePhoneModelManifest.selectedSpecificationSHA256,
            vocabularySHA256: "vocab",
            modelBytes: 100,
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
        let hypothesis = VoicePhoneHypothesis(
            tokenID: 52,
            phone: "θ",
            logPosterior: -0.2
        )
        return VoicePhoneEvidence(
            schemaVersion: 1,
            attemptID: attemptID,
            createdAt: Date(timeIntervalSince1970: 1_700_000_000),
            audioSHA256: "audio",
            localeIdentifier: "en-US",
            model: model,
            pronunciation: pronunciation,
            frames: [
                VoicePhoneFrameEvidence(
                    startSeconds: 0,
                    endSeconds: 0.02,
                    hypotheses: [hypothesis]
                )
            ],
            alignedPhones: [
                VoiceAlignedPhoneEvidence(
                    targetPhone: "θ",
                    startSeconds: 0,
                    endSeconds: 0.02,
                    targetLogPosterior: -0.2,
                    observedPhone: hypothesis,
                    competingPhones: [
                        VoicePhoneHypothesis(
                            tokenID: 6,
                            phone: "t",
                            logPosterior: -1.2
                        )
                    ],
                    posteriorMargin: 1
                )
            ],
            metrics: VoicePhoneInferenceMetrics(
                sourceDurationSeconds: 1,
                analyzedOffsetSeconds: 0,
                analyzedDurationSeconds: 1,
                preprocessingMilliseconds: 1,
                modelLoadMilliseconds: 2,
                inferenceMilliseconds: 3,
                observedResidentMemoryDeltaBytes: 4
            )
        )
    }
}

struct VoicePhoneAnalyzerLogitsTests {
    @Test
    func copiesPaddedModelOutputByCoordinates() throws {
        let logits = MLMultiArray(
            shape: [1, 2, 3],
            dataType: .float32,
            strides: [8, 4, 1]
        )
        let expected: [[Float]] = [
            [1, 2, 3],
            [4, 5, 6]
        ]
        for frame in expected.indices {
            for token in expected[frame].indices {
                logits[
                    [
                        NSNumber(value: 0),
                        NSNumber(value: frame),
                        NSNumber(value: token)
                    ]
                ] = NSNumber(value: expected[frame][token])
            }
        }

        let copied = try VoicePhoneAnalyzer.copyLogits(
            logits,
            frameCount: 2,
            vocabularySize: 3
        )

        #expect(copied == expected)
    }

    @Test
    func rejectsUnexpectedModelOutputShape() throws {
        let logits = try MLMultiArray(
            shape: [1, 2, 4],
            dataType: .float32
        )

        #expect(throws: VoicePhoneAnalyzerError.self) {
            try VoicePhoneAnalyzer.copyLogits(
                logits,
                frameCount: 2,
                vocabularySize: 3
            )
        }
    }
}
