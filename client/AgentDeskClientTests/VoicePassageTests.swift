import AVFoundation
import Foundation
import Testing
import UIKit

struct VoicePassagePronunciationTests {
    @Test
    func longTranscriptUsesFirstDictionaryPronunciationAndReportsUnknownWords()
        throws
    {
        let dictionary = VoicePassagePronouncer.parseDictionary(
            """
            THOUGHT  TH AO1 T
            THOUGHT(2)  TH AO2 T
            ABOUT  AH0 B AW1 T
            WALKING  W AO1 K IH0 NG
            THROUGH  TH R UW1
            THE  DH AH0
            QUIET  K W AY1 AH0 T
            GARDEN  G AA1 R D AH0 N
            """
        )

        let result = try VoicePassagePronouncer.pronunciation(
            for: """
            I thought about walking through the quiet garden, then \
            mentioned flibbertigibbet.
            """,
            entries: dictionary
        )

        #expect(result.words.count == 11)
        #expect(result.wordPronunciations.count == 11)
        #expect(result.phones.starts(with: ["θ", "ɔ", "t"]))
        #expect(result.phones.contains("ð"))
        #expect(
            result.wordPronunciations.first {
                $0.word == "thought"
            }?.phones == ["θ", "ɔ", "t"]
        )
        #expect(
            result.wordPronunciations.first {
                $0.word == "flibbertigibbet"
            }?.isKnown == false
        )
        #expect(result.unknownWords == [
            "flibbertigibbet",
            "i",
            "mentioned",
            "then"
        ])
    }

    @Test
    func transcriptTokenizerKeepsEnglishContractionsAcrossPunctuation() {
        #expect(
            VoicePassagePronouncer.words(
                in: "  I'd thought—then, I wouldn't stop.  "
            ) == ["i'd", "thought", "then", "i", "wouldn't", "stop"]
        )
    }

    @Test
    func bundledPinnedDictionaryGeneratesReferencePhones() async throws {
        let bundle = Bundle(for: VoicePassageSurface.self)
        let result = try await VoicePassagePronouncer(
            bundle: bundle
        ).pronunciation(
            for: "I thought about walking through the quiet garden."
        )

        #expect(result.words.count == 8)
        #expect(result.phones.count > result.words.count)
        #expect(result.phones.contains("θ"))
        #expect(result.phones.contains("ð"))
        #expect(result.unknownWords.isEmpty)
    }
}

struct VoicePassagePhoneGroupingTests {
    @Test
    func groupsRawPhonesByReferenceWordAndRetainsInsertions() {
        let groups = VoicePassagePhoneGrouper.group(
            observedPhones: ["a", "x", "b", "c", "d", "z"],
            words: [
                VoicePassageWordPronunciation(
                    word: "one",
                    phones: ["a", "b"],
                    isKnown: true
                ),
                VoicePassageWordPronunciation(
                    word: "two",
                    phones: ["c", "d"],
                    isKnown: true
                )
            ]
        )

        #expect(groups.count == 2)
        #expect(groups[0].word == "one")
        #expect(groups[0].heardPhones == ["a", "x", "b"])
        #expect(groups[0].referencePhones == ["a", "b"])
        #expect(groups[1].word == "two")
        #expect(groups[1].heardPhones == ["c", "d", "z"])
        #expect(
            groups.flatMap(\.heardPhones)
                == ["a", "x", "b", "c", "d", "z"]
        )
    }

    @Test
    func keepsPhonesUnassignedWhenNoWordHasAReferenceAnchor() {
        let groups = VoicePassagePhoneGrouper.group(
            observedPhones: ["f", "oʊ", "n"],
            words: [
                VoicePassageWordPronunciation(
                    word: "unknownword",
                    phones: [],
                    isKnown: false
                )
            ]
        )

        #expect(groups.count == 2)
        #expect(groups[0].word == "unknownword")
        #expect(groups[0].heardPhones.isEmpty)
        #expect(groups[0].hasReferencePronunciation == false)
        #expect(groups[1].word == nil)
        #expect(groups[1].heardPhones == ["f", "oʊ", "n"])
    }

    @Test
    func deletionsLeaveTheMissingPhoneInsideItsReferenceWord() {
        let groups = VoicePassagePhoneGrouper.group(
            observedPhones: ["a", "c", "d"],
            words: [
                VoicePassageWordPronunciation(
                    word: "one",
                    phones: ["a", "b"],
                    isKnown: true
                ),
                VoicePassageWordPronunciation(
                    word: "two",
                    phones: ["c", "d"],
                    isKnown: true
                )
            ]
        )

        #expect(groups[0].heardPhones == ["a"])
        #expect(groups[0].referencePhones == ["a", "b"])
        #expect(groups[1].heardPhones == ["c", "d"])
    }

    @Test
    func aRunOfInsertedPhonesSplitsAtTheNearestWordAnchor() {
        let groups = VoicePassagePhoneGrouper.group(
            observedPhones: ["a", "x", "y", "z", "b"],
            words: [
                VoicePassageWordPronunciation(
                    word: "one",
                    phones: ["a"],
                    isKnown: true
                ),
                VoicePassageWordPronunciation(
                    word: "two",
                    phones: ["b"],
                    isKnown: true
                )
            ]
        )

        #expect(groups[0].heardPhones == ["a", "x", "y"])
        #expect(groups[1].heardPhones == ["z", "b"])
    }
}

