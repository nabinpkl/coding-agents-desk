import AVFoundation
import InteractionPanel

/// Maps the macOS panel's local requests in-process. Voice transport requests
/// are ignored because the web bundle talks directly to the loopback sidecar.
@MainActor
final class GesturePanelSpaceStepTransport: InteractionPanelTransport {
    private let onSpaceStep: (Int) -> Void
    private let referenceSpeechSynthesizer = AVSpeechSynthesizer()

    init(onSpaceStep: @escaping (Int) -> Void) {
        self.onSpaceStep = onSpaceStep
    }

    func sendInteractionRequest(_ request: InteractionPanelRequest) {
        switch request {
        case .spaceStep(let delta):
            onSpaceStep(delta)
        case .referenceSpeech(let text, let language):
            referenceSpeechSynthesizer.stopSpeaking(at: .immediate)
            let utterance = AVSpeechUtterance(string: text)
            utterance.voice = AVSpeechSynthesisVoice(language: language)
            referenceSpeechSynthesizer.speak(utterance)
        case .referenceSpeechStop:
            referenceSpeechSynthesizer.stopSpeaking(at: .immediate)
        case .voiceSocketOpen, .voiceSocketMessage, .voiceSocketClose, .voiceREST:
            break
        }
    }
}
