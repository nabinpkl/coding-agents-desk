import Foundation
import os

// AgentFeedBridge translates the sidecar's HTTP/SSE surface into the
// agent-feed input-lane wire messages. It is constructed with an injectable
// SidecarClient (so tests can use a fake) and a lane-send closure that
// mirrors the push callback shape the diagnostics path uses.
//
// Thread-safety: the bridge is not formally actor-isolated; all mutations of
// activeStreams happen on a dedicated serial queue. Callers may invoke handle*
// from any thread.
final class AgentFeedBridge: @unchecked Sendable {
    // Page size for the initial seed window on AgentThreadSubscribe.
    static let pageSize = 100

    private let client: any SidecarClient
    private let send: @Sendable (Data) -> Void
    private let logger: Logger
    private let queue = DispatchQueue(label: "com.example.agentdesk.AgentDeskHost.agent-feed-bridge")

    // Active per-session SSE stream handles.
    private var activeStreams: [String: SidecarStreamHandle] = [:]

    // Construct with the injectable client and the lane push closure.
    // The send closure mirrors the pattern used by InputChannelServer.sendCodableFrame:
    // encode the message and write to the QUIC stream.
    init(client: any SidecarClient, send: @escaping @Sendable (Data) -> Void) {
        self.client = client
        self.send = send
        self.logger = Logger(subsystem: Config.launchAgentLabel, category: "agent-feed-bridge")
    }

    // Reset cancels all active streams. Call when the lane re-attaches.
    func reset() {
        queue.sync {
            for handle in activeStreams.values {
                handle.cancel()
            }
            activeStreams.removeAll()
        }
    }

    // MARK: - Request handlers

    func handleProjectsSubscribe() {
        Task {
            do {
                let digests = try await client.fetchDigest()
                let wireProjects = digests.map { wireDigest(from: $0) }
                let push = AgentProjectsPush(projects: wireProjects)
                sendCodable(push)
            } catch {
                logger.error("agent-feed-bridge: projects fetch failed: \(String(describing: error), privacy: .public)")
                // Projects errors use an empty sessionId per the brief note.
                let err = AgentThreadError(sessionId: "", reason: error.localizedDescription)
                sendCodable(err)
            }
        }
    }

    func handleThreadSubscribe(_ request: AgentThreadSubscribe) {
        guard let sessionId = request.sessionId ?? request.projectPath else {
            logger.error("agent-feed-bridge: thread subscribe missing both sessionId and projectPath")
            sendCodable(AgentThreadError(sessionId: "", reason: "missing session identifier"))
            return
        }
        Task {
            do {
                // Probe total to compute the last-page window.
                let probe = try await client.fetchEventsPage(sessionId: sessionId, offset: 0, limit: 1)
                let total = probe.total
                let offset = max(0, total - Self.pageSize)
                let limit = total - offset
                let page: EngineEventsPage
                if limit > 0 {
                    page = try await client.fetchEventsPage(sessionId: sessionId, offset: offset, limit: limit)
                } else {
                    page = EngineEventsPage(events: [], total: total)
                }
                let wireEvents = page.events.map { wireEvent(from: $0) }
                let chunk = AgentThreadChunk(
                    sessionId: sessionId,
                    events: wireEvents,
                    windowStart: offset,
                    total: total,
                    isLive: false
                )
                sendCodable(chunk)
                // Open the live stream starting after the last known event.
                openStream(sessionId: sessionId, after: total)
            } catch {
                logger.error("agent-feed-bridge: thread subscribe failed sessionId=\(sessionId, privacy: .public): \(String(describing: error), privacy: .public)")
                sendCodable(AgentThreadError(sessionId: sessionId, reason: error.localizedDescription))
            }
        }
    }

    func handleThreadLoadOlder(_ request: AgentThreadLoadOlder) {
        let sessionId = request.sessionId
        Task {
            do {
                let offset = max(0, request.beforeIndex - request.limit)
                let limit = request.beforeIndex - offset
                let page: EngineEventsPage
                if limit > 0 {
                    page = try await client.fetchEventsPage(sessionId: sessionId, offset: offset, limit: limit)
                } else {
                    // Nothing to load older than index 0.
                    page = EngineEventsPage(events: [], total: 0)
                }
                let wireEvents = page.events.map { wireEvent(from: $0) }
                let chunk = AgentThreadChunk(
                    sessionId: sessionId,
                    events: wireEvents,
                    windowStart: offset,
                    total: page.total,
                    isLive: false
                )
                sendCodable(chunk)
            } catch {
                logger.error("agent-feed-bridge: load older failed sessionId=\(sessionId, privacy: .public): \(String(describing: error), privacy: .public)")
                sendCodable(AgentThreadError(sessionId: sessionId, reason: error.localizedDescription))
            }
        }
    }

