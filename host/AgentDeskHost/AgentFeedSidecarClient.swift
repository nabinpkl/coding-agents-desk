import Foundation
import os
import AgentDeskWire

// Ingestion DTOs: decode sidecar JSON verbatim. The sidecar uses the field
// name "type" for the event kind; the wire ActivityEvent uses CodingKey "tp".
// These separate structs bridge the two without touching the wire types.

struct EngineActivityBlock: Codable {
    let kind: String
    let text: String?
    // tool_use carries tool + summary (+ callId); tool_result carries preview
    // (+ callId). The sidecar emits these with full field names, matching the
    // engine's ActivityBlock shape. Decoded here so the wire block can carry
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
        text: String? = nil,
        tool: String? = nil,
        summary: String? = nil,
        preview: String? = nil,
        callId: String? = nil
    ) {
        self.kind = kind
        self.text = text
        self.tool = tool
        self.summary = summary
        self.preview = preview
        self.callId = callId
    }
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

// One session entry from the digest. The sidecar returns full SessionDigest
// objects in `sessions[]` and compact ProjectDigestOtherSession objects in
// `otherSessions[]`; both carry these fields (otherSessions omits firstPrompt).
// Decode only the fields the mobile surface needs; the rest of each object is
// ignored by the decoder.
struct EngineSessionDigest: Codable {
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

struct EngineProjectDigest: Codable {
    let project: String
    let projectName: String
    let source: String
    let sources: [String]
    let observed: Bool?
    let lastEventAt: Double?
    let bin: String?
    let primary: EngineSessionDigest?
    // Full digests for the newest sessions across all sources for this project.
    let sessions: [EngineSessionDigest]?
    // Compact entries for the remaining sessions (older / less active).
    let otherSessions: [EngineSessionDigest]?
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
        self.logger = Logger(subsystem: Config.logSubsystem, category: "agent-feed-sidecar-client")
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
                        if let data = latestDataLine.data(using: .utf8),
                           let event = try? JSONDecoder().decode(EngineActivityEvent.self, from: data) {
                            onEvent(event)
                        } else {
                            logger.error("agent-feed-stream: failed to decode SSE event json=\(latestDataLine, privacy: .public)")
                        }
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
