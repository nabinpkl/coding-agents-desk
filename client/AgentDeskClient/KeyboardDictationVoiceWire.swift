import Foundation
import KeyboardDictation

struct KeyboardVoiceSessionStart: Encodable {
    let type = "sessionStart"
}

struct KeyboardVoiceSessionStop: Encodable {
    let type = "sessionStop"
    let finalSequence: Int
    let capturedSampleCount: Int
}

struct KeyboardVoiceAudioFrame: Encodable {
    let type = "audioFrame"
    let sequence: Int
    let pcm: String
    let sampleCount: Int
    let sampleRate = 16_000
    let encoding = "float32"
    let channels = 1
}

struct KeyboardVoiceServerMessage: Decodable {
    struct Recording: Decodable {
        let id: String
        let machineTranscript: String?
        let clientSessionID: String?
    }

    let type: String
    let text: String?
    let rms: Float?
    let peak: Float?
    let stage: KeyboardDictationServicePhase?
    let code: String?
    let message: String?
    let recording: Recording?
}
