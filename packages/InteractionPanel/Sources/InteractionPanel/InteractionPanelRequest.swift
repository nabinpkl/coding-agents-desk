import Foundation

/// Requests the interaction webview posts to native. The owning surface routes
/// Space steps to input, reference speech to its local synthesizer, and voice
/// transport requests to the dedicated voice lane; the package itself remains
/// transport-agnostic.
public enum InteractionPanelRequest: Equatable, Sendable {
    public static let maximumReferenceSpeechUTF8Bytes = 20_000

    case spaceStep(delta: Int)
    case referenceSpeech(text: String, language: String)
    case referenceSpeechStop
    case voiceSocketOpen(requestID: String, recordingSessionID: String)
    case voiceSocketMessage(recordingSessionID: String, json: String)
    case voiceSocketClose(recordingSessionID: String)
    case voiceREST(InteractionVoiceRESTRequest)

    public static func decode(tag: String, body: [String: Any]) -> InteractionPanelRequest? {
        switch tag {
        case "spaceStep":
            guard let delta = body["delta"] as? Int, delta == -1 || delta == 1 else {
                return nil
            }
            return .spaceStep(delta: delta)
        case "referenceSpeech":
            guard let text = body["text"] as? String,
                  !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  text.utf8.count <= maximumReferenceSpeechUTF8Bytes,
                  let language = body["language"] as? String,
                  !language.isEmpty,
                  language.utf8.count <= 32
            else { return nil }
            return .referenceSpeech(text: text, language: language)
        case "referenceSpeechStop":
            return .referenceSpeechStop
        case "voiceSocketOpen":
            guard let requestID = body["requestID"] as? String,
                  let recordingSessionID = body["recordingSessionID"] as? String
            else { return nil }
            return .voiceSocketOpen(
                requestID: requestID,
                recordingSessionID: recordingSessionID
            )
        case "voiceSocketMessage":
            guard let recordingSessionID = body["recordingSessionID"] as? String,
                  let json = body["json"] as? String
            else { return nil }
            return .voiceSocketMessage(
                recordingSessionID: recordingSessionID,
                json: json
            )
        case "voiceSocketClose":
            guard let recordingSessionID = body["recordingSessionID"] as? String
            else { return nil }
            return .voiceSocketClose(recordingSessionID: recordingSessionID)
        case "voiceREST":
            guard let requestID = body["requestID"] as? String,
                  let method = body["method"] as? String,
                  let path = body["path"] as? String
            else { return nil }
            let requestBody: Data?
            if let encoded = body["bodyBase64"] as? String {
                guard let decoded = Data(base64Encoded: encoded) else { return nil }
                requestBody = decoded
            } else {
                requestBody = nil
            }
            return .voiceREST(InteractionVoiceRESTRequest(
                requestID: requestID,
                method: method,
                path: path,
                body: requestBody
            ))
        default:
            return nil
        }
    }
}

public struct InteractionVoiceRESTRequest: Equatable, Sendable {
    public let requestID: String
    public let method: String
    public let path: String
    public let body: Data?

    public init(requestID: String, method: String, path: String, body: Data?) {
        self.requestID = requestID
        self.method = method
        self.path = path
        self.body = body
    }
}

@MainActor
public protocol InteractionPanelTransport: AnyObject {
    func sendInteractionRequest(_ request: InteractionPanelRequest)
}
