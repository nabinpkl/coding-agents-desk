import Foundation
import AVFoundation
import Testing
import WebPanelKit
@testable import InteractionPanel

struct InteractionPanelTests {
    @Test func decodesSpaceStepDeltas() {
        #expect(
            InteractionPanelRequest.decode(tag: "spaceStep", body: ["delta": 1])
                == .spaceStep(delta: 1)
        )
        #expect(
            InteractionPanelRequest.decode(tag: "spaceStep", body: ["delta": -1])
                == .spaceStep(delta: -1)
        )
    }

    @Test func rejectsOutOfRangeOrMalformedSpaceStep() {
        #expect(InteractionPanelRequest.decode(tag: "spaceStep", body: ["delta": 2]) == nil)
        #expect(InteractionPanelRequest.decode(tag: "spaceStep", body: ["delta": 0]) == nil)
        #expect(InteractionPanelRequest.decode(tag: "spaceStep", body: [:]) == nil)
        #expect(InteractionPanelRequest.decode(tag: "unknown", body: ["delta": 1]) == nil)
    }

    @Test func decodesBoundedReferenceSpeechRequests() {
        #expect(
            InteractionPanelRequest.decode(
                tag: "referenceSpeech",
                body: ["text": "hello", "language": "en-US"]
            ) == .referenceSpeech(text: "hello", language: "en-US")
        )
        #expect(
            InteractionPanelRequest.decode(tag: "referenceSpeechStop", body: [:])
                == .referenceSpeechStop
        )
        #expect(
            InteractionPanelRequest.decode(tag: "referenceSpeechStateRequest", body: [:])
                == .referenceSpeechStateRequest
        )
        #expect(
            InteractionPanelRequest.decode(
                tag: "referenceSpeechPreferencesUpdate",
                body: ["voiceIdentifier": NSNull(), "rate": 0.5]
            ) == .referenceSpeechPreferencesUpdate(
                voiceIdentifier: nil,
                rate: 0.5
            )
        )
        #expect(
            InteractionPanelRequest.decode(
                tag: "referenceSpeechPreferencesUpdate",
                body: ["voiceIdentifier": "voice-1", "rate": 0.65]
            ) == .referenceSpeechPreferencesUpdate(
                voiceIdentifier: "voice-1",
                rate: 0.65
            )
        )
        #expect(
            InteractionPanelRequest.decode(
                tag: "referenceSpeech",
                body: ["text": "  ", "language": "en-US"]
            ) == nil
        )
        #expect(
            InteractionPanelRequest.decode(
                tag: "referenceSpeech",
                body: [
                    "text": String(
                        repeating: "a",
                        count: InteractionPanelRequest.maximumReferenceSpeechUTF8Bytes + 1
                    ),
                    "language": "en-US",
                ]
            ) == nil
        )
        #expect(
            InteractionPanelRequest.decode(
                tag: "referenceSpeech",
                body: ["text": "hello", "language": "fr-FR"]
            ) == nil
        )
        #expect(
            InteractionPanelRequest.decode(
                tag: "referenceSpeechPreferencesUpdate",
                body: ["voiceIdentifier": "", "rate": 0.5]
            ) == nil
        )
        #expect(
            InteractionPanelRequest.decode(
                tag: "referenceSpeechPreferencesUpdate",
                body: ["voiceIdentifier": NSNull(), "rate": Double.nan]
            ) == nil
        )
        #expect(
            InteractionPanelRequest.decode(
                tag: "referenceSpeechPreferencesUpdate",
                body: ["voiceIdentifier": NSNull(), "rate": true]
            ) == nil
        )
    }

    @Test func speechCatalogFiltersAndSortsDescriptors() {
        let voices = [
            NativeSpeechVoiceDescriptor(
                identifier: "basic-z",
                name: "Zulu",
                language: "en-US",
                quality: .basic
            ),
            NativeSpeechVoiceDescriptor(
                identifier: "premium-b",
                name: "Beta",
                language: "en-US",
                quality: .premium
            ),
            NativeSpeechVoiceDescriptor(
                identifier: "enhanced-a",
                name: "Alpha",
                language: "en-US",
                quality: .enhanced
            ),
            NativeSpeechVoiceDescriptor(
                identifier: "premium-a",
                name: "Alpha",
                language: "en-US",
                quality: .premium
            ),
            NativeSpeechVoiceDescriptor(
                identifier: "french",
                name: "Amelie",
                language: "fr-FR",
                quality: .premium
            ),
        ]

        let sorted = NativeSpeechVoiceCatalog.sortedDescriptors(
            voices,
            language: "en-US"
        )
        #expect(sorted.map(\.identifier) == [
            "premium-a",
            "premium-b",
            "enhanced-a",
            "basic-z",
        ])
        #expect(sorted[0].displayName == "Alpha (Premium)")
        #expect(sorted[3].displayName == "Zulu")
    }

    @Test func speechCatalogResolvesVoiceLanguageAndMissingSelections() {
        let voices = [
            NativeSpeechVoiceDescriptor(
                identifier: "en-voice",
                name: "Samantha",
                language: "en-US",
                quality: .basic
            ),
            NativeSpeechVoiceDescriptor(
                identifier: "fr-voice",
                name: "Amelie",
                language: "fr-FR",
                quality: .basic
            ),
        ]

        #expect(
            NativeSpeechVoiceCatalog.resolvedSelection(
                voices: voices,
                voiceIdentifier: "fr-voice",
                language: "en-US",
                preferredLanguages: []
            ) == NativeSpeechVoiceSelection(
                voiceIdentifier: "fr-voice",
                language: "fr-FR"
            )
        )
        #expect(
            NativeSpeechVoiceCatalog.resolvedSelection(
                voices: voices,
                voiceIdentifier: "missing",
                language: "missing",
                preferredLanguages: ["en-CA"]
            ) == NativeSpeechVoiceSelection(
                voiceIdentifier: nil,
                language: "en-US"
            )
        )
    }

    @Test func referenceSpeechPreferencesPersistAndRecoverMissingVoice() throws {
        let suite = "InteractionPanelTests.referenceSpeech.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = ReferenceSpeechPreferences(defaults: defaults)
        let voices = [
            NativeSpeechVoiceDescriptor(
                identifier: "voice-1",
                name: "Samantha",
                language: "en-US",
                quality: .basic
            ),
        ]

        let updated = try preferences.update(
            voiceIdentifier: "voice-1",
            rate: 2,
            availableVoices: voices
        )
        #expect(updated.selectedVoiceIdentifier == "voice-1")
        #expect(updated.rate.current == Double(AVSpeechUtteranceMaximumSpeechRate))

        let restored = ReferenceSpeechPreferences(defaults: defaults)
            .currentState(availableVoices: voices)
        #expect(restored.selectedVoiceIdentifier == "voice-1")
        #expect(restored.rate.current == Double(AVSpeechUtteranceMaximumSpeechRate))

        let missing = restoredState(
            from: defaults,
            availableVoices: []
        )
        #expect(missing.selectedVoiceIdentifier == nil)
        #expect(missing.notice?.contains("no longer available") == true)
    }

    @Test func referenceSpeechPreferencesRejectInvalidUpdatesAndStayIsolated() throws {
        let firstSuite = "InteractionPanelTests.referenceSpeech.first.\(UUID().uuidString)"
        let secondSuite = "InteractionPanelTests.referenceSpeech.second.\(UUID().uuidString)"
        let firstDefaults = try #require(UserDefaults(suiteName: firstSuite))
        let secondDefaults = try #require(UserDefaults(suiteName: secondSuite))
        defer {
            firstDefaults.removePersistentDomain(forName: firstSuite)
            secondDefaults.removePersistentDomain(forName: secondSuite)
        }
        let voice = NativeSpeechVoiceDescriptor(
            identifier: "voice-1",
            name: "Samantha",
            language: "en-US",
            quality: .basic
        )
        let first = ReferenceSpeechPreferences(defaults: firstDefaults)
        let second = ReferenceSpeechPreferences(defaults: secondDefaults)

        #expect(throws: ReferenceSpeechPreferencesError.invalidRate) {
            try first.update(
                voiceIdentifier: "voice-1",
                rate: .nan,
                availableVoices: [voice]
            )
        }
        #expect(throws: ReferenceSpeechPreferencesError.voiceUnavailable) {
            try first.update(
                voiceIdentifier: "missing",
                rate: 0.5,
                availableVoices: [voice]
            )
        }
        _ = try first.update(
            voiceIdentifier: "voice-1",
            rate: 0.65,
            availableVoices: [voice]
        )
        #expect(
            second.currentState(availableVoices: [voice]).selectedVoiceIdentifier == nil
        )
        #expect(second.currentState(availableVoices: [voice]).rate.current == 0.5)
    }

    @Test func referenceSpeechPreferencesConfigureSystemDefaultUtterance() throws {
        let suite = "InteractionPanelTests.referenceSpeech.utterance.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = ReferenceSpeechPreferences(defaults: defaults)
        _ = try preferences.update(
            voiceIdentifier: nil,
            rate: 0.65,
            availableVoices: []
        )

        let utterance = AVSpeechUtterance(string: "hello")
        preferences.configure(utterance)

        #expect(utterance.voice?.language == "en-US")
        #expect(utterance.rate == 0.65)
    }

    @MainActor
    @Test func referenceSpeechStateDeliveryIsTypedAndBounded() throws {
        let state = ReferenceSpeechState(
            language: "en-US",
            voices: [],
            selectedVoiceIdentifier: nil,
            rate: ReferenceSpeechRateState(
                minimum: 0,
                defaultValue: 0.5,
                maximum: 1,
                current: 0.5
            )
        )
        let delivery = try InteractionPanelWebViewController.referenceSpeechDeliveryJSON(state)
        let object = try #require(
            JSONSerialization.jsonObject(with: Data(delivery.utf8)) as? [String: Any]
        )
        #expect(object["type"] as? String == "referenceSpeechState")
        #expect(object["payload"] is [String: Any])

        let oversized = ReferenceSpeechState(
            language: "en-US",
            voices: [
                NativeSpeechVoiceDescriptor(
                    identifier: "voice-1",
                    name: String(
                        repeating: "a",
                        count: InteractionPanelWebViewController
                            .maximumReferenceSpeechStateUTF8Bytes
                    ),
                    language: "en-US",
                    quality: .basic
                ),
            ],
            selectedVoiceIdentifier: nil,
            rate: state.rate
        )
        #expect(throws: InteractionPanelWebViewController.DeliveryError.payloadTooLarge) {
            try InteractionPanelWebViewController.referenceSpeechDeliveryJSON(oversized)
        }
    }

    @Test func decodesVoiceTransportRequests() {
        #expect(
            InteractionPanelRequest.decode(
                tag: "voiceSocketOpen",
                body: ["requestID": "r1", "recordingSessionID": "s1"]
            ) == .voiceSocketOpen(requestID: "r1", recordingSessionID: "s1")
        )
        #expect(
            InteractionPanelRequest.decode(
                tag: "voiceSocketMessage",
                body: ["recordingSessionID": "s1", "json": #"{"type":"sessionStop"}"#]
            ) == .voiceSocketMessage(
                recordingSessionID: "s1",
                json: #"{"type":"sessionStop"}"#
            )
        )
        #expect(
            InteractionPanelRequest.decode(
                tag: "voiceREST",
                body: [
                    "requestID": "r2",
                    "method": "GET",
                    "path": "/recordings",
                ]
            ) == .voiceREST(InteractionVoiceRESTRequest(
                requestID: "r2",
                method: "GET",
                path: "/recordings",
                body: nil
            ))
        )
    }

    @Test func interactionContractIsDistinctFromAgentFeed() {
        #expect(WebPanelContract.interaction.scheme == "interactionfeed")
        #expect(WebPanelContract.interaction.messageHandlerName == "interaction")
        #expect(
            WebPanelContract.interaction.indexRequestURL?.absoluteString
                == "interactionfeed://app/index.html"
        )
    }

    @Test func bundledWebviewOrCleanBuildFixtureResolves() throws {
        let locator = WebPanelResourceLocator(
            bundle: .module,
            webviewDirectoryName: InteractionPanelResources.webviewDirectoryName,
            fixtureDirectoryName: InteractionPanelResources.fixtureDirectoryName
        )
        let root = try #require(locator.rootDirectory())
        let index = try #require(locator.indexURL())
        let html = String(decoding: try Data(contentsOf: index), as: UTF8.self)
        if root.lastPathComponent == "InteractionPanelWebview" {
            #expect(html.contains(#"<div id="root"></div>"#))
        } else {
            #expect(root.lastPathComponent == "InteractionPanelFixture")
            #expect(html.contains("InteractionPanel fixture"))
        }
    }
}

private func restoredState(
    from defaults: UserDefaults,
    availableVoices: [NativeSpeechVoiceDescriptor]
) -> ReferenceSpeechState {
    ReferenceSpeechPreferences(defaults: defaults)
        .currentState(availableVoices: availableVoices)
}
