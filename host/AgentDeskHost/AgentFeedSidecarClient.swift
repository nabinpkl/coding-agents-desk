import Foundation
import os

struct AgentFeedActivityBlock: Codable {
    let kind: String
    let label: String?
    let text: String?
    let tool: String?
    let summary: String?
    let preview: String?
    let callId: String?

    init(kind: String, label: String? = nil, text: String? = nil, tool: String? = nil, summary: String? = nil, preview: String? = nil, callId: String? = nil) {
        self.kind = kind
        self.label = label
        self.text = text
        self.tool = tool
        self.summary = summary
        self.preview = preview
        self.callId = callId
    }
}

struct AgentFeedActivityEvent: Codable {
    let index: Int
    let ts: Double
    let type: String
    let blocks: [AgentFeedActivityBlock]
}

struct AgentFeedEventsPage {
    let events: [AgentFeedActivityEvent]
    let total: Int
}

struct AgentFeedProjectSourceCounts: Codable {
    let claude: Int
    let codex: Int
}

struct AgentFeedProjectSummary: Codable {
    let projectPath: String
    let displayName: String
    let sourceCounts: AgentFeedProjectSourceCounts
    let sessionCount: Int
    let lastEventAt: Double
}

struct AgentFeedSessionSummary: Codable {
    let sessionId: String
    let source: String
    let title: String
    let lastEventAt: Double
    let activity: String
}

struct AgentFeedProjectsSnapshot: Codable {
    let projects: [AgentFeedProjectSummary]
}

struct AgentFeedSessionsSnapshot: Codable {
    let projectPath: String
    let sessions: [AgentFeedSessionSummary]
}

final class SidecarStreamHandle: @unchecked Sendable {
    private let task: Task<Void, Never>

    init(task: Task<Void, Never>) {
        self.task = task
    }

    func cancel() {
        task.cancel()
    }
}

