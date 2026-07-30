import Foundation
import os
import AgentDeskWire

final class AgentFeedBridge: @unchecked Sendable {
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
    private var visibilityStreams: [String: SidecarStreamHandle] = [:]
    private var threadStreams: [String: SidecarStreamHandle] = [:]
    private var threadBootstraps: [String: Task<Void, Never>] = [:]
    private var threadGenerations: [String: UUID] = [:]

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

    func reset() {
        queue.sync {
            for stream in visibilityStreams.values { stream.cancel() }
            for stream in threadStreams.values { stream.cancel() }
            for task in threadBootstraps.values { task.cancel() }
            visibilityStreams.removeAll()
            threadStreams.removeAll()
            threadBootstraps.removeAll()
            threadGenerations.removeAll()
        }
    }

    func handleProjectsWatch(_ request: AgentProjectsWatch) {
        let subscriptionId = request.subscriptionId
        let handle = client.openProjectsStream(
            onSnapshot: { [weak self] snapshot in
                self?.sendCodable(AgentProjectsPush(
                    subscriptionId: subscriptionId,
                    projects: snapshot.projects.map(Self.wireProject)
                ))
            },
            onError: { [weak self] error in
                self?.sendCodable(AgentProjectsError(
                    subscriptionId: subscriptionId,
                    reason: error.localizedDescription
                ))
                self?.removeVisibilityStream(subscriptionId)
            }
        )
        replaceVisibilityStream(subscriptionId, with: handle)
    }

    func handleProjectsUnwatch(_ request: AgentProjectsUnwatch) {
        removeVisibilityStream(request.subscriptionId)
    }

    func handleProjectSessionsWatch(_ request: AgentProjectSessionsWatch) {
        let subscriptionId = request.subscriptionId
        let projectPath = request.projectPath
        let handle = client.openSessionsStream(
            projectPath: projectPath,
            onSnapshot: { [weak self] snapshot in
                self?.sendCodable(AgentProjectSessionsPush(
                    subscriptionId: subscriptionId,
                    projectPath: snapshot.projectPath,
                    sessions: snapshot.sessions.map(Self.wireSession)
                ))
            },
            onError: { [weak self] error in
                self?.sendCodable(AgentProjectSessionsError(
                    subscriptionId: subscriptionId,
                    projectPath: projectPath,
                    reason: error.localizedDescription
                ))
                self?.removeVisibilityStream(subscriptionId)
            }
        )
        replaceVisibilityStream(subscriptionId, with: handle)
    }

    func handleProjectSessionsUnwatch(_ request: AgentProjectSessionsUnwatch) {
        removeVisibilityStream(request.subscriptionId)
    }

    func handleThreadSubscribe(_ request: AgentThreadSubscribe) {
        let source = request.source
        let sessionId = request.sessionId
        guard source == "claude" || source == "codex" else {
            sendCodable(AgentThreadError(source: source, sessionId: sessionId, reason: "invalid source"))
            return
        }
        let key = threadKey(source: source, sessionId: sessionId)
        let generation = UUID()
        queue.sync {
            threadBootstraps.removeValue(forKey: key)?.cancel()
            threadStreams.removeValue(forKey: key)?.cancel()
            threadGenerations[key] = generation
            threadBootstraps[key] = Task { [weak self] in
                await self?.bootstrapThread(
                    source: source,
                    sessionId: sessionId,
                    generation: generation
                )
            }
        }
    }

    func handleThreadLoadOlder(_ request: AgentThreadLoadOlder) {
        Task {
            do {
                let offset = max(0, request.beforeIndex - request.limit)
                let page = try await client.fetchEventsPage(
                    source: request.source,
                    sessionId: request.sessionId,
                    offset: offset,
                    limit: request.beforeIndex - offset
                )
                sendCodable(AgentThreadChunk(
                    source: request.source,
                    sessionId: request.sessionId,
                    events: page.events.map(Self.wireEvent),
                    windowStart: offset,
                    total: page.total,
                    isLive: false,
                    usage: Self.wireUsage(page.usage)
                ))
            } catch {
                sendCodable(AgentThreadError(
                    source: request.source,
                    sessionId: request.sessionId,
                    reason: error.localizedDescription
                ))
            }
        }
    }

