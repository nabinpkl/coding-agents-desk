import InteractionPanel

/// Maps the gesture webview's requests onto the host's Space-step handler. The
/// only case today is `spaceStep`, so this collapses to a single call — no
/// bridge and no sidecar (unlike AgentPanel). On macOS the delta is applied
/// in-process; the same `InteractionPanelRequest` is carried over QUIC on iOS.
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
        }
    }
}
