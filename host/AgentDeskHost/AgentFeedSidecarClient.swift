import Foundation
import os

// Ingestion DTOs: decode sidecar JSON verbatim. The sidecar uses the field
// name "type" for the event kind; the wire ActivityEvent uses CodingKey "tp".
// These separate structs bridge the two without touching the wire types.

struct EngineActivityBlock: Codable {
    let kind: String
    let text: String?
}

struct EngineActivityEvent: Codable {
    let index: Int
    let ts: Double
    let type: String
    let blocks: [EngineActivityBlock]
}

struct EngineEventsPage {
    let events: [EngineActivityEvent]
    let total: Int
}

struct EngineProjectPrimary: Codable {
    let sessionId: String
    let source: String
    let project: String
    let projectName: String
    let firstPrompt: String?
    let lastUserPrompt: String?

    enum CodingKeys: String, CodingKey {
        case sessionId
        case source
        case project
        case projectName
        case firstPrompt
        case lastUserPrompt
    }
}

struct EngineProjectDigest: Codable {
    let project: String
    let projectName: String
    let source: String
    let sources: [String]
    let observed: Double?
    let lastEventAt: Double?
    let bin: String?
    let primary: EngineProjectPrimary?
}

// A live SSE stream handle. Cancellation stops the background task.
final class SidecarStreamHandle: @unchecked Sendable {
    private let task: Task<Void, Never>

    init(task: Task<Void, Never>) {
        self.task = task
    }

    func cancel() {
        task.cancel()
    }
}

// Injectable seam for the sidecar HTTP/SSE surface.
protocol SidecarClient: Sendable {
    func fetchDigest() async throws -> [EngineProjectDigest]
    func fetchEventsPage(sessionId: String, offset: Int, limit: Int) async throws -> EngineEventsPage
    func openEventStream(
        sessionId: String,
        after: Int,
        onEvent: @escaping @Sendable (EngineActivityEvent) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> SidecarStreamHandle
}

// Real implementation over URLSession.
final class HttpSidecarClient: SidecarClient, @unchecked Sendable {
    private let baseURL: URL
    private let session: URLSession
    private let logger: Logger

    init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
        self.logger = Logger(subsystem: Config.launchAgentLabel, category: "agent-feed-sidecar-client")
    }

    func fetchDigest() async throws -> [EngineProjectDigest] {
        let url = baseURL.appendingPathComponent("/api/projects/digest")
        let (data, response) = try await session.data(from: url)
        try validateHTTP(response, url: url)
        struct Envelope: Decodable {
            let projects: [EngineProjectDigest]
        }
        let envelope = try JSONDecoder().decode(Envelope.self, from: data)
        return envelope.projects
    }

    func fetchEventsPage(sessionId: String, offset: Int, limit: Int) async throws -> EngineEventsPage {
        var components = URLComponents(
            url: baseURL.appendingPathComponent("/api/sessions/\(sessionId)/events"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [
            URLQueryItem(name: "offset", value: String(offset)),
            URLQueryItem(name: "limit", value: String(limit)),
        ]
        guard let url = components?.url else {
            throw SidecarClientError.badURL
        }
        let (data, response) = try await session.data(from: url)
        try validateHTTP(response, url: url)
        struct Envelope: Decodable {
            let events: [EngineActivityEvent]
            let total: Int
        }
        let envelope = try JSONDecoder().decode(Envelope.self, from: data)
        return EngineEventsPage(events: envelope.events, total: envelope.total)
    }

    func openEventStream(
        sessionId: String,
        after: Int,
        onEvent: @escaping @Sendable (EngineActivityEvent) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> SidecarStreamHandle {
        var components = URLComponents(
            url: baseURL.appendingPathComponent("/api/sessions/\(sessionId)/stream"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [URLQueryItem(name: "after", value: String(after))]
        let url = components?.url ?? baseURL.appendingPathComponent("/api/sessions/\(sessionId)/stream")
        let logger = logger
        let task = Task<Void, Never> {
            do {
                let (asyncBytes, response) = try await URLSession.shared.bytes(from: url)
                guard let httpResponse = response as? HTTPURLResponse,
                      (200..<300).contains(httpResponse.statusCode) else {
                    onError(SidecarClientError.badStatusCode)
                    return
                }
                var dataBuffer = ""
                for try await line in asyncBytes.lines {
                    guard !Task.isCancelled else { return }
                    if line.hasPrefix("data:") {
                        let jsonString = String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
                        if jsonString.isEmpty { continue }
                        dataBuffer = jsonString
                        if let data = dataBuffer.data(using: .utf8),
                           let event = try? JSONDecoder().decode(EngineActivityEvent.self, from: data) {
                            onEvent(event)
                        } else {
                            logger.error("agent-feed-stream: failed to decode SSE event json=\(jsonString, privacy: .public)")
                        }
                        dataBuffer = ""
                    }
                }
            } catch is CancellationError {
                // normal cancellation
            } catch {
                guard !Task.isCancelled else { return }
                onError(error)
            }
        }
        return SidecarStreamHandle(task: task)
    }

    private func validateHTTP(_ response: URLResponse, url: URL) throws {
        guard let http = response as? HTTPURLResponse else {
            throw SidecarClientError.badStatusCode
        }
        guard (200..<300).contains(http.statusCode) else {
            logger.error("sidecar HTTP \(http.statusCode, privacy: .public) url=\(url.absoluteString, privacy: .public)")
            throw SidecarClientError.badStatusCode
        }
    }
}

enum SidecarClientError: Error, Equatable {
    case badURL
    case badStatusCode
}
