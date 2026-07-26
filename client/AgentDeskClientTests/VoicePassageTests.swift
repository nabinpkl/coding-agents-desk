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

        #expect(phones == ["θ", "ɪ", "ŋ", "k", "w", "ɔː", "k", "t", "uː"])
    }
}

struct VoicePassageSessionStoreTests {
    @Test @MainActor
    func savesLosslessCurrentTakeAndUpdatedComparisonMetadata() throws {
        guard #available(iOS 26.0, *) else { return }
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(
                "voice-passage-store-\(UUID().uuidString)",
                isDirectory: true
            )
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = VoicePassageSessionStore(directory: directory)

        var session = try store.save(
            capture: makeCapture(),
            locale: Locale(identifier: "en-US"),
            build: VoiceBuildIdentity(
                bundleIdentifier: "voice.tests",
                marketingVersion: "1.0.0",
                buildNumber: "1",
                gitSHA: "abc1234"
            )
        )
        session.transcript = "I thought about walking."
        session.observedPhones = ["aɪ", "t", "ɔː", "t"]
        session.referencePhones = ["aɪ", "θ", "ɔː", "t"]
        session.unknownReferenceWords = []
        session.modelWeightSHA256 = "model"
        try store.save(session)

        #expect(try store.load() == session)
        let audio = try AVAudioFile(forReading: store.audioURL(for: session))
        #expect(audio.length == 512)
        #expect(
            audio.fileFormat.settings[AVFormatIDKey] as? UInt32
                == kAudioFormatLinearPCM
        )
    }

    @MainActor
    private func makeCapture() -> VoiceCapturedTake {
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
            startedAt: Date(timeIntervalSince1970: 1_700_000_000),
            format: format,
            buffers: buffers
        )
    }
}

@MainActor
struct VoicePassageSurfaceTests {
    @Test
    func passageIsASeparateTabWithExactlyThreeComparisonCards() throws {
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
                surface.passageDescendant(identifier: identifier)
            )
            #expect(!card.isEffectivelyHidden)
        }
        let legacyStatus = try #require(
            surface.passageDescendant(identifier: "voice-status")
        )
        #expect(legacyStatus.isEffectivelyHidden)

        let transcript = try #require(
            surface.passageDescendant(
                identifier: "voice-passage-transcript"
            ) as? UITextView
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
        #expect(!transcript.isScrollEnabled)
        #expect(observed.numberOfLines == 0)
        #expect(reference.numberOfLines == 0)
    }
}

private extension UIView {
    func passageDescendant(identifier: String) -> UIView? {
        if accessibilityIdentifier == identifier {
            return self
        }
        for subview in subviews {
            if let match = subview.passageDescendant(identifier: identifier) {
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