struct VoicePassagePhoneChunkTests {
    @Test
    func onlyCollapsesTheDuplicateAtAnAdjacentChunkBoundary() {
        var phones = ["θ", "ɪ", "ŋ", "k"]

        VoicePhoneAnalyzer.appendPassageChunk(
            ["k", "w", "ɔː", "k"],
            to: &phones
        )
        VoicePhoneAnalyzer.appendPassageChunk(
            ["t", "uː"],
            to: &phones
        )

        #expect(
            phones
                == ["θ", "ɪ", "ŋ", "k", "w", "ɔː", "k", "t", "uː"]
        )
    }
}

struct VoicePassageRecordingStoreTests {
    @Test @MainActor
    func retainsMultipleLosslessTakesAndTheirIndependentAnalyses()
        throws
    {
        guard #available(iOS 26.0, *) else { return }
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = VoicePassageRecordingStore(
            rootDirectory: directory
        )

        let first = try store.save(
            capture: makeCapture(startedAt: Date(timeIntervalSince1970: 1)),
            locale: Locale(identifier: "en-US"),
            build: testBuild
        )
        var second = try store.save(
            capture: makeCapture(startedAt: Date(timeIntervalSince1970: 2)),
            locale: Locale(identifier: "en-US"),
            build: testBuild
        )
        second.applyRecognizedTranscript("I taught about walking.")
        second.applyTranscriptEdit(
            "I thought about walking.",
            at: Date(timeIntervalSince1970: 4)
        )
        second.applyRecognizedTranscript("I taught about walking again.")
        second.observedPhones = ["aɪ", "t", "ɔː", "t"]
        second.referencePhones = ["aɪ", "θ", "ɔː", "t"]
        second.wordPhoneGroups = [
            VoicePassageWordPhoneGroup(
                word: "i",
                heardPhones: ["aɪ"],
                referencePhones: ["aɪ"],
                hasReferencePronunciation: true
            ),
            VoicePassageWordPhoneGroup(
                word: "thought",
                heardPhones: ["t", "ɔː", "t"],
                referencePhones: ["θ", "ɔː", "t"],
                hasReferencePronunciation: true
            )
        ]
        second.phoneModelIdentifier =
            VoicePassagePhoneModel.wav2vec2.modelIdentifier
        second.lastAttemptedPhoneModelIdentifier =
            VoicePassagePhoneModel.wav2vec2.modelIdentifier
        second.modelWeightSHA256 = "model"
        second.lastAnalyzedAt = Date(timeIntervalSince1970: 3)
        try store.save(second)

        let recordings = try store.recordings()
        #expect(recordings.map(\.id) == [second.id, first.id])
        #expect(try store.recording(id: second.id) == second)
        #expect(second.transcript == "I thought about walking.")
        #expect(
            second.recognizedTranscript
                == "I taught about walking again."
        )
        #expect(
            try AVAudioFile(
                forReading: store.audioURL(for: first)
            ).length == 512
        )
        #expect(
            try AVAudioFile(
                forReading: store.audioURL(for: second)
            ).length == 512
        )
    }

    @Test
    func bundledSampleIsIdempotentAndReadyForSavedAudioAnalysis()
        throws
    {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = VoicePassageRecordingStore(
            rootDirectory: directory
        )
        let bundle = Bundle(for: VoicePassageSurface.self)

        let first = try store.seedBundledSample(
            bundle: bundle,
            build: testBuild
        )
        let second = try store.seedBundledSample(
            bundle: bundle,
            build: testBuild
        )

        #expect(first == second)
        #expect(first.id == VoicePassageBundledSample.id)
        #expect(first.source == .bundledSample)
        #expect(
            first.transcript
                == VoicePassageBundledSample.transcript
        )
        #expect(try store.recordings().count == 1)
        let audio = try AVAudioFile(
            forReading: store.audioURL(for: first)
        )
        #expect(audio.processingFormat.sampleRate == 16_000)
        #expect(audio.processingFormat.channelCount == 1)
        #expect(audio.length > 16_000)
    }

    @Test
    func deletingOneUserRecordingDoesNotDeleteOtherAudio()
        throws
    {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = VoicePassageRecordingStore(
            rootDirectory: directory
        )
        let first = try store.save(
            capture: makeCapture(startedAt: Date(timeIntervalSince1970: 1)),
            locale: Locale(identifier: "en-US"),
            build: testBuild
        )
        let second = try store.save(
            capture: makeCapture(startedAt: Date(timeIntervalSince1970: 2)),
            locale: Locale(identifier: "en-US"),
            build: testBuild
        )

        try store.delete(recordingID: first.id)

        #expect(try store.recordings().map(\.id) == [second.id])
        #expect(
            FileManager.default.fileExists(
                atPath: store.audioURL(for: second).path
            )
        )
    }

    private var testBuild: VoiceBuildIdentity {
        VoiceBuildIdentity(
            bundleIdentifier: "voice.tests",
            marketingVersion: "1.0.0",
            buildNumber: "1",
            gitSHA: "abc1234"
        )
    }

    private func temporaryDirectory() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent(
                "voice-passage-store-\(UUID().uuidString)",
                isDirectory: true
            )
    }

    private func makeCapture(
        startedAt: Date
    ) -> VoiceCapturedTake {
        let format = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: 16_000,
            channels: 1,
            interleaved: false
        )!
        let buffers = (0..<2).map { bufferIndex in
            let buffer = AVAudioPCMBuffer(
                pcmFormat: format,
                frameCapacity: 256
            )!
            buffer.frameLength = 256
            for frame in 0..<Int(buffer.frameLength) {
                buffer.floatChannelData![0][frame] =
                    Float(bufferIndex * 256 + frame) / 512
            }
            return buffer
        }
        return VoiceCapturedTake(
            startedAt: startedAt,
            format: format,
            buffers: buffers
        )
    }
}

