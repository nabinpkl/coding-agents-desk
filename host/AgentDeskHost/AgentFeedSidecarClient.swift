import Foundation
import os
import AgentDeskWire

struct AgentFeedSidecarEndpoint: Sendable {
    let baseURL: URL
    let controlToken: String
}

struct AgentFeedActivityBlock: Codable {
    let kind: String
    let label: String?
    let text: String?
    let tool: String?
    let summary: String?
    let preview: String?
    let callId: String?
    let input: [String: AgentJSONValue]?
    let hiddenChars: Int?
    let hiddenLines: Int?

    init(kind: String, label: String? = nil, text: String? = nil, tool: String? = nil, summary: String? = nil, preview: String? = nil, callId: String? = nil, input: [String: AgentJSONValue]? = nil, hiddenChars: Int? = nil, hiddenLines: Int? = nil) {
        self.kind = kind
        self.label = label
        self.text = text
        self.tool = tool
        self.summary = summary
        self.preview = preview
        self.callId = callId
        self.input = input
        self.hiddenChars = hiddenChars
        self.hiddenLines = hiddenLines
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
    let id: String
    let index: Int
    let revision: Int
    let phase: String
    let ts: Double
    let type: String
    let blocks: [AgentFeedActivityBlock]
    /// Position of the same line in the other mode, or nil when it has none. See the wire
    /// `ActivityEvent.otherModeIndex`.
    let otherModeIndex: Int?
    /// Stable Anthropic message id, shared with the live mirror for handoff.
    let messageId: String?
    /// Occupancy as of this event. Session state, not event state: it rides the per-event stream
    /// message because that stream already fires once per event, so the meter goes live without a
    /// message type of its own.
    let usage: AgentFeedTokenUsage?

    init(
        id: String,
        index: Int,
        revision: Int,
        phase: String,
        ts: Double,
        type: String,
        blocks: [AgentFeedActivityBlock],
        otherModeIndex: Int? = nil,
        messageId: String? = nil,
        usage: AgentFeedTokenUsage? = nil
    ) {
        self.id = id
        self.index = index
        self.revision = revision
        self.phase = phase
        self.ts = ts
        self.type = type
        self.blocks = blocks
        self.otherModeIndex = otherModeIndex
        self.messageId = messageId
        self.usage = usage
    }
}

struct AgentFeedEventsPage {
    let events: [AgentFeedActivityEvent]
    let total: Int
    let usage: AgentFeedTokenUsage?
    let sequence: Int
    let runState: String
    let queueSteer: Int
    let queueFollowUp: Int

    init(events: [AgentFeedActivityEvent], total: Int, usage: AgentFeedTokenUsage? = nil, sequence: Int = 0, runState: String = "idle", queueSteer: Int = 0, queueFollowUp: Int = 0) {
        self.events = events
        self.total = total
        self.usage = usage
        self.sequence = sequence
        self.runState = runState
        self.queueSteer = queueSteer
        self.queueFollowUp = queueFollowUp
    }
}

struct AgentFeedProjectSourceCounts: Codable {
    let values: [String: Int]

    init(values: [String: Int]) {
        self.values = values
    }

