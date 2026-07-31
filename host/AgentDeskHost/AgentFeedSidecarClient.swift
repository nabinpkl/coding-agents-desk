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

/// Latest context-window occupancy for a session. `limit` arrives already resolved by the sidecar
/// (Codex publishes it, Claude's comes from the sidecar's model table), so nothing on this side holds
/// model knowledge; nil means the sidecar has no window for the model and the panel shows a bare
/// count rather than a guessed fraction.
struct AgentFeedTokenUsage: Codable {
    let current: Int
    let limit: Int?
    let updatedAt: Double
    let model: String?
}

struct AgentFeedActivityEvent: Codable {
    let index: Int
    let ts: Double
    let type: String
    let blocks: [AgentFeedActivityBlock]
    /// Position of the same line in the other mode, or nil when it has none. See the wire
    /// `ActivityEvent.otherModeIndex`.
    let otherModeIndex: Int?
    /// Occupancy as of this event. Session state, not event state: it rides the per-event stream
    /// message because that stream already fires once per event, so the meter goes live without a
    /// message type of its own.
    let usage: AgentFeedTokenUsage?

    init(
        index: Int,
        ts: Double,
        type: String,
        blocks: [AgentFeedActivityBlock],
        otherModeIndex: Int? = nil,
        usage: AgentFeedTokenUsage? = nil
    ) {
        self.index = index
        self.ts = ts
        self.type = type
        self.blocks = blocks
        self.otherModeIndex = otherModeIndex
        self.usage = usage
    }
}

struct AgentFeedEventsPage {
    let events: [AgentFeedActivityEvent]
    let total: Int
    let usage: AgentFeedTokenUsage?

    init(events: [AgentFeedActivityEvent], total: Int, usage: AgentFeedTokenUsage? = nil) {
        self.events = events
        self.total = total
        self.usage = usage
    }
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

/// Which view of a transcript a sidecar call addresses. Event indices are mode-relative, so this
/// travels with every call that names one.
enum AgentFeedEventMode: String, Sendable {
    case raw
    case nice
}

protocol SidecarClient: Sendable {
    func fetchProjects() async throws -> AgentFeedProjectsSnapshot
    func fetchSessions(projectPath: String) async throws -> AgentFeedSessionsSnapshot
    func fetchEventsPage(
        source: String,
        sessionId: String,
        offset: Int,
        limit: Int,
        mode: AgentFeedEventMode
    ) async throws -> AgentFeedEventsPage
    func fetchRawEvent(
        source: String,
        sessionId: String,
        eventIndex: Int,
        mode: AgentFeedEventMode
    ) async throws -> String
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
        mode: AgentFeedEventMode,
        onEvent: @escaping @Sendable (AgentFeedActivityEvent) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> SidecarStreamHandle
}

final class HttpSidecarClient: SidecarClient, @unchecked Sendable {
    // Resolves the sidecar's base URL, waiting for a sidecar that is still coming
    // up rather than answering nil the instant it is asked.
    //
    // This is async for one reason: the host brings the sidecar up in parallel
    // with the windows that read it, so a consumer can and does arrive first. A
    // synchronous provider turns that ordinary one-second overlap into a hard
    // failure that never heals, because a stream that reports an error is torn
    // down and nothing re-subscribes. Awaiting readiness is what makes arriving
    // early cost latency instead of the whole session.
    private let baseURLProvider: @Sendable () async -> URL?
    private let session: URLSession
    private let logger: Logger

    init(baseURLProvider: @escaping @Sendable () async -> URL?, session: URLSession = .shared) {
        self.baseURLProvider = baseURLProvider
        self.session = session
        self.logger = Logger(subsystem: Config.logSubsystem, category: "agent-feed-sidecar-client")
    }

    private func currentBaseURL() async throws -> URL {
        guard let url = await baseURLProvider() else { throw SidecarClientError.notReady }
        return url
    }

    private func requestURL(path: String, query: [URLQueryItem] = []) async throws -> URL {
        var components = URLComponents(
            url: try await currentBaseURL().appendingPathComponent(path),
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
            url: await requestURL(path: "/api/projects")
        )
    }

    func fetchSessions(projectPath: String) async throws -> AgentFeedSessionsSnapshot {
        try await fetchJSON(
            AgentFeedSessionsSnapshot.self,
            url: await requestURL(
                path: "/api/sessions",
                query: [URLQueryItem(name: "projectPath", value: projectPath)]
            )
        )
    }

    func fetchEventsPage(
        source: String,
        sessionId: String,
        offset: Int,
        limit: Int,
        mode: AgentFeedEventMode
    ) async throws -> AgentFeedEventsPage {
        struct Envelope: Decodable {
            let events: [AgentFeedActivityEvent]
            let total: Int
            let usage: AgentFeedTokenUsage?
        }
        let envelope = try await fetchJSON(
            Envelope.self,
            url: await requestURL(
                path: "/api/sessions/\(source)/\(sessionId)/events",
                query: [
                    URLQueryItem(name: "offset", value: String(offset)),
                    URLQueryItem(name: "limit", value: String(limit)),
                    URLQueryItem(name: "mode", value: mode.rawValue),
                ]
            )
        )
        return AgentFeedEventsPage(
            events: envelope.events,
            total: envelope.total,
            usage: envelope.usage
        )
    }

    func fetchRawEvent(
        source: String,
        sessionId: String,
        eventIndex: Int,
        mode: AgentFeedEventMode
    ) async throws -> String {
        let url = try await requestURL(
            path: "/api/sessions/\(source)/\(sessionId)/events/\(eventIndex)/raw",
            query: [URLQueryItem(name: "mode", value: mode.rawValue)]
        )
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
            url: { try await self.requestURL(path: "/api/projects/stream") },
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
            url: {
                try await self.requestURL(
                    path: "/api/sessions/stream",
                    query: [URLQueryItem(name: "projectPath", value: projectPath)]
                )
            },
            type: AgentFeedSessionsSnapshot.self,
            onValue: onSnapshot,
            onError: onError
        )
    }

    func openEventStream(
        source: String,
        sessionId: String,
        after: Int,
        mode: AgentFeedEventMode,
        onEvent: @escaping @Sendable (AgentFeedActivityEvent) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> SidecarStreamHandle {
        openJSONStream(
            url: {
                try await self.requestURL(
                    path: "/api/sessions/\(source)/\(sessionId)/stream",
                    query: [
                        URLQueryItem(name: "after", value: String(after)),
                        URLQueryItem(name: "mode", value: mode.rawValue),
                    ]
                )
            },
            type: AgentFeedActivityEvent.self,
            onValue: onEvent,
            onError: onError
        )
    }

    // `url` is resolved inside the task, not by the caller, because resolving it
    // may mean waiting for a sidecar that is still starting. Opening a stream
    // stays synchronous -- the caller gets a cancellable handle immediately -- and
    // the wait costs the first snapshot some latency instead of costing the
    // subscription its life.
    private func openJSONStream<Value: Decodable & Sendable>(
        url: @escaping @Sendable () async throws -> URL,
        type: Value.Type,
        onValue: @escaping @Sendable (Value) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> SidecarStreamHandle {
        let session = session
        let task = Task<Void, Never> {
            do {
                let resolved = try await url()
                guard !Task.isCancelled else { return }
                let (bytes, response) = try await session.bytes(from: resolved)
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
