import Foundation
import os
import AgentDeskWire

struct AgentFeedSidecarEndpoint: Sendable {
    let baseURL: URL
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


/// What NATIVE host code asks the sidecar, and the whole of it.
///
/// This used to name thirteen endpoints and every payload shape behind them, which
/// put the agent-feed model in Swift a second time and made a field addition a
/// compile. The feed reaches the sidecar through `AgentFeedRelayClient` now, so what
/// is left here is the one call the host itself makes: the terminal coordinator asks
/// which sessions a project has, because opening a terminal for a session is native
/// authority and not something a webview asks for.
protocol SidecarClient: Sendable {
    func fetchSessions(projectPath: String) async throws -> AgentFeedSessionsSnapshot
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
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        return request
    }

    private func fetchJSON<Value: Decodable>(_ type: Value.Type, request: URLRequest) async throws -> Value {
        let (data, response) = try await session.data(for: request)
        try validateHTTP(response, url: request.url)
        return try JSONDecoder().decode(type, from: data)
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

// MARK: - Relay transport

extension HttpSidecarClient: AgentFeedRelayClient {
    /// One request, delivered whole.
    ///
    /// Whole rather than streamed because the caller is going to chunk it anyway to
    /// fit the lane, and because a response that arrives in one piece cannot be half
    /// delivered when the transfer fails midway.
    func perform(
        method: String,
        path: String,
        body: Data?,
        onResponse: @escaping @Sendable (Int, Data) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> SidecarStreamHandle {
        let session = self.session
        let task = Task<Void, Never> {
            do {
                var outbound = try await relayRequest(method: method, path: path, body: body)
                outbound.timeoutInterval = AgentFeedRelay.transferTimeout
                guard !Task.isCancelled else { return }
                let (data, response) = try await session.data(for: outbound)
                guard !Task.isCancelled else { return }
                guard let http = response as? HTTPURLResponse else {
                    onError(SidecarClientError.badStatusCode)
                    return
                }
                // A non-2xx status is RELAYED, not raised: the sidecar's own error body
                // says more than any status this layer could invent, and the panel is
                // the thing that knows whether a 404 on this path is fatal.
                onResponse(http.statusCode, data)
            } catch is CancellationError {
                return
            } catch {
                if !Task.isCancelled { onError(error) }
            }
        }
        return SidecarStreamHandle(task: task)
    }

    /// Follows a server-sent event stream, delivering each message's payload verbatim.
    ///
    /// The URL is resolved inside the task, not by the caller, because resolving it may
    /// mean waiting for a sidecar that is still starting. Subscribing stays synchronous
    /// -- the caller gets a cancellable handle immediately -- so arriving early costs
    /// the first message some latency instead of costing the subscription its life.
    func subscribe(
        path: String,
        onOpen: @escaping @Sendable (Int) -> Void,
        onMessage: @escaping @Sendable (String) -> Void,
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
                let outbound = try await relayRequest(method: "GET", path: path, body: nil)
                guard !Task.isCancelled else { return }
                let (bytes, response) = try await session.bytes(for: outbound)
                guard let http = response as? HTTPURLResponse else {
                    onError(SidecarClientError.badStatusCode)
                    return
                }
                onOpen(http.statusCode)
                guard (200..<300).contains(http.statusCode) else { return }
                for try await line in bytes.lines {
                    guard !Task.isCancelled else { return }
                    guard line.hasPrefix("data:") else { continue }
                    let payload = String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
                    if payload.isEmpty { continue }
                    // The sidecar's shutdown notice. Ends the subscription quietly; the
                    // panel re-subscribes when the sidecar is back.
                    if payload == "\"shutdown\"" { return }
                    onMessage(payload)
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

    /// Builds a request for an already-validated relay path.
    ///
    /// `path` carries its own query, so it is parsed rather than appended as a path
    /// component -- `appendingPathComponent` would escape the `?` and turn a query into
    /// part of the path. The caller has already checked the path against
    /// `AgentFeedRelay.PathPolicy`; this resolves it against the sidecar's base URL,
    /// which is what confines it to the sidecar even if that check ever missed something.
    private func relayRequest(method: String, path: String, body: Data?) async throws -> URLRequest {
        let endpoint = try await currentEndpoint()
        guard let url = URL(string: path, relativeTo: endpoint.baseURL),
              url.host == endpoint.baseURL.host,
              url.port == endpoint.baseURL.port,
              url.scheme == endpoint.baseURL.scheme else {
            throw SidecarClientError.badURL
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        return request
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

