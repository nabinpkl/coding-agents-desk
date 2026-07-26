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
        #expect(result.phones.starts(with: ["θ", "ɔ", "t"]))
        #expect(result.phones.contains("ð"))
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
        let surface = VoicePassageSurface(
            frame: .zero,
            recordingStore: store,
            resourceBundle: Bundle(for: VoicePassageSurface.self)
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