    init(from decoder: Decoder) throws {
        values = try decoder.singleValueContainer().decode([String: Int].self)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(values)
    }
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
    let capabilities: AgentFeedSessionCapabilities
}

struct AgentFeedSessionCapabilities: Codable {
    let modes: [String]
    let canSend: Bool
    let canSteer: Bool
    let canAbort: Bool
    let canFetchRaw: Bool
    let canOpenTerminal: Bool
    let supportsExtensionUi: Bool
    /// True when the session has a live, network-observed delta stream (claude live source).
    /// Defaulted so the synthesized memberwise init accepts omitting it (older fixtures).
    var canStreamLive: Bool? = nil
}

struct AgentFeedQueueState: Codable {
    let steer: Int
    let followUp: Int
}

struct AgentFeedTimelineEnvelope: Codable {
    let kind: String
    let sequence: Int
    let mode: String
    let events: [AgentFeedActivityEvent]
    let windowStart: Int
    let total: Int
    let runState: String
    let queue: AgentFeedQueueState
    let usage: AgentFeedTokenUsage?
}

struct AgentFeedCommandReceipt: Codable {
    let requestId: String
    let delivery: String
}

struct AgentFeedExtensionUIRequest: Codable, Sendable {
    let requestId: String
    let kind: String
    let title: String?
    let message: String?
    let options: [String]?
    let placeholder: String?
    let prefill: String?
    let level: String?
    let key: String?
    let lines: [String]?
    let expectsResponse: Bool
}

struct AgentFeedExtensionUIEvent: Codable, Sendable {
    let type: String
    let request: AgentFeedExtensionUIRequest?
    let requestId: String?
}

struct AgentFeedCommandErrorEnvelope: Codable {
    struct Detail: Codable {
        let code: String
        let message: String
        let requestId: String?
        let retryable: Bool
    }
    let error: Detail
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
        afterSequence: Int,
        mode: AgentFeedEventMode,
        onEnvelope: @escaping @Sendable (AgentFeedTimelineEnvelope) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> SidecarStreamHandle
    func openClaudeLiveStream(
        sessionId: String,
        afterSequence: Int,
        mode: AgentFeedEventMode,
        onEnvelope: @escaping @Sendable (AgentFeedTimelineEnvelope) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> SidecarStreamHandle
    func fetchClaudeLiveEventsPage(
        sessionId: String,
        offset: Int,
        limit: Int,
        mode: AgentFeedEventMode
    ) async throws -> AgentFeedEventsPage
    func createSession(requestId: String, source: String, projectPath: String) async throws -> AgentFeedSessionSummary
    func sendMessage(requestId: String, source: String, sessionId: String, text: String, delivery: String) async throws -> AgentFeedCommandReceipt
    func abortSession(requestId: String, source: String, sessionId: String) async throws -> AgentFeedCommandReceipt
    func openExtensionUIStream(
        source: String,
        sessionId: String,
        onEvent: @escaping @Sendable (AgentFeedExtensionUIEvent) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> SidecarStreamHandle
    func respondToExtensionUI(source: String, sessionId: String, requestId: String, value: AgentJSONValue) async throws -> AgentFeedCommandReceipt
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
    private let endpointProvider: @Sendable () async -> AgentFeedSidecarEndpoint?
    private let session: URLSession
    private let streamSession: URLSession
    private let streamCensus: AgentFeedStreamCensus
    private let logger: Logger

    /// Streams and requests get SEPARATE connection pools, and neither is `URLSession.shared`.
    ///
    /// The feed holds long-lived SSE streams -- a projects stream, a stream per watched project, one
    /// per open thread, one per session with extension UI -- and every Agents window and paired phone
    /// opens its own set. Those connections never return to the pool. On one shared pool, the system's
    /// six-per-host default is reached by the third window, and from then on every request that
    /// actually renders a thread (`fetchEventsPage`, `fetchRawEvent`, `sendMessage`) queues behind
    /// streams that will not end, until the panel's ten-second timeout fires and the session shows an
    /// error instead of its transcript. The cap is a browser-era politeness limit toward a stranger's
    /// server; this is loopback to a sidecar the host itself spawned.
    ///
    /// Two pools rather than one large one: a single pool means any future stream that fails to be
    /// torn down eventually starves requests again, just more slowly. With the pools split, an RPC
    /// never waits on a stream at all.
    init(
        endpointProvider: @escaping @Sendable () async -> AgentFeedSidecarEndpoint?,
        session: URLSession? = nil,
        streamSession: URLSession? = nil
    ) {
        self.endpointProvider = endpointProvider
        self.session = session ?? URLSession(
            configuration: Self.configuration(connectionLimit: Config.agentFeedSidecarRequestConnectionLimit)
        )
        // A test that injects one session is stubbing the protocol, not the pool: reuse it for both
        // roles so streams stay observable through the same seam.
        self.streamSession = streamSession ?? session ?? URLSession(
            configuration: Self.configuration(connectionLimit: Config.agentFeedSidecarStreamConnectionLimit)
        )
        self.streamCensus = AgentFeedStreamCensus(limit: Config.agentFeedSidecarStreamConnectionLimit)
        self.logger = Logger(subsystem: Config.logSubsystem, category: "agent-feed-sidecar-client")
    }

    /// Ephemeral, so transcript bodies are never written to a URL cache on disk on their way to a
    /// panel that already has them.
    private static func configuration(connectionLimit: Int) -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpMaximumConnectionsPerHost = connectionLimit
        return configuration
    }

    var requestSessionForTesting: URLSession { session }
    var streamSessionForTesting: URLSession { streamSession }

    /// Says so out loud when live streams approach the pool they draw from. Split pools mean a
    /// leaked stream can no longer block a thread from rendering, so it now fails quietly instead --
    /// this is what keeps it from being invisible until streams stop arriving altogether.
    private static func report(_ transition: AgentFeedStreamCensus.Transition, to logger: Logger) {
        switch transition {
        case .quiet:
            break
        case .reachedWatermark(let live, let watermark, let limit):
            logger.error(
                """
                sidecar streams at watermark live=\(live, privacy: .public) \
                watermark=\(watermark, privacy: .public) limit=\(limit, privacy: .public) \
                (a stream that is never closed will exhaust this pool)
                """
            )
        case .recovered(let live, let watermark):
            logger.notice(
                """
                sidecar streams back below watermark live=\(live, privacy: .public) \
                watermark=\(watermark, privacy: .public)
                """
            )
        }
    }

    private func currentEndpoint() async throws -> AgentFeedSidecarEndpoint {
        guard let endpoint = await endpointProvider() else { throw SidecarClientError.notReady }
        return endpoint
    }

    private func request(path: String, query: [URLQueryItem] = [], method: String = "GET", body: Data? = nil) async throws -> URLRequest {
        let endpoint = try await currentEndpoint()
        var components = URLComponents(
            url: endpoint.baseURL.appendingPathComponent(path),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = query.isEmpty ? nil : query
        guard let url = components?.url else { throw SidecarClientError.badURL }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        request.setValue("Bearer \(endpoint.controlToken)", forHTTPHeaderField: "Authorization")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        return request
    }

    private func fetchJSON<Value: Decodable>(_ type: Value.Type, request: URLRequest) async throws -> Value {
        let (data, response) = try await session.data(for: request)
        try validateHTTP(response, url: request.url)
        return try JSONDecoder().decode(type, from: data)
    }

    func fetchProjects() async throws -> AgentFeedProjectsSnapshot {
        try await fetchJSON(
            AgentFeedProjectsSnapshot.self,
            request: try await request(path: "/api/projects")
        )
    }

    func fetchSessions(projectPath: String) async throws -> AgentFeedSessionsSnapshot {
        try await fetchJSON(
            AgentFeedSessionsSnapshot.self,
            request: try await request(
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
            let sequence: Int
            let runState: String
            let queue: AgentFeedQueueState
        }
        let envelope = try await fetchJSON(
            Envelope.self,
            request: try await request(
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
            usage: envelope.usage,
            sequence: envelope.sequence,
            runState: envelope.runState,
            queueSteer: envelope.queue.steer,
            queueFollowUp: envelope.queue.followUp
        )
    }

    func fetchRawEvent(
        source: String,
        sessionId: String,
        eventIndex: Int,
        mode: AgentFeedEventMode
    ) async throws -> String {
        let request = try await request(
            path: "/api/sessions/\(source)/\(sessionId)/events/\(eventIndex)/raw",
            query: [URLQueryItem(name: "mode", value: mode.rawValue)]
        )
        let (data, response) = try await session.data(for: request)
        try validateHTTP(response, url: request.url)
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
            request: { try await self.request(path: "/api/projects/stream") },
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
            request: {
                try await self.request(
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
        afterSequence: Int,
        mode: AgentFeedEventMode,
        onEnvelope: @escaping @Sendable (AgentFeedTimelineEnvelope) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> SidecarStreamHandle {
        openJSONStream(
            request: {
                try await self.request(
                    path: "/api/sessions/\(source)/\(sessionId)/stream",
                    query: [
                        URLQueryItem(name: "since", value: String(afterSequence)),
                        URLQueryItem(name: "mode", value: mode.rawValue),
                    ]
                )
            },
            type: AgentFeedTimelineEnvelope.self,
            onValue: onEnvelope,
            onError: onError
        )
    }

    func openClaudeLiveStream(
        sessionId: String,
        afterSequence: Int,
        mode: AgentFeedEventMode,
        onEnvelope: @escaping @Sendable (AgentFeedTimelineEnvelope) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> SidecarStreamHandle {
        openJSONStream(
            request: {
                try await self.request(
                    path: "/api/agent-sessions/claude/\(sessionId)/stream",
                    query: [
                        URLQueryItem(name: "since", value: String(afterSequence)),
                        URLQueryItem(name: "mode", value: mode.rawValue),
                    ]
                )
            },
            type: AgentFeedTimelineEnvelope.self,
            onValue: onEnvelope,
            onError: onError
        )
    }

    func fetchClaudeLiveEventsPage(
        sessionId: String,
        offset: Int,
        limit: Int,
        mode: AgentFeedEventMode
    ) async throws -> AgentFeedEventsPage {
        struct Envelope: Decodable {
            let events: [AgentFeedActivityEvent]
            let total: Int
            let usage: AgentFeedTokenUsage?
            let sequence: Int
            let runState: String
            let queue: AgentFeedQueueState
        }
        let envelope = try await fetchJSON(
            Envelope.self,
            request: try await request(
                path: "/api/agent-sessions/claude/\(sessionId)/events",
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
            usage: envelope.usage,
            sequence: envelope.sequence,
            runState: envelope.runState,
            queueSteer: envelope.queue.steer,
            queueFollowUp: envelope.queue.followUp
        )
    }

    func createSession(requestId: String, source: String, projectPath: String) async throws -> AgentFeedSessionSummary {
        struct Body: Encodable { let requestId: String; let source: String; let projectPath: String }
        return try await postJSON(AgentFeedSessionSummary.self, path: "/api/agent-sessions", body: Body(requestId: requestId, source: source, projectPath: projectPath))
    }

    func sendMessage(requestId: String, source: String, sessionId: String, text: String, delivery: String) async throws -> AgentFeedCommandReceipt {
        struct Body: Encodable { let requestId: String; let text: String; let delivery: String }
        return try await postJSON(AgentFeedCommandReceipt.self, path: "/api/agent-sessions/\(source)/\(sessionId)/messages", body: Body(requestId: requestId, text: text, delivery: delivery))
    }

    func abortSession(requestId: String, source: String, sessionId: String) async throws -> AgentFeedCommandReceipt {
        struct Body: Encodable { let requestId: String }
        return try await postJSON(AgentFeedCommandReceipt.self, path: "/api/agent-sessions/\(source)/\(sessionId)/abort", body: Body(requestId: requestId))
    }

    func openExtensionUIStream(
        source: String,
        sessionId: String,
        onEvent: @escaping @Sendable (AgentFeedExtensionUIEvent) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> SidecarStreamHandle {
        openJSONStream(
            request: { try await self.request(path: "/api/agent-sessions/\(source)/\(sessionId)/ui/stream") },
            type: AgentFeedExtensionUIEvent.self,
            onValue: onEvent,
            onError: onError
        )
    }

    func respondToExtensionUI(
        source: String,
        sessionId: String,
        requestId: String,
        value: AgentJSONValue
    ) async throws -> AgentFeedCommandReceipt {
        struct Body: Encodable { let value: AgentJSONValue }
        return try await postJSON(
            AgentFeedCommandReceipt.self,
            path: "/api/agent-sessions/\(source)/\(sessionId)/ui/\(requestId)",
            body: Body(value: value)
        )
    }

    private func postJSON<Value: Decodable, Body: Encodable>(_ type: Value.Type, path: String, body: Body) async throws -> Value {
        let data = try JSONEncoder().encode(body)
        let outbound = try await request(path: path, method: "POST", body: data)
        let (responseData, response) = try await session.data(for: outbound)
        guard let http = response as? HTTPURLResponse else { throw SidecarClientError.badStatusCode }
        guard (200..<300).contains(http.statusCode) else {
            if let envelope = try? JSONDecoder().decode(AgentFeedCommandErrorEnvelope.self, from: responseData) {
                throw SidecarClientError.command(
                    code: envelope.error.code,
                    message: envelope.error.message,
                    requestId: envelope.error.requestId,
                    retryable: envelope.error.retryable
                )
            }
            try validateHTTP(response, url: outbound.url)
            throw SidecarClientError.badStatusCode
        }
        return try JSONDecoder().decode(type, from: responseData)
    }

    // `url` is resolved inside the task, not by the caller, because resolving it
    // may mean waiting for a sidecar that is still starting. Opening a stream
    // stays synchronous -- the caller gets a cancellable handle immediately -- and
    // the wait costs the first snapshot some latency instead of costing the
    // subscription its life.
    private func openJSONStream<Value: Decodable & Sendable>(
        request: @escaping @Sendable () async throws -> URLRequest,
        type: Value.Type,
        onValue: @escaping @Sendable (Value) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> SidecarStreamHandle {
        let session = streamSession
        let census = streamCensus
        let logger = logger
        let task = Task<Void, Never> {
            Self.report(census.opened(), to: logger)
            // Runs on cancellation too: `cancel()` unblocks the byte loop, which leaves this scope.
            defer { Self.report(census.closed(), to: logger) }
            do {
                let resolved = try await request()
                guard !Task.isCancelled else { return }
                let (bytes, response) = try await session.bytes(for: resolved)
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
                    let decoder = JSONDecoder()
                    if let envelope = try? decoder.decode(AgentFeedCommandErrorEnvelope.self, from: data) {
                        onError(SidecarClientError.command(
                            code: envelope.error.code,
                            message: envelope.error.message,
                            requestId: envelope.error.requestId,
                            retryable: envelope.error.retryable
                        ))
                        return
                    }
                    onValue(try decoder.decode(type, from: data))
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

    private func validateHTTP(_ response: URLResponse, url: URL?) throws {
        guard let http = response as? HTTPURLResponse else {
            throw SidecarClientError.badStatusCode
        }
        guard (200..<300).contains(http.statusCode) else {
            logger.error("sidecar HTTP \(http.statusCode, privacy: .public) url=\(url?.absoluteString ?? "unknown", privacy: .public)")
            throw SidecarClientError.badStatusCode
        }
    }
}

enum SidecarClientError: LocalizedError, Equatable {
    case badURL
    case badStatusCode
    case notReady
    case server(String)
    case command(code: String, message: String, requestId: String?, retryable: Bool)

    var errorDescription: String? {
        switch self {
        case .badURL: "invalid sidecar URL"
        case .badStatusCode: "sidecar returned an unsuccessful response"
        case .notReady: "agent feed is not ready"
        case .server(let message): message
        case .command(_, let message, _, _): message
        }
    }
}
