import Foundation
import os
import AgentDeskWire

// Ingestion DTOs: decode sidecar JSON verbatim. The sidecar uses the field
// name "type" for the event kind; the wire ActivityEvent uses CodingKey "tp".
// These separate structs bridge the two without touching the wire types.

struct AgentFeedActivityBlock: Codable {
    let kind: String
    let label: String?
    let text: String?
    // tool_use carries tool + summary (+ callId); tool_result carries preview
    // (+ callId). The sidecar emits these with full field names, matching the
    // sidecar's ActivityBlock shape. Decoded here so the wire block can carry
    // them; without this, only text survived and TOOL/RESULT rows rendered
    // empty on the client. `input`/`hidden*` are intentionally omitted (the
    // mobile surface renders summary/preview/text, not raw tool input).
    let tool: String?
    let summary: String?
    let preview: String?
    let callId: String?

    // Convenience init with defaults for the optional tool fields. Codable's
    // init(from:) is still synthesized (a non-decoder init does not suppress
    // it), so decode keeps reading every field; this just keeps block
    // construction in tests terse.
    init(
        kind: String,
        label: String? = nil,
        text: String? = nil,
        tool: String? = nil,
        summary: String? = nil,
        preview: String? = nil,
        callId: String? = nil
    ) {
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

// One session entry from the digest. The sidecar returns full SessionDigest
// objects in `sessions[]` and compact ProjectDigestOtherSession objects in
// `otherSessions[]`; both carry these fields (otherSessions omits firstPrompt).
// Decode only the fields the mobile surface needs; the rest of each object is
// ignored by the decoder.
struct AgentFeedSessionDigest: Codable {
    let sessionId: String
    let source: String
    let bin: String?
    let lastEventAt: Double?
    let title: String?
    let firstPrompt: String?
    let lastUserPrompt: String?

    enum CodingKeys: String, CodingKey {
        case sessionId
        case source
        case bin
        case lastEventAt
        case title
        case firstPrompt
        case lastUserPrompt
    }
}

struct AgentFeedProjectDigest: Codable {
    let project: String
    let projectName: String
    let source: String
    let sources: [String]
    let lastEventAt: Double?
    let bin: String?
    let primary: AgentFeedSessionDigest?
    // Full digests for the newest sessions across all sources for this project.
    let sessions: [AgentFeedSessionDigest]?
    // Compact entries for the remaining sessions (older / less active).
    let otherSessions: [AgentFeedSessionDigest]?
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
    func fetchDigest() async throws -> [AgentFeedProjectDigest]
    func fetchEventsPage(sessionId: String, offset: Int, limit: Int) async throws -> AgentFeedEventsPage
    func fetchRawEvent(sessionId: String, eventIndex: Int) async throws -> String
    func openEventStream(
        sessionId: String,
        after: Int,
        onEvent: @escaping @Sendable (AgentFeedActivityEvent) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> SidecarStreamHandle
}

extension SidecarClient {
    func fetchRawEvent(sessionId: String, eventIndex: Int) async throws -> String {
        throw SidecarClientError.unsupported
    }
}

// Real implementation over URLSession.
final class HttpSidecarClient: SidecarClient, @unchecked Sendable {
    // Resolve the sidecar base URL lazily on each request rather than capturing a
    // fixed value at construction. The sidecar can be mid-restart when a session
    // attaches; binding its readiness at wire time would disable the feed for the
    // whole session even after it recovers. A request that arrives while the
    // sidecar is down throws `notReady`, and the client retries.
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

    func fetchDigest() async throws -> [AgentFeedProjectDigest] {
        let startedAt = DispatchTime.now().uptimeNanoseconds
        let url = try currentBaseURL().appendingPathComponent("/api/projects/digest")
        let (data, response) = try await session.data(from: url)
        try validateHTTP(response, url: url)
        struct Envelope: Decodable {
            let projects: [AgentFeedProjectDigest]
        }
        let envelope = try JSONDecoder().decode(Envelope.self, from: data)
        let durationMilliseconds = (DispatchTime.now().uptimeNanoseconds - startedAt) / 1_000_000
        logger.notice(
            "agent-feed digest response durationMs=\(durationMilliseconds, privacy: .public) bytes=\(data.count, privacy: .public) projects=\(envelope.projects.count, privacy: .public)"
        )
        return envelope.projects
    }

    func fetchEventsPage(sessionId: String, offset: Int, limit: Int) async throws -> AgentFeedEventsPage {
        var components = URLComponents(
            url: try currentBaseURL().appendingPathComponent("/api/sessions/\(sessionId)/events"),
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
            let events: [AgentFeedActivityEvent]
            let total: Int
        }
        let envelope = try JSONDecoder().decode(Envelope.self, from: data)
        return AgentFeedEventsPage(events: envelope.events, total: envelope.total)
    }

    func fetchRawEvent(sessionId: String, eventIndex: Int) async throws -> String {
        let url = try currentBaseURL().appendingPathComponent(
            "/api/sessions/\(sessionId)/events/\(eventIndex)/raw"
        )
        let (data, response) = try await session.data(from: url)
        guard let http = response as? HTTPURLResponse else {
            throw SidecarClientError.badStatusCode
        }
        guard (200..<300).contains(http.statusCode) else {
            let detail = String(data: data, encoding: .utf8) ?? "HTTP \(http.statusCode)"
            logger.error("sidecar raw event HTTP \(http.statusCode, privacy: .public) detail=\(detail, privacy: .public)")
            throw SidecarClientError.server(detail)
        }
        guard data.count <= AgentRawEventLimits.maximumRecordBytes else {
            throw SidecarClientError.server("raw event exceeds 100 MiB")
        }
        guard let text = String(data: data, encoding: .utf8) else {
            throw SidecarClientError.server("raw event is not valid UTF-8 text")
        }
        return text
    }

    func openEventStream(
        sessionId: String,
        after: Int,
        onEvent: @escaping @Sendable (AgentFeedActivityEvent) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> SidecarStreamHandle {
        guard let base = baseURLProvider() else {
            return SidecarStreamHandle(task: Task { onError(SidecarClientError.notReady) })
        }
        var components = URLComponents(
            url: base.appendingPathComponent("/api/sessions/\(sessionId)/stream"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [URLQueryItem(name: "after", value: String(after))]
        let url = components?.url ?? base.appendingPathComponent("/api/sessions/\(sessionId)/stream")
        let logger = logger
        let session = session
        let task = Task<Void, Never> {
            do {
                let (asyncBytes, response) = try await session.bytes(from: url)
                guard let httpResponse = response as? HTTPURLResponse,
                      (200..<300).contains(httpResponse.statusCode) else {
                    onError(SidecarClientError.badStatusCode)
                    return
                }
                for try await line in asyncBytes.lines {
                    guard !Task.isCancelled else { return }
                    if line.hasPrefix("data:") {
                        // The sidecar emits one ActivityEvent JSON per `data:` line
                        // (each SSE message is a single line), so there is no
                        // multi-line buffering to do.
                        let latestDataLine = String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
                        if latestDataLine.isEmpty { continue }
                        if latestDataLine == "\"shutdown\"" { return }
                        guard let data = latestDataLine.data(using: .utf8) else {
                            onError(SidecarClientError.server("agent feed stream emitted non-UTF-8 data"))
                            return
                        }
                        do {
                            onEvent(try JSONDecoder().decode(AgentFeedActivityEvent.self, from: data))
                        } catch {
                            logger.error("agent-feed-stream: invalid SSE event json=\(latestDataLine, privacy: .public)")
                            onError(SidecarClientError.server("agent feed stream emitted an invalid event"))
                            return
                        }
                    }
                }
                guard Task.isCancelled else {
                    onError(SidecarClientError.server("agent feed stream ended unexpectedly"))
                    return
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

enum SidecarClientError: LocalizedError, Equatable {
    case badURL
    case badStatusCode
    // The sidecar has no ready base URL right now (starting or mid-restart). The
    // request is transient-failed; the client retries.
    case notReady
    case unsupported
    case server(String)

    var errorDescription: String? {
        switch self {
        case .badURL: "invalid sidecar URL"
        case .badStatusCode: "sidecar returned an unsuccessful response"
        case .notReady: "agent feed is not ready"
        case .unsupported: "raw event loading is unsupported"
        case .server(let message): message
        }
    }
}