    func handleThreadUnsubscribe(_ request: AgentThreadUnsubscribe) {
        queue.sync {
            activeStreams[request.sessionId]?.cancel()
            _ = activeStreams.removeValue(forKey: request.sessionId)
        }
        logger.debug("agent-feed-bridge: unsubscribed sessionId=\(request.sessionId, privacy: .public)")
    }

    // MARK: - Private helpers

    private func openStream(sessionId: String, after: Int) {
        let handle = client.openEventStream(
            sessionId: sessionId,
            after: after,
            onEvent: { [weak self] event in
                guard let self else { return }
                let wireEv = self.wireEvent(from: event)
                let chunk = AgentThreadChunk(
                    sessionId: sessionId,
                    events: [wireEv],
                    windowStart: wireEv.index,
                    total: wireEv.index + 1,
                    isLive: true
                )
                self.sendCodable(chunk)
            },
            onError: { [weak self] error in
                guard let self else { return }
                self.logger.error("agent-feed-bridge: stream error sessionId=\(sessionId, privacy: .public): \(String(describing: error), privacy: .public)")
                // Signal the client so it can show an error / retry; the stream is
                // dead, so drop the handle.
                self.sendCodable(AgentThreadError(sessionId: sessionId, reason: error.localizedDescription))
                self.queue.sync {
                    _ = self.activeStreams.removeValue(forKey: sessionId)
                }
            }
        )
        queue.sync {
            activeStreams[sessionId]?.cancel()
            activeStreams[sessionId] = handle
        }
    }

    private func sendCodable<T: Encodable>(_ message: T) {
        do {
            let data = try JSONEncoder().encode(message)
            send(data)
        } catch {
            logger.error("agent-feed-bridge: encode failed: \(String(describing: error), privacy: .public)")
        }
    }

    // MARK: - Mapping sidecar DTOs to wire types

    private func wireEvent(from engine: EngineActivityEvent) -> ActivityEvent {
        let blocks = engine.blocks.map { block -> ActivityBlock in
            ActivityBlock(
                kind: block.kind,
                text: block.text,
                tool: nil,
                summary: nil,
                preview: nil,
                callId: nil
            )
        }
        // The sidecar emits the event field as "type"; ActivityEvent uses CodingKey "tp".
        // Constructing the wire struct here performs the type -> tp mapping.
        return ActivityEvent(index: engine.index, ts: engine.ts, type: engine.type, blocks: blocks)
    }

    // Cap on the number of sessions surfaced per project in a digest push, to
    // bound the push size (a project can carry 100+ otherSessions).
    static let maxSessionsPerProject = 30

    private func wireDigest(from engine: EngineProjectDigest) -> ProjectDigest {
        // Union the full sessions[] and compact otherSessions[] lists (and the
        // primary, in case it is not in either), so the project-first surface
        // shows the combined Claude + Codex thread list, not just the primary.
        var combined: [EngineSessionDigest] = []
        combined.append(contentsOf: engine.sessions ?? [])
        combined.append(contentsOf: engine.otherSessions ?? [])
        if let primary = engine.primary {
            combined.append(primary)
        }
        // Dedup by sessionId, keeping the first (richest) occurrence, then sort
        // by recency descending and cap.
        var seen = Set<String>()
        var deduped: [EngineSessionDigest] = []
        for entry in combined where !seen.contains(entry.sessionId) {
            seen.insert(entry.sessionId)
            deduped.append(entry)
        }
        let sorted = deduped.sorted { ($0.lastEventAt ?? 0) > ($1.lastEventAt ?? 0) }
        let capped = sorted.prefix(Self.maxSessionsPerProject)
        let sessions = capped.map { entry -> AgentSessionSummary in
            let title = entry.title
                ?? entry.firstPrompt
                ?? entry.lastUserPrompt
                ?? engine.projectName
            return AgentSessionSummary(
                sessionId: entry.sessionId,
                source: entry.source,
                title: title,
                lastEventAt: entry.lastEventAt ?? 0,
                isLive: (entry.bin ?? "") == "live"
            )
        }
        return ProjectDigest(
            projectPath: engine.project,
            displayName: engine.projectName,
            sessions: sessions
        )
    }
}