    func handleThreadUnsubscribe(_ request: AgentThreadUnsubscribe) {
        let key = threadKey(source: request.source, sessionId: request.sessionId)
        queue.sync {
            threadGenerations.removeValue(forKey: key)
            threadBootstraps.removeValue(forKey: key)?.cancel()
            threadStreams.removeValue(forKey: key)?.cancel()
        }
    }

    func handleRawEvent(_ request: AgentRawEventRequest) {
        guard request.eventIndex >= 0 else {
            sendCodable(AgentRawEventError(
                requestId: request.requestId,
                source: request.source,
                sessionId: request.sessionId,
                eventIndex: request.eventIndex,
                reason: "invalid event index"
            ))
            return
        }
        Task {
            do {
                let text = try await client.fetchRawEvent(
                    source: request.source,
                    sessionId: request.sessionId,
                    eventIndex: request.eventIndex
                )
                try sendRawEvent(text, request: request)
            } catch {
                sendCodable(AgentRawEventError(
                    requestId: request.requestId,
                    source: request.source,
                    sessionId: request.sessionId,
                    eventIndex: request.eventIndex,
                    reason: error.localizedDescription
                ))
            }
        }
    }

    private func openThreadStream(
        source: String,
        sessionId: String,
        after: Int,
        generation: UUID
    ) {
        let key = threadKey(source: source, sessionId: sessionId)
        let handle = client.openEventStream(
            source: source,
            sessionId: sessionId,
            after: after,
            onEvent: { [weak self] event in
                self?.sendCodable(AgentThreadChunk(
                    source: source,
                    sessionId: sessionId,
                    events: [Self.wireEvent(event)],
                    windowStart: event.index,
                    total: event.index + 1,
                    isLive: true,
                    usage: Self.wireUsage(event.usage)
                ))
            },
            onError: { [weak self] error in
                self?.sendCodable(AgentThreadError(
                    source: source,
                    sessionId: sessionId,
                    reason: error.localizedDescription
                ))
                self?.removeThreadStream(key)
            }
        )
        queue.sync {
            guard threadGenerations[key] == generation else {
                handle.cancel()
                return
            }
            threadStreams.removeValue(forKey: key)?.cancel()
            threadStreams[key] = handle
        }
    }

    private func bootstrapThread(
        source: String,
        sessionId: String,
        generation: UUID
    ) async {
        let key = threadKey(source: source, sessionId: sessionId)
        do {
            let probe = try await client.fetchEventsPage(
                source: source,
                sessionId: sessionId,
                offset: 0,
                limit: 1
            )
            guard isCurrentThread(key: key, generation: generation) else { return }
            let offset = max(0, probe.total - Self.pageSize)
            let page = offset < probe.total
                ? try await client.fetchEventsPage(
                    source: source,
                    sessionId: sessionId,
                    offset: offset,
                    limit: probe.total - offset
                )
                : AgentFeedEventsPage(events: [], total: probe.total, usage: probe.usage)
            guard isCurrentThread(key: key, generation: generation) else { return }
            sendCodable(AgentThreadChunk(
                source: source,
                sessionId: sessionId,
                events: page.events.map(Self.wireEvent),
                windowStart: offset,
                total: page.total,
                isLive: false,
                usage: Self.wireUsage(page.usage)
            ))
            openThreadStream(
                source: source,
                sessionId: sessionId,
                after: page.total,
                generation: generation
            )
        } catch {
            guard isCurrentThread(key: key, generation: generation) else { return }
            sendCodable(AgentThreadError(
                source: source,
                sessionId: sessionId,
                reason: error.localizedDescription
            ))
        }
        finishThreadBootstrap(key: key, generation: generation)
    }

