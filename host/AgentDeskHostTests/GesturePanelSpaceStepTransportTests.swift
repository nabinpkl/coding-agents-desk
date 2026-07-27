import Foundation
import InteractionPanel
import Testing

@testable import AgentDeskHost

@MainActor
struct GesturePanelSpaceStepTransportTests {
    @Test func referenceSpeechStateAndPreferenceUpdatesStayLocal() throws {
        let suite = "gesture-reference-speech-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = ReferenceSpeechPreferences(defaults: defaults)
        let transport = GesturePanelSpaceStepTransport(
            onSpaceStep: { _ in },
            referenceSpeechPreferences: preferences
        )
        var delivered: ReferenceSpeechState?
        transport.onReferenceSpeechState = { delivered = $0 }

        transport.sendInteractionRequest(.referenceSpeechStateRequest)

        #expect(delivered?.language == "en-US")
        #expect(delivered?.rate.current == 0.5)

        transport.sendInteractionRequest(
            .referenceSpeechPreferencesUpdate(
                voiceIdentifier: nil,
                rate: 0.65
            )
        )

        #expect(delivered?.selectedVoiceIdentifier == nil)
        #expect(delivered?.rate.current == 0.65)
        #expect(
            ReferenceSpeechPreferences(defaults: defaults)
                .currentState()
                .rate.current == 0.65
        )
    }
}
