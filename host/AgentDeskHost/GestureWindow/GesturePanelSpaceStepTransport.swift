import InteractionPanel

/// Maps the macOS panel's Space requests in-process. Voice requests are ignored
/// here because the macOS web bundle talks directly to the loopback sidecar;
/// only the iOS panel translates them onto the authenticated voice lane.
@MainActor
final class GesturePanelSpaceStepTransport: InteractionPanelTransport {
    private let onSpaceStep: (Int) -> Void

    init(onSpaceStep: @escaping (Int) -> Void) {
        self.onSpaceStep = onSpaceStep
    }

    func sendInteractionRequest(_ request: InteractionPanelRequest) {
        switch request {
        case .spaceStep(let delta):
            onSpaceStep(delta)
        case .voiceSocketOpen, .voiceSocketMessage, .voiceSocketClose, .voiceREST:
            break
        }
    }
}
