import Foundation
import Testing

@testable import AgentDeskHost

// Scroll-quality wire shape and profile derivation. The transport's live
// sender mutation can't be unit-tested without WebRTC, so the testable
// surface is the pure profile derivation on SenderTuning and the
// InteractionHint frame the client sends.
struct ScrollQualityTests {
    @Test func scrollProfileDropsResolutionAndPrioritizesFramerate() {
        let tuning = SenderTuning.default
        let scroll = tuning.scrollProfile
        #expect(scroll.scaleResolutionDownBy == tuning.scrollScaleDownBy)
        #expect(scroll.scaleResolutionDownBy > 1.0)
        #expect(scroll.maxFramerate == tuning.scrollMaxFramerate)
        #expect(scroll.degradation == .maintainFramerate)
    }

    @Test func crispProfileRestoresFullResolutionAndBaseValues() {
        let tuning = SenderTuning.default
        let crisp = tuning.crispProfile
        #expect(crisp.scaleResolutionDownBy == 1.0)
        #expect(crisp.maxFramerate == tuning.maxFramerate)
        #expect(crisp.degradation == tuning.degradationPreference)
    }

    @Test func interactionHintRoundTripsWithCompactKeys() throws {
        let hint = InteractionHint(kind: "scroll", active: true)
        let data = try JSONEncoder().encode(hint)
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        #expect(object?["t"] as? String == "interaction-hint")
        #expect(object?["k"] as? String == "scroll")
        #expect(object?["a"] as? Bool == true)
        let decoded = try JSONDecoder().decode(InteractionHint.self, from: data)
        #expect(decoded == hint)
    }
}
