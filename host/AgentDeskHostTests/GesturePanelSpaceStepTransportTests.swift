import InteractionPanel
import Testing

@testable import AgentDeskHost

@MainActor
struct GesturePanelSpaceStepTransportTests {
    @Test func onlySpaceStepsCrossTheMacNativeSeam() {
        var received: [Int] = []
        let transport = GesturePanelSpaceStepTransport {
            received.append($0)
        }
        transport.sendInteractionRequest(.referenceAudioStop)
        transport.sendInteractionRequest(
            .referenceAudioPlay(
                artifactID: String(repeating: "a", count: 64),
                audioHash: String(repeating: "b", count: 64)
            )
        )
        transport.sendInteractionRequest(.spaceStep(delta: -1))
        #expect(received == [-1])
    }
}
