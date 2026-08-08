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
    /// Per-thread live-tail streams (the claude live mirror), opened alongside the
    /// durable `threadStreams` stream for `canStreamLive` sessions and torn down
    /// with it.
    private var threadTailStreams: [String: SidecarStreamHandle] = [:]
    private var extensionUIStreams: [String: SidecarStreamHandle] = [:]
    private var threadBootstraps: [String: Task<Void, Never>] = [:]
    private var threadGenerations: [String: UUID] = [:]
    /// Latest per-session capabilities, keyed by `source:sessionId`, so thread
    /// routes can choose the claude live mirror when one exists.
    private var sessionCapabilities: [String: AgentFeedSessionCapabilities] = [:]

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
            for stream in extensionUIStreams.values { stream.cancel() }
            for task in threadBootstraps.values { task.cancel() }
            visibilityStreams.removeAll()
            threadStreams.removeAll()
            threadTailStreams.removeAll()
            extensionUIStreams.removeAll()
            threadBootstraps.removeAll()
            threadGenerations.removeAll()
            sessionCapabilities.removeAll()
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
                guard let self else { return }
                self.queue.sync {
                    for item in snapshot.sessions {
                        self.sessionCapabilities[self.threadKey(source: item.source, sessionId: item.sessionId)] = item.capabilities
                    }
                }
                self.sendCodable(AgentProjectSessionsPush(
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
        guard Self.validSource(source), Self.validRequestIdentifier(sessionId) else {
            sendCodable(AgentThreadError(
                source: source,
                sessionId: sessionId,
                reason: "invalid source or session id"
            ))
            return
        }
        guard let mode = Self.eventMode(request.mode) else {
            sendCodable(AgentThreadError(source: source, sessionId: sessionId, reason: "invalid mode"))
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
                    mode: mode,
                    generation: generation
                )
            }
        }
    }

    func handleThreadLoadOlder(_ request: AgentThreadLoadOlder) {
        guard Self.validSource(request.source),
              Self.validRequestIdentifier(request.sessionId) else {
            sendCodable(AgentThreadError(
                source: request.source,
                sessionId: request.sessionId,
                reason: "invalid source or session id"
            ))
            return
        }
        guard let mode = Self.eventMode(request.mode) else {
            sendCodable(AgentThreadError(
                source: request.source,
                sessionId: request.sessionId,
                reason: "invalid mode"
            ))
            return
        }
        let key = threadKey(source: request.source, sessionId: request.sessionId)
        guard let generation = queue.sync(execute: { threadGenerations[key] }) else {
            sendCodable(AgentThreadError(
                source: request.source,
                sessionId: request.sessionId,
                reason: "thread not subscribed"
            ))
            return
        }
        Task { [weak self] in
            guard let self else { return }
            do {
                let offset = max(0, request.beforeIndex - request.limit)
                let page = try await self.client.fetchEventsPage(
                    source: request.source,
                    sessionId: request.sessionId,
                    offset: offset,
                    limit: request.beforeIndex - offset,
                    mode: mode
                )
                guard self.isCurrentThread(key: key, generation: generation) else { return }
                self.sendCodable(AgentThreadChunk(
                    source: request.source,
                    sessionId: request.sessionId,
                    events: page.events.map(Self.wireEvent),
                    windowStart: offset,
                    total: page.total,
                    isLive: false,
                    usage: Self.wireUsage(page.usage),
                    mode: mode.rawValue,
                    kind: "page",
                    sequence: page.sequence,
                    runState: page.runState,
                    queueSteer: page.queueSteer,
                    queueFollowUp: page.queueFollowUp
                ))
            } catch {
                guard self.isCurrentThread(key: key, generation: generation) else { return }
                self.sendCodable(AgentThreadError(
                    source: request.source,
                    sessionId: request.sessionId,
                    reason: error.localizedDescription
                ))
            }
        }
    }

    func handleThreadUnsubscribe(_ request: AgentThreadUnsubscribe) {
        guard Self.validSource(request.source),
              Self.validRequestIdentifier(request.sessionId) else {
            sendCodable(AgentThreadError(
                source: request.source,
                sessionId: request.sessionId,
                reason: "invalid source or session id"
            ))
            return
        }
        let key = threadKey(source: request.source, sessionId: request.sessionId)
        queue.sync {
            threadGenerations.removeValue(forKey: key)
            threadBootstraps.removeValue(forKey: key)?.cancel()
            threadStreams.removeValue(forKey: key)?.cancel()
            threadTailStreams.removeValue(forKey: key)?.cancel()
            extensionUIStreams.removeValue(forKey: key)?.cancel()
        }
    }

    func handleSessionCreate(_ request: AgentSessionCreate) {
        guard Self.validRequestIdentifier(request.requestId),
              Self.validSource(request.source),
              Self.validNonempty(request.projectPath) else {
            sendInvalidCommand(requestId: request.requestId)
            return
        }
        Task {
            do {
                let session = try await client.createSession(
                    requestId: request.requestId,
                    source: request.source,
                    projectPath: request.projectPath
                )
                sendCodable(AgentCommandReceipt(
                    requestId: request.requestId,
                    source: request.source,
                    sessionId: session.sessionId,
                    delivery: "created",
                    session: Self.wireSession(session)
                ))
            } catch {
                sendCommandError(requestId: request.requestId, error: error)
            }
        }
    }

    func handleSessionSend(_ request: AgentSessionSend) {
        guard Self.validRequestIdentifier(request.requestId),
              Self.validSource(request.source),
              Self.validRequestIdentifier(request.sessionId),
              Self.validNonempty(request.text),
              request.delivery == "next" || request.delivery == "steer" else {
            sendInvalidCommand(requestId: request.requestId)
            return
        }
        Task {
            do {
                let receipt = try await client.sendMessage(
                    requestId: request.requestId,
                    source: request.source,
                    sessionId: request.sessionId,
                    text: request.text,
                    delivery: request.delivery
                )
                sendCodable(AgentCommandReceipt(
                    requestId: receipt.requestId,
                    source: request.source,
                    sessionId: request.sessionId,
                    delivery: receipt.delivery
                ))
            } catch {
                sendCommandError(requestId: request.requestId, error: error)
            }
        }
    }

    func handleSessionAbort(_ request: AgentSessionAbort) {
        guard Self.validRequestIdentifier(request.requestId),
              Self.validSource(request.source),
              Self.validRequestIdentifier(request.sessionId) else {
            sendInvalidCommand(requestId: request.requestId)
            return
        }
        Task {
            do {
                let receipt = try await client.abortSession(
                    requestId: request.requestId,
                    source: request.source,
                    sessionId: request.sessionId
                )
                sendCodable(AgentCommandReceipt(
                    requestId: receipt.requestId,
                    source: request.source,
                    sessionId: request.sessionId,
                    delivery: receipt.delivery
                ))
            } catch {
                sendCommandError(requestId: request.requestId, error: error)
            }
        }
    }

    func handleExtensionUIResponse(_ response: AgentExtensionUIResponse) {
        guard Self.validRequestIdentifier(response.requestId),
              Self.validSource(response.source),
              Self.validRequestIdentifier(response.sessionId) else {
            sendInvalidCommand(requestId: response.requestId)
            return
        }
        Task {
            do {
                let receipt = try await client.respondToExtensionUI(
                    source: response.source,
                    sessionId: response.sessionId,
                    requestId: response.requestId,
                    value: response.value
                )
                sendCodable(AgentCommandReceipt(
                    requestId: receipt.requestId,
                    source: response.source,
                    sessionId: response.sessionId,
                    delivery: receipt.delivery
                ))
            } catch {
                sendCommandError(requestId: response.requestId, error: error)
            }
        }
    }

    func handleRawEvent(_ request: AgentRawEventRequest) {
        guard Self.validRequestIdentifier(request.requestId),
              Self.validSource(request.source),
              Self.validRequestIdentifier(request.sessionId) else {
            sendCodable(AgentRawEventError(
                requestId: request.requestId,
                source: request.source,
                sessionId: request.sessionId,
                eventIndex: request.eventIndex,
                reason: "invalid source, session id, or request id"
            ))
            return
        }
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
        guard let mode = Self.eventMode(request.mode) else {
            sendCodable(AgentRawEventError(
                requestId: request.requestId,
                source: request.source,
                sessionId: request.sessionId,
                eventIndex: request.eventIndex,
                reason: "invalid mode"
            ))
            return
        }
        Task {
            do {
                let text = try await client.fetchRawEvent(
                    source: request.source,
                    sessionId: request.sessionId,
                    eventIndex: request.eventIndex,
                    mode: mode
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
        afterSequence: Int,
        mode: AgentFeedEventMode,
        generation: UUID
    ) {
        let key = threadKey(source: source, sessionId: sessionId)
        // The durable transcript stream is ALWAYS the base conversation list: it
        // backfills full history and streams realtime rows as the transcript is
        // written. A `canStreamLive` claude session additionally gets a live
        // mirror stream whose in-flight message the panel renders as a tail.
        let durable = client.openEventStream(
            source: source,
            sessionId: sessionId,
            afterSequence: afterSequence,
            mode: mode,
            onEnvelope: { [weak self] envelope in
                self?.deliverEnvelope(
                    source: source,
                    sessionId: sessionId,
                    envelope: envelope,
                    mode: mode,
                    key: key,
                    generation: generation
                )
            },
            onError: { [weak self] error in
                self?.threadStreamError(source: source, sessionId: sessionId, error: error, key: key, generation: generation)
            }
        )
        queue.sync {
            guard threadGenerations[key] == generation else {
                durable.cancel()
                return
            }
            threadStreams.removeValue(forKey: key)?.cancel()
            threadStreams[key] = durable
        }
        guard isClaudeLive(source, sessionId) else { return }
        let tail = client.openClaudeLiveStream(
            source: source,
            sessionId: sessionId,
            afterSequence: 0,
            mode: mode,
            onEnvelope: { [weak self] envelope in
                guard let self else { return }
                guard let event = envelope.events.first else { return }
                guard self.isCurrentThread(key: key, generation: generation) else { return }
                self.sendCodable(AgentLiveTail(
                    source: source,
                    sessionId: sessionId,
                    event: Self.wireEvent(event)
                ))
            },
            onError: { [weak self] error in
                self?.threadTailError(source: source, sessionId: sessionId, key: key, generation: generation)
            }
        )
        queue.sync {
            guard threadGenerations[key] == generation else {
                tail.cancel()
                return
            }
            threadTailStreams.removeValue(forKey: key)?.cancel()
            threadTailStreams[key] = tail
        }
    }

    private func threadTailError(source: String, sessionId: String, key: String, generation: UUID) {
        guard isCurrentThread(key: key, generation: generation) else { return }
        // The mirror went away; clear the tail rather than leaving a stale block.
        sendCodable(AgentLiveTail(source: source, sessionId: sessionId, event: nil))
        queue.sync {
            threadTailStreams.removeValue(forKey: key)?.cancel()
        }
    }

    private func deliverEnvelope(
        source: String,
        sessionId: String,
        envelope: AgentFeedTimelineEnvelope,
        mode: AgentFeedEventMode,
        key: String,
        generation: UUID
    ) {
        guard isCurrentThread(key: key, generation: generation) else { return }
        sendCodable(AgentThreadChunk(
            source: source,
            sessionId: sessionId,
            events: envelope.events.map(Self.wireEvent),
            windowStart: envelope.windowStart,
            total: envelope.total,
            isLive: true,
            usage: Self.wireUsage(envelope.usage),
            mode: mode.rawValue,
            kind: envelope.kind,
            sequence: envelope.sequence,
            runState: envelope.runState,
            queueSteer: envelope.queue.steer,
            queueFollowUp: envelope.queue.followUp
        ))
    }

    private func threadStreamError(source: String, sessionId: String, error: Error, key: String, generation: UUID) {
        guard isCurrentThread(key: key, generation: generation) else { return }
        sendCodable(AgentThreadError(
            source: source,
            sessionId: sessionId,
            reason: error.localizedDescription
        ))
        removeThreadStream(key)
    }

    private func isClaudeLive(_ source: String, _ sessionId: String) -> Bool {
        // The live tail is a capability, not a source: any session whose backend
        // advertises canStreamLive (claude, codex) gets the streaming mirror.
        return queue.sync { sessionCapabilities[threadKey(source: source, sessionId: sessionId)]?.canStreamLive ?? false } == true
    }

    private func openExtensionUIStream(source: String, sessionId: String, generation: UUID) {
        guard source == "pi" else { return }
        let key = threadKey(source: source, sessionId: sessionId)
        let handle = client.openExtensionUIStream(
            source: source,
            sessionId: sessionId,
            onEvent: { [weak self] event in
                guard let self, self.isCurrentThread(key: key, generation: generation) else { return }
                switch event.type {
                case "request":
                    guard let request = event.request else { return }
                    self.sendCodable(Self.wireExtensionUI(request, source: source, sessionId: sessionId))
                case "dismiss":
                    guard let requestId = event.requestId else { return }
                    self.sendCodable(AgentExtensionUIDismissed(
                        source: source,
                        sessionId: sessionId,
                        requestId: requestId
                    ))
                default:
                    return
                }
            },
            onError: { [weak self] error in
                guard let self, self.isCurrentThread(key: key, generation: generation) else { return }
                self.sendCodable(AgentThreadError(
                    source: source,
                    sessionId: sessionId,
                    reason: "extension UI stream: \(error.localizedDescription)"
                ))
                self.removeExtensionUIStream(key)
            }
        )
        queue.sync {
            guard threadGenerations[key] == generation else {
                handle.cancel()
                return
            }
            extensionUIStreams.removeValue(forKey: key)?.cancel()
            extensionUIStreams[key] = handle
        }
    }

    private func bootstrapThread(
        source: String,
        sessionId: String,
        mode: AgentFeedEventMode,
        generation: UUID
    ) async {
        let key = threadKey(source: source, sessionId: sessionId)
        do {
            let probe = try await client.fetchEventsPage(
                source: source,
                sessionId: sessionId,
                offset: 0,
                limit: 1,
                mode: mode
            )
            guard isCurrentThread(key: key, generation: generation) else { return }
            let offset = max(0, probe.total - Self.pageSize)
            let page: AgentFeedEventsPage
            if offset < probe.total {
                page = try await client.fetchEventsPage(
                    source: source,
                    sessionId: sessionId,
                    offset: offset,
                    limit: probe.total - offset,
                    mode: mode
                )
            } else {
                page = AgentFeedEventsPage(
                    events: [],
                    total: probe.total,
                    usage: probe.usage,
                    sequence: probe.sequence,
                    runState: probe.runState,
                    queueSteer: probe.queueSteer,
                    queueFollowUp: probe.queueFollowUp
                )
            }
            guard isCurrentThread(key: key, generation: generation) else { return }
            sendCodable(AgentThreadChunk(
                source: source,
                sessionId: sessionId,
                events: page.events.map(Self.wireEvent),
                windowStart: offset,
                total: page.total,
                isLive: false,
                usage: Self.wireUsage(page.usage),
                mode: mode.rawValue,
                kind: "snapshot",
                sequence: page.sequence,
                runState: page.runState,
                queueSteer: page.queueSteer,
                queueFollowUp: page.queueFollowUp
            ))
            openThreadStream(
                source: source,
                sessionId: sessionId,
                afterSequence: page.sequence,
                mode: mode,
                generation: generation
            )
            openExtensionUIStream(source: source, sessionId: sessionId, generation: generation)
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

    private func removeExtensionUIStream(_ key: String) {
        queue.sync {
            extensionUIStreams.removeValue(forKey: key)?.cancel()
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

    private func sendCommandError(requestId: String, error: Error) {
        if case let SidecarClientError.command(code, message, sidecarRequestId, retryable) = error {
            sendCodable(AgentCommandError(
                requestId: sidecarRequestId ?? requestId,
                code: code,
                message: message,
                retryable: retryable
            ))
            return
        }
        sendCodable(AgentCommandError(
            requestId: requestId,
            code: "agent-command-failed",
            message: error.localizedDescription,
            retryable: true
        ))
    }

    private func sendInvalidCommand(requestId: String) {
        sendCodable(AgentCommandError(
            requestId: requestId,
            code: "invalid-agent-command",
            message: "agent command contains an invalid source, identifier, or value",
            retryable: false
        ))
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
            sourceCounts: project.sourceCounts.values,
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
            activity: session.activity,
            capabilities: AgentSessionCapabilities(
                modes: session.capabilities.modes,
                canSend: session.capabilities.canSend,
                canSteer: session.capabilities.canSteer,
                canAbort: session.capabilities.canAbort,
                canFetchRaw: session.capabilities.canFetchRaw,
                canOpenTerminal: session.capabilities.canOpenTerminal,
                supportsExtensionUI: session.capabilities.supportsExtensionUi,
                canStreamLive: session.capabilities.canStreamLive
            )
        )
    }

    /// An ABSENT mode means `raw`, the fidelity view and what every caller meant before modes existed.
    /// A PRESENT but unrecognized mode is rejected rather than defaulted: the reply's indices would be
    /// counted in a view the caller did not ask for, and nothing downstream could tell.
    private static func eventMode(_ raw: String?) -> AgentFeedEventMode? {
        guard let raw else { return .raw }
        return AgentFeedEventMode(rawValue: raw)
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
            id: event.id,
            index: event.index,
            revision: event.revision,
            phase: event.phase,
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
                    callId: $0.callId,
                    input: $0.input,
                    hiddenChars: $0.hiddenChars,
                    hiddenLines: $0.hiddenLines
                )
            },
            otherModeIndex: event.otherModeIndex,
            messageId: event.messageId
        )
    }

    private static func wireExtensionUI(
        _ request: AgentFeedExtensionUIRequest,
        source: String,
        sessionId: String
    ) -> AgentExtensionUIRequest {
        AgentExtensionUIRequest(
            source: source,
            sessionId: sessionId,
            requestId: request.requestId,
            kind: request.kind,
            title: request.title,
            message: request.message,
            options: request.options,
            placeholder: request.placeholder,
            prefill: request.prefill,
            level: request.level,
            key: request.key,
            lines: request.lines,
            expectsResponse: request.expectsResponse
        )
    }

    private static func validSource(_ source: String) -> Bool {
        source.range(of: #"^[a-z][a-z0-9-]{0,31}$"#, options: .regularExpression) != nil
    }

    private static func validRequestIdentifier(_ value: String) -> Bool {
        !value.isEmpty && value.count <= 128 &&
            value.range(of: #"^[A-Za-z0-9._:-]+$"#, options: .regularExpression) != nil
    }

    private static func validNonempty(_ value: String) -> Bool {
        !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
