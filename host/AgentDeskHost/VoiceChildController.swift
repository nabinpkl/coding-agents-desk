import Foundation
import os

enum VoiceChildControllerError: Error, Equatable {
    case malformedJSON
    case unsupportedType(String)
    case missingID
    case childUnavailable
    case childError(String)
    case emptyTranscript
}

struct VoiceChildMessage: Decodable, Equatable {
    let type: String
    let protocolVersion: Int?
    let name: String?
    let id: String?
    let text: String?
    let message: String?

    enum CodingKeys: String, CodingKey {
        case type
        case protocolVersion = "protocol"
        case name
        case id
        case text
        case message
    }
}

final class VoiceChildController: @unchecked Sendable {
    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "voice-child")
    private let executableURL: URL
    private let arguments: [String]
    private let model: String
    private let maxLineBytes: Int
    private let pendingQueue = DispatchQueue(label: "com.example.agentdesk.AgentDeskHost.voice-child.pending")
    private var pending: [String: CheckedContinuation<String, Error>] = [:]
    private var childProcess: JsonlChildProcess?

    init(
        executableURL: URL,
        arguments: [String] = [],
        model: String = Config.transcriptionModel,
        maxLineBytes: Int = 64 * 1024
    ) {
        self.executableURL = executableURL
        self.arguments = arguments
        self.model = model
        self.maxLineBytes = maxLineBytes
    }

    deinit {
        stop()
    }

    func start() {
        guard childProcess == nil else { return }
        let childProcess = JsonlChildProcess(
            executableURL: executableURL,
            arguments: arguments,
            category: "voice-child",
            maxLineBytes: maxLineBytes,
            onLine: { [weak self] line in
                self?.handleLine(line)
            },
            onTermination: { [weak self] _ in
                self?.failAllPending(VoiceChildControllerError.childUnavailable)
                self?.childProcess = nil
            }
        )
        self.childProcess = childProcess
        childProcess.start()
    }

    func stop() {
        failAllPending(VoiceChildControllerError.childUnavailable)
        childProcess?.stop()
        childProcess = nil
    }

    func transcribe(wav: Data) async throws -> String {
        if childProcess == nil {
            start()
        }
        guard let childProcess else {
            throw VoiceChildControllerError.childUnavailable
        }

        let requestID = UUID().uuidString
        return try await withCheckedThrowingContinuation { continuation in
            setPending(continuation, for: requestID)
            do {
                try childProcess.sendJSONObject([
                    "type": "transcribe",
                    "id": requestID,
                    "model": model,
                    "audioFormat": "wav",
                    "audioBase64": wav.base64EncodedString()
                ])
            } catch {
                let pending = removePending(for: requestID)
                pending?.resume(throwing: error)
            }
        }
    }

    func receiveStdout(_ data: Data) {
        if childProcess == nil {
            childProcess = JsonlChildProcess(
                executableURL: executableURL,
                arguments: arguments,
                category: "voice-child",
                maxLineBytes: maxLineBytes,
                onLine: { [weak self] line in
                    self?.handleLine(line)
                }
            )
        }
        childProcess?.receiveStdout(data)
    }

    func handleLine(_ line: String) {
        do {
            let message = try Self.decodeMessage(from: line)
            switch message.type {
            case "hello", "ready":
                return
            case "transcript":
                let transcript = try Self.transcript(from: message)
                guard let pending = removePending(for: transcript.id) else {
                    logger.notice("dropping transcript for unknown request id=\(transcript.id, privacy: .public)")
                    return
                }
                pending.resume(returning: transcript.text)
            case "error":
                guard let id = message.id else {
                    logger.error("voice child error without request id: \(message.message ?? "", privacy: .public)")
                    return
                }
                let error = VoiceChildControllerError.childError(message.message ?? "voice child error")
                removePending(for: id)?.resume(throwing: error)
            default:
                throw VoiceChildControllerError.unsupportedType(message.type)
            }
        } catch {
            logger.error("dropping voice child message: \(String(describing: error), privacy: .public)")
        }
    }

    static func decodeMessage(from line: String) throws -> VoiceChildMessage {
        guard let data = line.data(using: .utf8),
              let message = try? JSONDecoder().decode(VoiceChildMessage.self, from: data)
        else {
            throw VoiceChildControllerError.malformedJSON
        }
        return message
    }

    static func transcript(from line: String) throws -> (id: String, text: String)? {
        let message = try decodeMessage(from: line)
        guard message.type == "transcript" else { return nil }
        return try transcript(from: message)
    }

    static func transcript(from message: VoiceChildMessage) throws -> (id: String, text: String) {
        guard let id = message.id else {
            throw VoiceChildControllerError.missingID
        }
        let text = (message.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            throw VoiceChildControllerError.emptyTranscript
        }
        return (id, text)
    }

    private func setPending(_ continuation: CheckedContinuation<String, Error>, for requestID: String) {
        pendingQueue.sync {
            pending[requestID] = continuation
        }
    }

    private func removePending(for requestID: String) -> CheckedContinuation<String, Error>? {
        pendingQueue.sync {
            pending.removeValue(forKey: requestID)
        }
    }

    private func failAllPending(_ error: Error) {
        let continuations = pendingQueue.sync {
            let continuations = Array(pending.values)
            pending.removeAll()
            return continuations
        }
        for continuation in continuations {
            continuation.resume(throwing: error)
        }
    }
}
