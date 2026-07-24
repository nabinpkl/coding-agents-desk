import Foundation
import os
import AgentDeskWire

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

    enum RawEventDeliveryMode: Sendable, Equatable {
        case direct
        case fragmentForInputLane
    }

    private let client: any SidecarClient
    private let send: @Sendable (Data) -> Void
    private let logger: Logger
    private let rawEventDeliveryMode: RawEventDeliveryMode
    private let queue = DispatchQueue(label: "\(Config.dispatchQueuePrefix).agent-feed-bridge")

    // Active per-session SSE stream handles and the shared project snapshot
    // request. The dashboard retries its initial subscribe while the lane comes
    // up; one bridge-level task keeps those retries from multiplying the same
    // expensive sidecar digest scan.
    private var activeStreams: [String: SidecarStreamHandle] = [:]
    private var projectsFetchTask: Task<Void, Never>?

    // Construct with the injectable client and the lane push closure.
    // The send closure mirrors the pattern used by InputChannelServer.sendCodableFrame:
    // encode the message and write to the QUIC stream.
    init(
        client: any SidecarClient,
        rawEventDeliveryMode: RawEventDeliveryMode = .fragmentForInputLane,
        send: @escaping @Sendable (Data) -> Void
    ) {
        self.client = client
        self.rawEventDeliveryMode = rawEventDeliveryMode
        self.send = send
        self.logger = Logger(subsystem: Config.logSubsystem, category: "agent-feed-bridge")
    }

    // Reset cancels all active streams. Call when the lane re-attaches.
    func reset() {
        queue.sync {
            projectsFetchTask?.cancel()
            projectsFetchTask = nil
            for handle in activeStreams.values {
                handle.cancel()
            }
            activeStreams.removeAll()
        }
    }

    // MARK: - Request handlers

    func handleProjectsSubscribe() {
        queue.async { [weak self] in
            guard let self else { return }
            guard self.projectsFetchTask == nil else {
                self.logger.debug("agent-feed: projects subscribe joined in-flight digest fetch")
                return
            }
            self.logger.notice("agent-feed: projects subscribe received; fetching digest")
            self.projectsFetchTask = Task { [weak self] in
                guard let self else { return }
                await self.fetchAndPushProjects()
                self.queue.async { [weak self] in
                    self?.projectsFetchTask = nil
                }
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
                let page: AgentFeedEventsPage
                if limit > 0 {
                    page = try await client.fetchEventsPage(sessionId: sessionId, offset: offset, limit: limit)
                } else {
                    page = AgentFeedEventsPage(events: [], total: total)
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
                let page: AgentFeedEventsPage
                if limit > 0 {
                    page = try await client.fetchEventsPage(sessionId: sessionId, offset: offset, limit: limit)
                } else {
                    // Nothing to load older than index 0.
                    page = AgentFeedEventsPage(events: [], total: 0)
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

    func handleRawEvent(_ request: AgentRawEventRequest) {
        guard request.eventIndex >= 0 else {
            sendCodable(AgentRawEventError(
                requestId: request.requestId,
                sessionId: request.sessionId,
                eventIndex: request.eventIndex,
                reason: "invalid event index"
            ))
            return
        }
        Task {
            do {
                let text = try await client.fetchRawEvent(
                    sessionId: request.sessionId,
                    eventIndex: request.eventIndex
                )
                try sendRawEvent(text, request: request)
            } catch {
                logger.error(
                    "agent-feed raw event failed sessionId=\(request.sessionId, privacy: .public) eventIndex=\(request.eventIndex, privacy: .public) error=\(String(describing: error), privacy: .public)"
                )
                sendCodable(AgentRawEventError(
                    requestId: request.requestId,
                    sessionId: request.sessionId,
                    eventIndex: request.eventIndex,
                    reason: (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                ))
            }
        }
    }

    // MARK: - Private helpers

    private func fetchAndPushProjects() async {
        let startedAt = DispatchTime.now().uptimeNanoseconds
        do {
            let digests = try await client.fetchDigest()
            guard !Task.isCancelled else { return }
            let wireProjects = digests.map { wireDigest(from: $0) }
            let push = AgentProjectsPush(projects: wireProjects)
            sendCodable(push)
            let durationMilliseconds = (DispatchTime.now().uptimeNanoseconds - startedAt) / 1_000_000
            logger.notice(
                "agent-feed: projects push sent count=\(wireProjects.count, privacy: .public) durationMs=\(durationMilliseconds, privacy: .public)"
            )
        } catch is CancellationError {
            logger.debug("agent-feed: projects fetch cancelled")
        } catch {
            guard !Task.isCancelled else { return }
            let durationMilliseconds = (DispatchTime.now().uptimeNanoseconds - startedAt) / 1_000_000
            logger.error(
                "agent-feed-bridge: projects fetch failed durationMs=\(durationMilliseconds, privacy: .public): \(String(describing: error), privacy: .public)"
            )
            // Projects errors use an empty sessionId because this request is not
            // tied to one thread.
            let err = AgentThreadError(sessionId: "", reason: error.localizedDescription)
            sendCodable(err)
        }
    }

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

    private func sendRawEvent(_ text: String, request: AgentRawEventRequest) throws {
        let source = Data(text.utf8)
        guard source.count <= AgentRawEventLimits.maximumRecordBytes else {
            throw SidecarClientError.server("raw event exceeds 100 MiB")
        }
        let response = AgentRawEventResponse(
            requestId: request.requestId,
            sessionId: request.sessionId,
            eventIndex: request.eventIndex,
            text: text
        )
        let encoded = try JSONEncoder().encode(response)
        if rawEventDeliveryMode == .direct || encoded.count <= QuicSessionStreamFrame.maxFrameLength {
            send(encoded)
            return
        }
        var partCount = 0
        try AgentRawEventFragmenter.forEachPart(
            data: source,
            requestId: request.requestId,
            sessionId: request.sessionId,
            eventIndex: request.eventIndex
        ) { part in
            let frame = try JSONEncoder().encode(part)
            guard frame.count <= QuicSessionStreamFrame.maxFrameLength else {
                throw QuicSessionFrameError.frameTooLarge
            }
            send(frame)
            partCount += 1
        }
        logger.notice(
            "agent-feed raw event fragmented sessionId=\(request.sessionId, privacy: .public) eventIndex=\(request.eventIndex, privacy: .public) bytes=\(source.count, privacy: .public) parts=\(partCount, privacy: .public)"
        )
    }

    // MARK: - Mapping sidecar DTOs to wire types

    private func wireEvent(from sidecar: AgentFeedActivityEvent) -> ActivityEvent {
        let blocks = sidecar.blocks.map { block -> ActivityBlock in
            ActivityBlock(
                kind: block.kind,
                label: block.label,
                text: block.text,
                tool: block.tool,
                summary: block.summary,
                preview: block.preview,
                callId: block.callId
            )
        }
        // The sidecar emits the event field as "type"; ActivityEvent uses CodingKey "tp".
        // Constructing the wire struct here performs the type -> tp mapping.
        return ActivityEvent(index: sidecar.index, ts: sidecar.ts, type: sidecar.type, blocks: blocks)
    }

    // Cap on the number of sessions surfaced per project in a digest push, to
    // bound the push size (a project can carry 100+ otherSessions).
    static let maxSessionsPerProject = 30

    private func wireDigest(from sidecar: AgentFeedProjectDigest) -> ProjectDigest {
        // Union the full sessions[] and compact otherSessions[] lists (and the
        // primary, in case it is not in either), so the project-first surface
        // shows the combined Claude + Codex thread list, not just the primary.
        var combined: [AgentFeedSessionDigest] = []
        combined.append(contentsOf: sidecar.sessions ?? [])
        combined.append(contentsOf: sidecar.otherSessions ?? [])
        if let primary = sidecar.primary {
            combined.append(primary)
        }
        // Dedup by sessionId, keeping the first (richest) occurrence, then sort
        // by recency descending and cap.
        var seen = Set<String>()
        var deduped: [AgentFeedSessionDigest] = []
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
                ?? sidecar.projectName
            return AgentSessionSummary(
                sessionId: entry.sessionId,
                source: entry.source,
                title: title,
                lastEventAt: entry.lastEventAt ?? 0,
                isLive: (entry.bin ?? "") == "live"
            )
        }
        return ProjectDigest(
            projectPath: sidecar.project,
            displayName: sidecar.projectName,
            sessions: sessions
        )
    }
}
