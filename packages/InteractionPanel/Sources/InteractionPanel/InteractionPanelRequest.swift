import Foundation

/// Requests the interaction webview posts to native. The owning surface routes
/// Space steps to the input lane and voice requests to the dedicated voice
/// lane; the package itself remains transport-agnostic.
public enum InteractionPanelRequest: Equatable, Sendable {
    case spaceStep(delta: Int)
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