    private func replaceVisibilityStream(_ subscriptionId: String, with handle: SidecarStreamHandle) {
        queue.sync {
            visibilityStreams.removeValue(forKey: subscriptionId)?.cancel()
            visibilityStreams[subscriptionId] = handle
        }
    }

    private func removeVisibilityStream(_ subscriptionId: String) {
        queue.sync {
            visibilityStreams.removeValue(forKey: subscriptionId)?.cancel()
        }
    }

    private func removeThreadStream(_ key: String) {
        queue.sync {
            threadStreams.removeValue(forKey: key)?.cancel()
        }
    }

    private func isCurrentThread(key: String, generation: UUID) -> Bool {
        if Task.isCancelled { return false }
        return queue.sync { threadGenerations[key] == generation }
    }

    private func finishThreadBootstrap(key: String, generation: UUID) {
        queue.sync {
            guard threadGenerations[key] == generation else { return }
            threadBootstraps.removeValue(forKey: key)
        }
    }

    private func threadKey(source: String, sessionId: String) -> String {
        "\(source):\(sessionId)"
    }

    private func sendCodable<T: Encodable>(_ message: T) {
        do {
            send(try JSONEncoder().encode(message))
        } catch {
            logger.error("agent-feed-bridge encode failed: \(String(describing: error), privacy: .public)")
        }
    }

    private func sendRawEvent(_ text: String, request: AgentRawEventRequest) throws {
        let sourceData = Data(text.utf8)
        guard sourceData.count <= AgentRawEventLimits.maximumRecordBytes else {
            throw SidecarClientError.server("raw event exceeds 100 MiB")
        }
        let response = AgentRawEventResponse(
            requestId: request.requestId,
            source: request.source,
            sessionId: request.sessionId,
            eventIndex: request.eventIndex,
            text: text
        )
        let encoded = try JSONEncoder().encode(response)
        if rawEventDeliveryMode == .direct || encoded.count <= QuicSessionStreamFrame.maxFrameLength {
            send(encoded)
            return
        }
        try AgentRawEventFragmenter.forEachPart(
            data: sourceData,
            requestId: request.requestId,
            source: request.source,
            sessionId: request.sessionId,
            eventIndex: request.eventIndex
        ) { part in
            let frame = try JSONEncoder().encode(part)
            guard frame.count <= QuicSessionStreamFrame.maxFrameLength else {
                throw QuicSessionFrameError.frameTooLarge
            }
            send(frame)
        }
    }

    private static func wireProject(_ project: AgentFeedProjectSummary) -> AgentProjectSummary {
        AgentProjectSummary(
            projectPath: project.projectPath,
            displayName: project.displayName,
            sourceCounts: AgentProjectSourceCounts(
                claude: project.sourceCounts.claude,
                codex: project.sourceCounts.codex
            ),
            sessionCount: project.sessionCount,
            lastEventAt: project.lastEventAt
        )
    }

    private static func wireSession(_ session: AgentFeedSessionSummary) -> AgentSessionSummary {
        AgentSessionSummary(
            sessionId: session.sessionId,
            source: session.source,
            title: session.title,
            lastEventAt: session.lastEventAt,
            activity: session.activity
        )
    }

    private static func wireUsage(_ usage: AgentFeedTokenUsage?) -> TokenUsage? {
        guard let usage else { return nil }
        return TokenUsage(
            current: usage.current,
            limit: usage.limit,
            updatedAt: usage.updatedAt,
            model: usage.model
        )
    }

    private static func wireEvent(_ event: AgentFeedActivityEvent) -> ActivityEvent {
        ActivityEvent(
            index: event.index,
            ts: event.ts,
            type: event.type,
            blocks: event.blocks.map {
                ActivityBlock(
                    kind: $0.kind,
                    label: $0.label,
                    text: $0.text,
                    tool: $0.tool,
                    summary: $0.summary,
                    preview: $0.preview,
                    callId: $0.callId
                )
            }
        )
    }
}
