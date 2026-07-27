import AVFoundation
import InteractionPanel

/// Maps the macOS panel's local requests in-process. Voice transport requests
/// are ignored because the web bundle talks directly to the loopback sidecar.
@MainActor
final class GesturePanelSpaceStepTransport: InteractionPanelTransport {
    private let onSpaceStep: (Int) -> Void
    private let referenceSpeechSynthesizer = AVSpeechSynthesizer()
    private let referenceSpeechPreferences: ReferenceSpeechPreferences
    var onReferenceSpeechState: ((ReferenceSpeechState) -> Void)?

    init(
        onSpaceStep: @escaping (Int) -> Void,
        referenceSpeechPreferences: ReferenceSpeechPreferences = ReferenceSpeechPreferences()
    ) {
        self.onSpaceStep = onSpaceStep
        self.referenceSpeechPreferences = referenceSpeechPreferences
    }

    func sendInteractionRequest(_ request: InteractionPanelRequest) {
        switch request {
        case .spaceStep(let delta):
            onSpaceStep(delta)
        case .referenceSpeech(let text, _):
            referenceSpeechSynthesizer.stopSpeaking(at: .immediate)
            let utterance = AVSpeechUtterance(string: text)
            referenceSpeechPreferences.configure(utterance)
            referenceSpeechSynthesizer.speak(utterance)
        case .referenceSpeechStop:
            referenceSpeechSynthesizer.stopSpeaking(at: .immediate)
        case .referenceSpeechStateRequest:
            onReferenceSpeechState?(referenceSpeechPreferences.currentState())
        case .referenceSpeechPreferencesUpdate(let voiceIdentifier, let rate):
            referenceSpeechSynthesizer.stopSpeaking(at: .immediate)
            do {
                onReferenceSpeechState?(try referenceSpeechPreferences.update(
                    voiceIdentifier: voiceIdentifier,
                    rate: rate
                ))
            } catch {
                onReferenceSpeechState?(
                    referenceSpeechPreferences.currentState(
                        error: error.localizedDescription
                    )
                )
            }
        case .voiceSocketOpen, .voiceSocketMessage, .voiceSocketClose, .voiceREST:
            break
        }
    }
}
