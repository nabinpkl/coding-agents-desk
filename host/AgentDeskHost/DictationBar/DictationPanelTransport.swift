import InteractionPanel

/// Routes the mini webview's deliberately narrow contract into the macOS
/// window shell. Direct loopback voice WebSocket traffic never crosses this
/// bridge; only panel state and the final persisted transcript do.
@MainActor
final class DictationPanelTransport: InteractionPanelTransport {
    var onReady: (() -> Void)?
    var onLayout: ((InteractionDictationPanelLayout) -> Void)?
    var onRunState: ((InteractionDictationRunStatus, String?) -> Void)?
    var onCommit: ((String, String) -> Void)?

    func sendInteractionRequest(_ request: InteractionPanelRequest) {
        switch request {
        case .dictationReady:
            onReady?()
        case .dictationLayout(let layout):
            onLayout?(layout)
        case .dictationRunState(let status, let message):
            onRunState?(status, message)
        case .dictationCommit(let recordingID, let transcript):
            onCommit?(recordingID, transcript)
        case .spaceStep, .referenceAudioPlay, .referenceAudioStop,
             .voiceSocketOpen, .voiceSocketMessage, .voiceSocketClose, .voiceREST:
            break
        }
    }
}