protocol SidecarClient: Sendable {
    func fetchProjects() async throws -> AgentFeedProjectsSnapshot
    func fetchSessions(projectPath: String) async throws -> AgentFeedSessionsSnapshot
    func fetchEventsPage(source: String, sessionId: String, offset: Int, limit: Int) async throws -> AgentFeedEventsPage
    func fetchRawEvent(source: String, sessionId: String, eventIndex: Int) async throws -> String
    func openProjectsStream(
        onSnapshot: @escaping @Sendable (AgentFeedProjectsSnapshot) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> SidecarStreamHandle
    func openSessionsStream(
        projectPath: String,
        onSnapshot: @escaping @Sendable (AgentFeedSessionsSnapshot) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> SidecarStreamHandle
    func openEventStream(
        source: String,
        sessionId: String,
        after: Int,
        onEvent: @escaping @Sendable (AgentFeedActivityEvent) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> SidecarStreamHandle
}

final class HttpSidecarClient: SidecarClient, @unchecked Sendable {
    private let baseURLProvider: @Sendable () -> URL?
    private let session: URLSession
    private let logger: Logger

    init(baseURLProvider: @escaping @Sendable () -> URL?, session: URLSession = .shared) {
        self.baseURLProvider = baseURLProvider
        self.session = session
        self.logger = Logger(subsystem: Config.logSubsystem, category: "agent-feed-sidecar-client")
    }

    private func currentBaseURL() throws -> URL {
        guard let url = baseURLProvider() else { throw SidecarClientError.notReady }
        return url
    }

    private func requestURL(path: String, query: [URLQueryItem] = []) throws -> URL {
        var components = URLComponents(
            url: try currentBaseURL().appendingPathComponent(path),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = query.isEmpty ? nil : query
        guard let url = components?.url else { throw SidecarClientError.badURL }
        return url
    }

    private func fetchJSON<Value: Decodable>(_ type: Value.Type, url: URL) async throws -> Value {
        let (data, response) = try await session.data(from: url)
        try validateHTTP(response, url: url)
        return try JSONDecoder().decode(type, from: data)
    }

    func fetchProjects() async throws -> AgentFeedProjectsSnapshot {
        try await fetchJSON(
            AgentFeedProjectsSnapshot.self,
            url: requestURL(path: "/api/projects")
        )
    }

    func fetchSessions(projectPath: String) async throws -> AgentFeedSessionsSnapshot {
        try await fetchJSON(
            AgentFeedSessionsSnapshot.self,
            url: requestURL(
                path: "/api/sessions",
                query: [URLQueryItem(name: "projectPath", value: projectPath)]
            )
        )
    }

    func fetchEventsPage(source: String, sessionId: String, offset: Int, limit: Int) async throws -> AgentFeedEventsPage {
        struct Envelope: Decodable {
            let events: [AgentFeedActivityEvent]
            let total: Int
        }
        let envelope = try await fetchJSON(
            Envelope.self,
            url: requestURL(
                path: "/api/sessions/\(source)/\(sessionId)/events",
                query: [
                    URLQueryItem(name: "offset", value: String(offset)),
                    URLQueryItem(name: "limit", value: String(limit)),
                ]
            )
        )
        return AgentFeedEventsPage(events: envelope.events, total: envelope.total)
    }

    func fetchRawEvent(source: String, sessionId: String, eventIndex: Int) async throws -> String {
        let url = try requestURL(path: "/api/sessions/\(source)/\(sessionId)/events/\(eventIndex)/raw")
        let (data, response) = try await session.data(from: url)
        try validateHTTP(response, url: url)
        guard data.count <= 100 * 1024 * 1024 else {
            throw SidecarClientError.server("raw event exceeds 100 MiB")
        }
        guard let text = String(data: data, encoding: .utf8) else {
            throw SidecarClientError.server("raw event is not valid UTF-8 text")
        }
        return text
    }

    func openProjectsStream(
        onSnapshot: @escaping @Sendable (AgentFeedProjectsSnapshot) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> SidecarStreamHandle {
        openJSONStream(
            url: try? requestURL(path: "/api/projects/stream"),
            type: AgentFeedProjectsSnapshot.self,
            onValue: onSnapshot,
            onError: onError
        )
    }

    func openSessionsStream(
        projectPath: String,
        onSnapshot: @escaping @Sendable (AgentFeedSessionsSnapshot) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> SidecarStreamHandle {
        openJSONStream(
            url: try? requestURL(
                path: "/api/sessions/stream",
                query: [URLQueryItem(name: "projectPath", value: projectPath)]
            ),
            type: AgentFeedSessionsSnapshot.self,
            onValue: onSnapshot,
            onError: onError
        )
    }

    func openEventStream(
        source: String,
        sessionId: String,
        after: Int,
        onEvent: @escaping @Sendable (AgentFeedActivityEvent) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> SidecarStreamHandle {
        openJSONStream(
            url: try? requestURL(
                path: "/api/sessions/\(source)/\(sessionId)/stream",
                query: [URLQueryItem(name: "after", value: String(after))]
            ),
            type: AgentFeedActivityEvent.self,
            onValue: onEvent,
            onError: onError
        )
    }

    private func openJSONStream<Value: Decodable & Sendable>(
        url: URL?,
        type: Value.Type,
        onValue: @escaping @Sendable (Value) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> SidecarStreamHandle {
        guard let url else {
            return SidecarStreamHandle(task: Task { onError(SidecarClientError.notReady) })
        }
        let session = session
        let task = Task<Void, Never> {
            do {
                let (bytes, response) = try await session.bytes(from: url)
                guard let http = response as? HTTPURLResponse,
                      (200..<300).contains(http.statusCode) else {
                    onError(SidecarClientError.badStatusCode)
                    return
                }
                for try await line in bytes.lines {
                    guard !Task.isCancelled else { return }
                    guard line.hasPrefix("data:") else { continue }
                    let payload = String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
                    if payload.isEmpty { continue }
                    if payload == "\"shutdown\"" { return }
                    guard let data = payload.data(using: .utf8) else {
                        onError(SidecarClientError.server("stream emitted non-UTF-8 data"))
                        return
                    }
                    onValue(try JSONDecoder().decode(type, from: data))
                }
                if !Task.isCancelled {
                    onError(SidecarClientError.server("stream ended unexpectedly"))
                }
            } catch is CancellationError {
                return
            } catch {
                if !Task.isCancelled { onError(error) }
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

enum SidecarClientError: LocalizedError, Equatable {
    case badURL
    case badStatusCode
    case notReady
    case server(String)

    var errorDescription: String? {
        switch self {
        case .badURL: "invalid sidecar URL"
        case .badStatusCode: "sidecar returned an unsuccessful response"
        case .notReady: "agent feed is not ready"
        case .server(let message): message
        }
    }
}
