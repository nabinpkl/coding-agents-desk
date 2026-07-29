import Foundation

/// Requests the interaction webview posts to native. The owning surface routes
/// Space steps to input and voice traffic to the dedicated voice lane. The
/// package itself remains transport-agnostic.
public enum InteractionPanelRequest: Equatable, Sendable {
    case spaceStep(delta: Int)
    case referenceAudioPlay(artifactID: String, audioHash: String)
    case referenceAudioStop
    case voiceSocketOpen(requestID: String, recordingSessionID: String)
    case voiceSocketMessage(recordingSessionID: String, json: String)
    case voiceSocketClose(recordingSessionID: String)
    case voiceREST(InteractionVoiceRESTRequest)
    case dictationReady
    case dictationLayout(InteractionDictationPanelLayout)
    /// `message` carries the web mini's own failure text for an `.error`
    /// status. Without it a native shell can only log that dictation failed,
    /// never why.
    case dictationRunState(status: InteractionDictationRunStatus, message: String?)
    case dictationCommit(recordingID: String, transcript: String)

    public static func decode(tag: String, body: [String: Any]) -> InteractionPanelRequest? {
        switch tag {
        case "spaceStep":
            guard let delta = body["delta"] as? Int, delta == -1 || delta == 1 else {
                return nil
            }
            return .spaceStep(delta: delta)
        case "referenceAudioPlay":
            guard let artifactID = body["artifactID"] as? String,
                  artifactID.range(
                    of: #"^[0-9a-f]{64}$"#,
                    options: .regularExpression
                  ) != nil,
                  let audioHash = body["audioHash"] as? String,
                  audioHash.range(
                    of: #"^[0-9a-f]{64}$"#,
                    options: .regularExpression
                  ) != nil
            else { return nil }
            return .referenceAudioPlay(
                artifactID: artifactID,
                audioHash: audioHash
            )
        case "referenceAudioStop":
            return .referenceAudioStop
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
        case "dictationReady":
            return body.isEmpty ? .dictationReady : nil
        case "dictationLayout":
            guard body.count == 2,
                  let width = boundedPanelDimension(body["width"], in: 68 ... 560),
                  let height = boundedPanelDimension(body["height"], in: 68 ... 360)
            else { return nil }
            return .dictationLayout(.init(width: width, height: height))
        case "dictationRunState":
            guard Set(body.keys).isSubset(of: ["status", "message"]),
                  let rawStatus = body["status"] as? String,
                  let status = InteractionDictationRunStatus(rawValue: rawStatus)
            else { return nil }
            let message: String?
            if let rawMessage = body["message"] {
                guard let text = rawMessage as? String else { return nil }
                message = boundedRunStateMessage(text)
            } else {
                message = nil
            }
            return .dictationRunState(status: status, message: message)
        case "dictationCommit":
            guard body.count == 2,
                  let recordingID = body["recordingID"] as? String,
                  let transcript = body["transcript"] as? String,
                  isBoundedIdentifier(recordingID),
                  isBoundedTranscript(transcript)
            else { return nil }
            return .dictationCommit(
                recordingID: recordingID,
                transcript: transcript.trimmingCharacters(in: .whitespacesAndNewlines)
            )
        default:
            return nil
        }
    }

    private static func isBoundedIdentifier(_ value: String) -> Bool {
        value.range(
            of: #"^session-\d{8}-\d{6}-\d{6}$"#,
            options: .regularExpression
        ) != nil
    }

    private static func isBoundedTranscript(_ value: String) -> Bool {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && trimmed.utf8.count <= 32_768
    }

    /// Diagnostic text only. It is truncated rather than rejected so an
    /// overlong failure string never costs the shell the state change itself.
    private static func boundedRunStateMessage(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return String(trimmed.prefix(512))
    }

    private static func boundedPanelDimension(
        _ rawValue: Any?,
        in allowedRange: ClosedRange<Double>
    ) -> Double? {
        guard let number = rawValue as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID()
        else { return nil }
        let value = number.doubleValue
        guard value.isFinite, allowedRange.contains(value) else { return nil }
        return value
    }
}

public enum InteractionDictationRunStatus: String, Equatable, Sendable {
    case idle
    case requestingMic
    case capturing
    case saving
    case transcribing
    case analyzing
    case complete
    case error
}

/// The web mini measures its visible content and asks its macOS shell for this
/// bounded frame. It owns presentation only; capture state stays in the voice
/// session protocol.
public struct InteractionDictationPanelLayout: Equatable, Sendable {
    public let width: Double
    public let height: Double

    public init(width: Double, height: Double) {
        self.width = width
        self.height = height
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