struct VoicePassagePhoneModelTests {
    @Test
    func defaultsToZIPAAndPersistsAnExplicitChoice() throws {
        let suiteName = "voice-passage-model-\(UUID().uuidString)"
        let defaults = try #require(
            UserDefaults(suiteName: suiteName)
        )
        defer {
            defaults.removePersistentDomain(
                forName: suiteName
            )
        }

        #expect(
            VoicePassagePhoneModel.selected(in: defaults) == .zipa
        )
        VoicePassagePhoneModel.wav2vec2.select(in: defaults)
        #expect(
            VoicePassagePhoneModel.selected(in: defaults)
                == .wav2vec2
        )
    }

    @Test
    func ZIPATokensMergeIntoReferenceCompatiblePhoneUnits() {
        #expect(
            VoiceZIPAPhoneUnits.merge([
                "a", "ɪ", "t", "ʃ", "i", "ː", "g"
            ]) == ["aɪ", "tʃ", "iː", "ɡ"]
        )
    }

    @Test
    func greedyCTCRemovesBlanksAndOnlyAdjacentDuplicates() {
        let logits: [Float] = [
            9, 0, 0, 0,
            0, 9, 0, 0,
            0, 8, 1, 0,
            9, 0, 0, 0,
            0, 0, 9, 0,
            0, 9, 0, 0
        ]
        let decoded = logits.withUnsafeBufferPointer {
            VoiceZIPAPhoneAnalyzer.greedyCTCDecode(
                values: $0,
                frameCount: 6,
                vocabularySize: 4,
                blankTokenID: 0
            )
        }
        #expect(decoded == [1, 2, 1])
    }

    @Test
    func chunkOverlapIsRemovedWithoutDroppingNewPhones() {
        var phones = ["aɪ", "θ", "ɔ", "t"]
        VoiceZIPAPhoneAnalyzer.appendChunk(
            ["ɔ", "t", "ə", "b", "aʊ", "t"],
            to: &phones
        )
        #expect(
            phones == ["aɪ", "θ", "ɔ", "t", "ə", "b", "aʊ", "t"]
        )
    }

    @Test
    func filterbankStaysWithinBoundedParityWithZIPAsLhotseFrontend()
        throws
    {
        let bundle = Bundle(for: VoicePassageSurface.self)
        let url = try #require(
            bundle.url(
                forResource: VoicePassageBundledSample.resourceName,
                withExtension: "caf"
            )
        )
        let file = try AVAudioFile(forReading: url)
        let buffer = try VoiceAudioFileReader.readAll(from: file)
        #expect(Int64(buffer.frameLength) == file.length)
        let channel = try #require(buffer.floatChannelData?[0])
        let samples = Array(
            UnsafeBufferPointer(
                start: channel,
                count: Int(buffer.frameLength)
            )
        )

        let features = try VoiceZIPAFilterbank.extract(
            samples: samples
        )

        #expect(features.frameCount == 232)
        assertApproximately(
            Array(features.values[0..<8]),
            [
                -10.99058151, -10.26861382, -8.95499134,
                -7.62882948, -6.70632696, -6.03437424,
                -5.85319328, -6.70732307
            ]
        )
        let middle = (features.frameCount / 2) * 80
        assertApproximately(
            Array(features.values[middle..<(middle + 8)]),
            [
                -10.79094791, -11.33516598, -10.38888454,
                -10.06188679, -9.69330692, -9.37312031,
                -9.19065189, -8.75494671
            ]
        )
        assertApproximately(
            Array(features.values.suffix(80).prefix(8)),
            Array(repeating: -15.94238472, count: 8)
        )
    }

    @Test
    func bundledZIPAModelDecodesTheSavedPassageAudio() async throws {
        let bundle = Bundle(for: VoicePassageSurface.self)
        let audioURL = try #require(
            bundle.url(
                forResource: VoicePassageBundledSample.resourceName,
                withExtension: "caf"
            )
        )
        let observation = try await VoiceZIPAPhoneAnalyzer(
            bundle: bundle
        ).analyze(
            analysisID: VoicePassageBundledSample.id,
            audioURL: audioURL
        )

        #expect(observation.analyzedChunkCount == 1)
        #expect(
            observation.phones == [
                "aɪ", "θ", "ɔ", "t", "ə", "b", "aʊ", "t",
                "w", "ɔ", "k", "ɪ", "ŋ", "θ", "ɹ", "u",
                "ð", "ə", "k", "w", "aɪ", "ə", "t", "ɡ",
                "ɑ", "ɹ", "d", "ə", "n"
            ]
        )
        #expect(
            observation.modelWeightSHA256
                == VoiceZIPAModelManifest.selectedModelSHA256
        )
    }

    @Test
    func coordinatorRoutesTheSameSavedAudioToWav2vec2() async throws {
        let bundle = Bundle(for: VoicePassageSurface.self)
        let audioURL = try #require(
            bundle.url(
                forResource: VoicePassageBundledSample.resourceName,
                withExtension: "caf"
            )
        )
        let observation = try await VoicePassagePhoneAnalyzer(
            bundle: bundle
        ).analyze(
            model: .wav2vec2,
            analysisID: VoicePassageBundledSample.id,
            audioURL: audioURL,
            localeIdentifier: "en_US"
        )

        #expect(!observation.phones.isEmpty)
        #expect(
            observation.modelWeightSHA256
                == VoicePhoneModelManifest.selectedWeightSHA256
        )
    }

    private func assertApproximately(
        _ actual: [Float],
        _ expected: [Float],
        // Accelerate's Float32 complex FFT and PyTorch's real FFT differ
        // slightly in low-energy bins. The end-to-end test above is the
        // stronger gate: it must preserve ZIPA's exact decoded phone sequence.
        tolerance: Float = 0.2
    ) {
        #expect(actual.count == expected.count)
        for (actualValue, expectedValue) in zip(actual, expected) {
            #expect(
                abs(actualValue - expectedValue) < tolerance,
                "actual \(actualValue), expected \(expectedValue)"
            )
        }
    }
}

