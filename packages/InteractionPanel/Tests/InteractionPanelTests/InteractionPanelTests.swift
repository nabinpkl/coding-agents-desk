import Foundation
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

    @Test func decodesBoundedReferenceAudioRequests() {
        let artifactID = String(repeating: "a", count: 64)
        let audioHash = String(repeating: "b", count: 64)
        #expect(
            InteractionPanelRequest.decode(
                tag: "referenceAudioPlay",
                body: ["artifactID": artifactID, "audioHash": audioHash]
            ) == .referenceAudioPlay(
                artifactID: artifactID,
                audioHash: audioHash
            )
        )
        #expect(
            InteractionPanelRequest.decode(
                tag: "referenceAudioPlay",
                body: [
                    "artifactID": "not-a-hash",
                    "audioHash": audioHash,
                ]
            ) == nil
        )
        #expect(
            InteractionPanelRequest.decode(
                tag: "referenceAudioPlay",
                body: [
                    "artifactID": artifactID,
                    "audioHash": "not-a-hash",
                ]
            ) == nil
        )
        #expect(
            InteractionPanelRequest.decode(tag: "referenceAudioStop", body: [:])
                == .referenceAudioStop
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

    @Test func dictationContractUsesDedicatedEntry() {
        #expect(WebPanelContract.dictation.scheme == "interactionfeed")
        #expect(WebPanelContract.dictation.messageHandlerName == "interaction")
        #expect(
            WebPanelContract.dictation.indexRequestURL?.absoluteString
                == "interactionfeed://app/dictation.html"
        )
    }

    @Test func decodesStrictDictationRequests() {
        #expect(
            InteractionPanelRequest.decode(tag: "dictationReady", body: [:])
                == .dictationReady
        )
        #expect(
            InteractionPanelRequest.decode(
                tag: "dictationLayout",
                body: ["width": 480, "height": 156]
            ) == .dictationLayout(.init(width: 480, height: 156))
        )
        #expect(
            InteractionPanelRequest.decode(
                tag: "dictationRunState",
                body: ["status": "transcribing"]
            ) == .dictationRunState(status: .transcribing, message: nil)
        )
        #expect(
            InteractionPanelRequest.decode(
                tag: "dictationRunState",
                body: ["status": "error", "message": "  microphone denied  "]
            ) == .dictationRunState(status: .error, message: "microphone denied")
        )
        #expect(
            InteractionPanelRequest.decode(
                tag: "dictationRunState",
                body: ["status": "error", "message": "   "]
            ) == .dictationRunState(status: .error, message: nil)
        )
        #expect(
            InteractionPanelRequest.decode(
                tag: "dictationRunState",
                body: ["status": "error", "message": String(repeating: "x", count: 600)]
            ) == .dictationRunState(
                status: .error,
                message: String(repeating: "x", count: 512)
            )
        )
        #expect(
            InteractionPanelRequest.decode(
                tag: "dictationCommit",
                body: [
                    "recordingID": "session-20260727-123456-000001",
                    "transcript": "  Hello world.  ",
                ]
            ) == .dictationCommit(
                recordingID: "session-20260727-123456-000001",
                transcript: "Hello world."
            )
        )
        #expect(InteractionPanelRequest.decode(tag: "dictationReady", body: ["x": true]) == nil)
        #expect(InteractionPanelRequest.decode(tag: "dictationLayout", body: [:]) == nil)
        #expect(
            InteractionPanelRequest.decode(
                tag: "dictationLayout",
                body: ["width": 480, "height": 156, "unexpected": true]
            ) == nil
        )
        #expect(
            InteractionPanelRequest.decode(
                tag: "dictationLayout",
                body: ["width": 480, "height": 361]
            ) == nil
        )
        #expect(
            InteractionPanelRequest.decode(
                tag: "dictationLayout",
                body: ["width": true, "height": 156]
            ) == nil
        )
        #expect(InteractionPanelRequest.decode(tag: "dictationRunState", body: ["status": "bad"]) == nil)
        #expect(
            InteractionPanelRequest.decode(
                tag: "dictationRunState",
                body: ["status": "error", "message": 7]
            ) == nil
        )
        #expect(
            InteractionPanelRequest.decode(
                tag: "dictationRunState",
                body: ["status": "error", "extra": "x"]
            ) == nil
        )
        #expect(
            InteractionPanelRequest.decode(
                tag: "dictationCommit",
                body: ["recordingID": "bad/id", "transcript": "hello"]
            ) == nil
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

    @Test func bundledDictationOrCleanBuildFixtureResolves() throws {
        let locator = WebPanelResourceLocator(
            bundle: .module,
            webviewDirectoryName: InteractionPanelResources.webviewDirectoryName,
            fixtureDirectoryName: InteractionPanelResources.fixtureDirectoryName,
            indexPath: WebPanelContract.dictation.indexPath
        )
        let root = try #require(locator.rootDirectory())
        let index = try #require(locator.indexURL())
        let html = String(decoding: try Data(contentsOf: index), as: UTF8.self)
        if root.lastPathComponent == "InteractionPanelWebview" {
            #expect(html.contains(#"<div id="root"></div>"#))
        } else {
            #expect(root.lastPathComponent == "InteractionPanelFixture")
            #expect(html.contains("Dictation fixture"))
        }
    }
}
