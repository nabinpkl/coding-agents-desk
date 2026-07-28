import InteractionPanel

/// Maps the macOS panel's local requests in-process. Voice transport requests
/// are ignored because the web bundle talks directly to the loopback sidecar.
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
        case .referenceAudioPlay, .referenceAudioStop,
             .voiceSocketOpen, .voiceSocketMessage, .voiceSocketClose, .voiceREST:
            break
        }
    }
}