@MainActor
struct VoicePassageSurfaceTests {
    @Test
    func speechModeKeepsTargetPracticeAndPassageAsSeparateTabs() throws {
        guard #available(iOS 26.0, *) else { return }
        let surface = VoicePlaygroundSurface()
        defer { surface.teardown() }
        let mode = try #require(
            surface.passageDescendant(
                identifier: "voice-mode-control"
            ) as? UISegmentedControl
        )

        #expect(mode.numberOfSegments == 2)
        #expect(mode.titleForSegment(at: 0) == "Target practice")
        #expect(mode.titleForSegment(at: 1) == "Passage")
        #expect(mode.selectedSegmentIndex == 0)

        surface.selectMode(.passage)
        #expect(mode.selectedSegmentIndex == 1)
        let legacyStatus = try #require(
            surface.passageDescendant(identifier: "voice-status")
        )
        #expect(legacyStatus.isEffectivelyHidden)
        let library = try #require(
            surface.passageDescendant(
                identifier: "voice-passage-library"
            )
        )
        #expect(!library.isEffectivelyHidden)
    }

    @Test
    func passageUsesLibraryThenSelectedRecordingThreeCardDetail()
        throws
    {
        guard #available(iOS 26.0, *) else { return }
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(
                "voice-passage-ui-\(UUID().uuidString)",
                isDirectory: true
            )
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = VoicePassageRecordingStore(
            rootDirectory: directory
        )
        let bundle = Bundle(for: VoicePassageSurface.self)
        let suiteName = "voice-passage-ui-model-\(UUID().uuidString)"
        let defaults = try #require(
            UserDefaults(suiteName: suiteName)
        )
        defer {
            defaults.removePersistentDomain(
                forName: suiteName
            )
        }
        var sample = try store.seedBundledSample(
            bundle: bundle
        )
        sample.observedPhones = ["aɪ", "t", "ɔ", "t"]
        sample.referencePhones = ["aɪ", "θ", "ɔ", "t"]
        sample.phoneModelIdentifier =
            VoicePassagePhoneModel.wav2vec2.modelIdentifier
        sample.lastAttemptedPhoneModelIdentifier =
            VoicePassagePhoneModel.wav2vec2.modelIdentifier
        sample.lastAnalyzedAt = Date(timeIntervalSince1970: 1)
        sample.wordPhoneGroups = [
            VoicePassageWordPhoneGroup(
                word: "i",
                heardPhones: ["aɪ"],
                referencePhones: ["aɪ"],
                hasReferencePronunciation: true
            ),
            VoicePassageWordPhoneGroup(
                word: "thought",
                heardPhones: ["t", "ɔ", "t"],
                referencePhones: ["θ", "ɔ", "t"],
                hasReferencePronunciation: true
            )
        ]
        try store.save(sample)
        let surface = VoicePassageSurface(
            frame: .zero,
            recordingStore: store,
            resourceBundle: bundle,
            userDefaults: defaults
        )
        defer { surface.teardown() }

        let library = try #require(
            surface.passageDescendant(
                identifier: "voice-passage-library"
            )
        )
        let detail = try #require(
            surface.passageDescendant(
                identifier: "voice-passage-detail"
            )
        )
        #expect(!library.isEffectivelyHidden)
        #expect(detail.isEffectivelyHidden)

        surface.showRecording(id: VoicePassageBundledSample.id)

        #expect(library.isEffectivelyHidden)
        #expect(!detail.isEffectivelyHidden)
        let cardIDs = surface.passageIdentifiers(
            withPrefix: "voice-passage-",
            suffix: "-card"
        )
        #expect(cardIDs == Set([
            "voice-passage-transcript-card",
            "voice-passage-observed-card",
            "voice-passage-reference-card"
        ]))
        for identifier in cardIDs {
            let card = try #require(
                surface.passageDescendant(
                    identifier: identifier
                )
            )
            #expect(!card.isEffectivelyHidden)
        }
        let transcript = try #require(
            surface.passageDescendant(
                identifier: "voice-passage-transcript"
            ) as? UITextView
        )
        #expect(
            transcript.text == VoicePassageBundledSample.transcript
        )
        #expect(transcript.isEditable)
        #expect(!transcript.isScrollEnabled)
        let modelControl = try #require(
            surface.passageDescendant(
                identifier: "voice-passage-phone-model"
            ) as? UISegmentedControl
        )
        #expect(modelControl.numberOfSegments == 2)
        #expect(modelControl.titleForSegment(at: 0) == "ZIPA")
        #expect(modelControl.titleForSegment(at: 1) == "wav2vec2")
        #expect(modelControl.selectedSegmentIndex == 0)
        let detailStatus = try #require(
            surface.passageDescendant(
                identifier: "voice-passage-detail-status"
            ) as? UILabel
        )
        #expect(
            detailStatus.text?.contains("using wav2vec2") == true
        )
        surface.selectPhoneModel(.wav2vec2)
        #expect(modelControl.selectedSegmentIndex == 1)
        #expect(
            VoicePassagePhoneModel.selected(in: defaults)
                == .wav2vec2
        )
        let observed = try #require(
            surface.passageDescendant(
                identifier: "voice-passage-observed-phones"
            ) as? UILabel
        )
        let reference = try #require(
            surface.passageDescendant(
                identifier: "voice-passage-reference-phones"
            ) as? UILabel
        )
        #expect(
            observed.attributedText?.string.contains(
                "i\u{00A0}\u{00A0}aɪ      "
                    + "thought\u{00A0}\u{00A0}t"
                    + "\u{00A0}\u{00A0}ɔ"
                    + "\u{00A0}\u{00A0}t"
            ) == true
        )
        #expect(
            reference.attributedText?.string.contains(
                "i\u{00A0}\u{00A0}aɪ      "
                    + "thought\u{00A0}\u{00A0}θ"
                    + "\u{00A0}\u{00A0}ɔ"
                    + "\u{00A0}\u{00A0}t"
            ) == true
        )
        #expect(
            observed.attributedText?.string.contains("\n")
                == false
        )
    }
}

private extension UIView {
    func passageDescendant(identifier: String) -> UIView? {
        if accessibilityIdentifier == identifier {
            return self
        }
        for subview in subviews {
            if let match = subview.passageDescendant(
                identifier: identifier
            ) {
                return match
            }
        }
        return nil
    }

    func passageIdentifiers(
        withPrefix prefix: String,
        suffix: String
    ) -> Set<String> {
        var identifiers = Set<String>()
        if let accessibilityIdentifier,
           accessibilityIdentifier.hasPrefix(prefix),
           accessibilityIdentifier.hasSuffix(suffix)
        {
            identifiers.insert(accessibilityIdentifier)
        }
        for subview in subviews {
            identifiers.formUnion(
                subview.passageIdentifiers(
                    withPrefix: prefix,
                    suffix: suffix
                )
            )
        }
        return identifiers
    }

    var isEffectivelyHidden: Bool {
        if isHidden { return true }
        return superview?.isEffectivelyHidden ?? false
    }
}
