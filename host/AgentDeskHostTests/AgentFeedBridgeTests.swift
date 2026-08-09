import Foundation
import Testing
import AgentDeskWire

@testable import AgentDeskHost

// Named structs rather than tuples so a test can read `.mode` without every call site
// depending on positional order.
struct EventRequest {
    let source: String
    let sessionId: String
    let offset: Int
    let limit: Int
    let mode: AgentFeedEventMode
}

struct RawRequest {
    let source: String
    let sessionId: String
    let eventIndex: Int
    let mode: AgentFeedEventMode
}

final class FakeSidecarClient: SidecarClient, @unchecked Sendable {
    var projects = AgentFeedProjectsSnapshot(projects: [])
    var sessions = AgentFeedSessionsSnapshot(projectPath: "/project", sessions: [])
    var eventsPage = AgentFeedEventsPage(events: [], total: 0)
    var rawEvent = ""
    var eventFetchDelayMilliseconds = 0
    var messageError: Error?

    private let lock = NSLock()
    private var projectSnapshot: (@Sendable (AgentFeedProjectsSnapshot) -> Void)?
    private var projectError: (@Sendable (Error) -> Void)?
    private var sessionSnapshot: (@Sendable (AgentFeedSessionsSnapshot) -> Void)?
    private var sessionError: (@Sendable (Error) -> Void)?
    private var eventCallbacks: [String: @Sendable (AgentFeedTimelineEnvelope) -> Void] = [:]
    private var uiCallbacks: [String: @Sendable (AgentFeedExtensionUIEvent) -> Void] = [:]
    private var eventErrorHistory: [@Sendable (Error) -> Void] = []
    private var _cancelledStreams = 0
    private var _eventRequests: [EventRequest] = []
    private var _rawRequests: [RawRequest] = []
    private var _openedEventStreams = 0
    private var _streamModes: [AgentFeedEventMode] = []
    private var _liveCommandCalls = 0

    var cancelledStreams: Int { lock.withLock { _cancelledStreams } }
    var eventRequests: [EventRequest] { lock.withLock { _eventRequests } }
    var rawRequests: [RawRequest] { lock.withLock { _rawRequests } }
    var streamModes: [AgentFeedEventMode] { lock.withLock { _streamModes } }
    var openedEventStreams: Int { lock.withLock { _openedEventStreams } }
    var openedUIStreams: Int { lock.withLock { uiCallbacks.count } }
    var liveCommandCalls: Int { lock.withLock { _liveCommandCalls } }

    func fetchProjects() async throws -> AgentFeedProjectsSnapshot {
        projects
    }

    func fetchSessions(projectPath: String) async throws -> AgentFeedSessionsSnapshot {
        sessions
    }

    func fetchEventsPage(
        source: String,
        sessionId: String,
        offset: Int,
        limit: Int,
        mode: AgentFeedEventMode
    ) async throws -> AgentFeedEventsPage {
        lock.withLock {
            _eventRequests.append(EventRequest(
                source: source, sessionId: sessionId, offset: offset, limit: limit, mode: mode
            ))
        }
        if eventFetchDelayMilliseconds > 0 {
            try await Task.sleep(for: .milliseconds(eventFetchDelayMilliseconds))
        }
        return eventsPage
    }

    func fetchRawEvent(
        source: String,
        sessionId: String,
        eventIndex: Int,
        mode: AgentFeedEventMode
    ) async throws -> String {
        lock.withLock {
            _rawRequests.append(RawRequest(
                source: source, sessionId: sessionId, eventIndex: eventIndex, mode: mode
            ))
        }
        return rawEvent
    }

    func openProjectsStream(
        onSnapshot: @escaping @Sendable (AgentFeedProjectsSnapshot) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> SidecarStreamHandle {
        lock.withLock {
            projectSnapshot = onSnapshot
            projectError = onError
        }
        return cancellableHandle()
    }

    func openSessionsStream(
        projectPath: String,
        onSnapshot: @escaping @Sendable (AgentFeedSessionsSnapshot) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> SidecarStreamHandle {
        lock.withLock {
            sessionSnapshot = onSnapshot
            sessionError = onError
        }
        return cancellableHandle()
    }

    func openEventStream(
        source: String,
        sessionId: String,
        afterSequence: Int,
        mode: AgentFeedEventMode,
        onEnvelope: @escaping @Sendable (AgentFeedTimelineEnvelope) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> SidecarStreamHandle {
        lock.withLock {
            _openedEventStreams += 1
            _streamModes.append(mode)
            eventCallbacks["\(source):\(sessionId)"] = onEnvelope
            eventErrorHistory.append(onError)
        }
        return cancellableHandle()
    }

    func openClaudeLiveStream(
        source: String,
        sessionId: String,
        afterSequence: Int,
        mode: AgentFeedEventMode,
        onEnvelope: @escaping @Sendable (AgentFeedTimelineEnvelope) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> SidecarStreamHandle {
        lock.withLock {
            _openedEventStreams += 1
            _streamModes.append(mode)
            eventCallbacks["\(source):\(sessionId)"] = onEnvelope
            eventErrorHistory.append(onError)
        }
        return cancellableHandle()
    }

    func fetchClaudeLiveEventsPage(source: String, sessionId: String, offset: Int, limit: Int, mode: AgentFeedEventMode) async throws -> AgentFeedEventsPage {
        lock.withLock {
            _eventRequests.append(EventRequest(source: "claude", sessionId: sessionId, offset: offset, limit: limit, mode: mode))
        }
        return eventsPage
    }

    func pushProjects() {
        let callback = lock.withLock { projectSnapshot }
        callback?(projects)
    }

    func pushSessions() {
        let callback = lock.withLock { sessionSnapshot }
        callback?(sessions)
    }

    func pushEvent(source: String, sessionId: String, event: AgentFeedActivityEvent) {
        let callback = lock.withLock { eventCallbacks["\(source):\(sessionId)"] }
        callback?(AgentFeedTimelineEnvelope(
            kind: "upsert",
            sequence: event.index + 1,
            mode: "nice",
            events: [event],
            windowStart: event.index,
            total: event.index + 1,
            runState: "running",
            queue: AgentFeedQueueState(steer: 0, followUp: 0),
            usage: event.usage
        ))
    }

    /// Pushes a live envelope carrying a caller-chosen mode, so tests can prove a
    /// raw-mode claude live stream is delivered with `md: raw` (not dropped).
    func pushClaudeLiveEvent(source: String, sessionId: String, event: AgentFeedActivityEvent, mode: AgentFeedEventMode) {
        let callback = lock.withLock { eventCallbacks["\(source):\(sessionId)"] }
        callback?(AgentFeedTimelineEnvelope(
            kind: "upsert",
            sequence: event.index + 1,
            mode: mode.rawValue,
            events: [event],
            windowStart: event.index,
            total: event.index + 1,
            runState: "running",
            queue: AgentFeedQueueState(steer: 0, followUp: 0),
            usage: event.usage
        ))
    }

    func failEventStream(at index: Int, error: Error) {
        let callback = lock.withLock { eventErrorHistory[index] }
        callback(error)
    }

    func createSession(requestId: String, source: String, projectPath: String) async throws -> AgentFeedSessionSummary {
        lock.withLock { _liveCommandCalls += 1 }
        return AgentFeedSessionSummary(sessionId: "created", source: source, title: "Created", lastEventAt: 1, activity: "ready", capabilities: piCapabilities())
    }

    func sendMessage(requestId: String, source: String, sessionId: String, text: String, delivery: String) async throws -> AgentFeedCommandReceipt {
        lock.withLock { _liveCommandCalls += 1 }
        if let messageError { throw messageError }
        return AgentFeedCommandReceipt(requestId: requestId, delivery: delivery == "steer" ? "steer" : "immediate")
    }

    func abortSession(requestId: String, source: String, sessionId: String) async throws -> AgentFeedCommandReceipt {
        lock.withLock { _liveCommandCalls += 1 }
        return AgentFeedCommandReceipt(requestId: requestId, delivery: "abort")
    }

    func openExtensionUIStream(source: String, sessionId: String, onEvent: @escaping @Sendable (AgentFeedExtensionUIEvent) -> Void, onError: @escaping @Sendable (Error) -> Void) -> SidecarStreamHandle {
        lock.withLock { uiCallbacks["\(source):\(sessionId)"] = onEvent }
        return cancellableHandle()
    }

    func pushUIEvent(source: String, sessionId: String, event: AgentFeedExtensionUIEvent) {
        let callback = lock.withLock { uiCallbacks["\(source):\(sessionId)"] }
        callback?(event)
    }

    func respondToExtensionUI(source: String, sessionId: String, requestId: String, value: AgentJSONValue) async throws -> AgentFeedCommandReceipt {
        lock.withLock { _liveCommandCalls += 1 }
        return AgentFeedCommandReceipt(requestId: requestId, delivery: "ui")
    }

    private func cancellableHandle() -> SidecarStreamHandle {
        let task = Task<Void, Never> { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(20))
            }
            self?.lock.withLock { self?._cancelledStreams += 1 }
        }
        return SidecarStreamHandle(task: task)
    }
}

final class CapturingSink: @unchecked Sendable {
    private let lock = NSLock()
    private var frames: [Data] = []

    var count: Int { lock.withLock { frames.count } }

    func accept(_ data: Data) {
        lock.withLock { frames.append(data) }
    }

    func decode<T: Decodable>(_ type: T.Type, at index: Int) throws -> T {
        try JSONDecoder().decode(type, from: lock.withLock { frames[index] })
    }

    func data(at index: Int) -> Data {
        lock.withLock { frames[index] }
    }
}

private func waitFor(
    _ predicate: @escaping @Sendable () -> Bool,
    timeout: Duration = .seconds(2)
) async {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: timeout)
    while clock.now < deadline {
        if predicate() { return }
        try? await Task.sleep(for: .milliseconds(5))
    }
}

private func event(index: Int, cacheHit: AgentFeedEventCacheHit? = nil) -> AgentFeedActivityEvent {
    AgentFeedActivityEvent(
        id: "event-\(index)",
        index: index,
        revision: 0,
        phase: "complete",
        ts: 1_700_000_000_000,
        type: "assistant",
        blocks: [AgentFeedActivityBlock(kind: "text", text: "hello")],
        cacheHit: cacheHit
    )
}

private func piCapabilities() -> AgentFeedSessionCapabilities {
    AgentFeedSessionCapabilities(modes: ["nice"], canSend: true, canSteer: true, canAbort: true, canFetchRaw: false, canOpenTerminal: false, supportsExtensionUi: true)
}

private func transcriptCapabilities() -> AgentFeedSessionCapabilities {
    AgentFeedSessionCapabilities(modes: ["raw", "nice"], canSend: false, canSteer: false, canAbort: false, canFetchRaw: true, canOpenTerminal: true, supportsExtensionUi: false)
}

private func claudeLiveCapabilities() -> AgentFeedSessionCapabilities {
    AgentFeedSessionCapabilities(modes: ["raw", "nice"], canSend: false, canSteer: false, canAbort: false, canFetchRaw: true, canOpenTerminal: true, supportsExtensionUi: false, canStreamLive: true)
}

struct AgentFeedBridgeTests {
    @Test func projectAndSessionWatchesEchoSubscriptionIdentity() async throws {
        let fake = FakeSidecarClient()
        fake.projects = AgentFeedProjectsSnapshot(projects: [
            AgentFeedProjectSummary(
                projectPath: "/project",
                displayName: "project",
                sourceCounts: AgentFeedProjectSourceCounts(values: ["claude": 1, "codex": 1]),
                sessionCount: 2,
                lastEventAt: 10
            ),
        ])
        fake.sessions = AgentFeedSessionsSnapshot(projectPath: "/project", sessions: [
            AgentFeedSessionSummary(
                sessionId: "shared",
                source: "claude",
                title: "Claude thread",
                lastEventAt: 10,
                activity: "live",
                capabilities: transcriptCapabilities()
            ),
            AgentFeedSessionSummary(
                sessionId: "shared",
                source: "codex",
                title: "Codex thread",
                lastEventAt: 9,
                activity: "ready",
                capabilities: transcriptCapabilities()
            ),
        ])
        let sink = CapturingSink()
        let bridge = AgentFeedBridge(client: fake, send: sink.accept)

        bridge.handleProjectsWatch(AgentProjectsWatch(subscriptionId: "projects-1"))
        fake.pushProjects()
        await waitFor { sink.count == 1 }
        let projects = try sink.decode(AgentProjectsPush.self, at: 0)
        #expect(projects.subscriptionId == "projects-1")
        #expect(projects.projects[0].sessionCount == 2)
        #expect(projects.projects[0].sourceCounts == ["claude": 1, "codex": 1])

        bridge.handleProjectSessionsWatch(AgentProjectSessionsWatch(
            subscriptionId: "sessions-1",
            projectPath: "/project"
        ))
        fake.pushSessions()
        await waitFor { sink.count == 2 }
        let sessions = try sink.decode(AgentProjectSessionsPush.self, at: 1)
        #expect(sessions.subscriptionId == "sessions-1")
        #expect(sessions.projectPath == "/project")
        #expect(sessions.sessions.map(\.source) == ["claude", "codex"])
        #expect(sessions.sessions.map(\.sessionId) == ["shared", "shared"])
    }

    @Test func unwatchAndResetCancelEveryVisibilityAndThreadStream() async {
        let fake = FakeSidecarClient()
        let bridge = AgentFeedBridge(client: fake, send: { _ in })
        bridge.handleProjectsWatch(AgentProjectsWatch(subscriptionId: "projects"))
        bridge.handleProjectSessionsWatch(AgentProjectSessionsWatch(
            subscriptionId: "sessions",
            projectPath: "/project"
        ))
        bridge.handleProjectsUnwatch(AgentProjectsUnwatch(subscriptionId: "projects"))
        await waitFor { fake.cancelledStreams == 1 }

        bridge.handleThreadSubscribe(AgentThreadSubscribe(source: "codex", sessionId: "thread"))
        try? await Task.sleep(for: .milliseconds(30))
        bridge.reset()
        await waitFor { fake.cancelledStreams == 3 }
        #expect(fake.cancelledStreams == 3)
    }

    @Test func cacheHitSurvivesTheBridgeToTheWireEvent() async throws {
        let fake = FakeSidecarClient()
        fake.eventsPage = AgentFeedEventsPage(events: [event(index: 0, cacheHit: AgentFeedEventCacheHit(cached: 300, input: 800))], total: 1)
        let sink = CapturingSink()
        let bridge = AgentFeedBridge(client: fake, send: sink.accept)

        bridge.handleThreadSubscribe(AgentThreadSubscribe(source: "codex", sessionId: "thread"))
        await waitFor { sink.count == 1 }

        let chunk = try sink.decode(AgentThreadChunk.self, at: 0)
        #expect(chunk.events.first?.cacheHit == EventCacheHit(cached: 300, input: 800))
    }

    @Test func sameSessionIDAcrossSourcesUsesIndependentThreadStreams() async throws {        let fake = FakeSidecarClient()
        fake.eventsPage = AgentFeedEventsPage(events: [event(index: 0)], total: 1)
        let sink = CapturingSink()
        let bridge = AgentFeedBridge(client: fake, send: sink.accept)

        bridge.handleThreadSubscribe(AgentThreadSubscribe(source: "claude", sessionId: "shared"))
        bridge.handleThreadSubscribe(AgentThreadSubscribe(source: "codex", sessionId: "shared"))
        await waitFor { sink.count == 2 }

        let first = try sink.decode(AgentThreadChunk.self, at: 0)
        let second = try sink.decode(AgentThreadChunk.self, at: 1)
        #expect(Set([first.source, second.source]) == ["claude", "codex"])
        #expect(fake.eventRequests.map(\.source).contains("claude"))
        #expect(fake.eventRequests.map(\.source).contains("codex"))

        fake.pushEvent(source: "codex", sessionId: "shared", event: event(index: 1))
        await waitFor { sink.count == 3 }
        let live = try sink.decode(AgentThreadChunk.self, at: 2)
        #expect(live.source == "codex")
        #expect(live.sessionId == "shared")
        #expect(live.isLive)
    }

    @Test func claudeLiveSessionOpensDurableBaseAndDeliversLiveTail() async throws {
        let fake = FakeSidecarClient()
        fake.sessions = AgentFeedSessionsSnapshot(projectPath: "/project", sessions: [
            AgentFeedSessionSummary(sessionId: "thread", source: "claude", title: "Claude", lastEventAt: 1, activity: "ready", capabilities: claudeLiveCapabilities())
        ])
        let sink = CapturingSink()
        let bridge = AgentFeedBridge(client: fake, send: sink.accept)

        // The sessions snapshot populates the live-capability cache.
        bridge.handleProjectSessionsWatch(AgentProjectSessionsWatch(subscriptionId: "s", projectPath: "/project"))
        fake.pushSessions()
        await waitFor { sink.count == 1 }

        // A subscribe to a claude live session opens the durable transcript
        // base AND the live tail, in the requested mode.
        bridge.handleThreadSubscribe(AgentThreadSubscribe(source: "claude", sessionId: "thread", mode: "raw"))
        await waitFor { fake.openedEventStreams >= 2 }
        #expect(fake.streamModes.contains(.raw))
        #expect(fake.eventRequests.map(\.source).contains("claude"))

        // A live mirror message arrives as a live tail (not a thread chunk).
        fake.pushClaudeLiveEvent(source: "claude", sessionId: "thread", event: event(index: 0), mode: .raw)
        await waitFor { sink.count >= 3 }
        let snapshot = try sink.decode(AgentThreadChunk.self, at: 1)
        #expect(snapshot.mode == "raw")
        let tail = try sink.decode(AgentLiveTail.self, at: 2)
        #expect(tail.source == "claude")
        #expect(tail.sessionId == "thread")
        #expect(tail.event?.index == 0)
    }

    @Test func unsubscribeDuringBootstrapNeverOpensOrPushesTheThread() async {
        let fake = FakeSidecarClient()
        fake.eventFetchDelayMilliseconds = 100
        fake.eventsPage = AgentFeedEventsPage(events: [event(index: 0)], total: 1)
        let sink = CapturingSink()
        let bridge = AgentFeedBridge(client: fake, send: sink.accept)
        let identity = AgentThreadSubscribe(source: "codex", sessionId: "closing")

        bridge.handleThreadSubscribe(identity)
        bridge.handleThreadUnsubscribe(AgentThreadUnsubscribe(
            source: identity.source,
            sessionId: identity.sessionId
        ))
        try? await Task.sleep(for: .milliseconds(150))

        #expect(sink.count == 0)
        #expect(fake.openedEventStreams == 0)
    }

    @Test func aReplacedStreamCannotPublishAnErrorIntoTheNewGeneration() async throws {
        let fake = FakeSidecarClient()
        let sink = CapturingSink()
        let bridge = AgentFeedBridge(client: fake, send: sink.accept)
        let subscription = AgentThreadSubscribe(source: "pi", sessionId: "shared", mode: "nice")

        bridge.handleThreadSubscribe(subscription)
        await waitFor { fake.openedEventStreams == 1 && sink.count == 1 }
        bridge.handleThreadSubscribe(subscription)
        await waitFor { fake.openedEventStreams == 2 && sink.count == 2 }

        fake.failEventStream(at: 0, error: SidecarClientError.server("old stream failed"))
        try await Task.sleep(for: .milliseconds(25))
        fake.pushEvent(source: "pi", sessionId: "shared", event: event(index: 0))
        await waitFor { sink.count == 3 }

        let live = try sink.decode(AgentThreadChunk.self, at: 2)
        #expect(live.source == "pi")
        #expect(live.kind == "upsert")
    }

    @Test func olderAndRawRequestsRequireSource() async throws {
        let fake = FakeSidecarClient()
        fake.eventsPage = AgentFeedEventsPage(events: [event(index: 3)], total: 10)
        fake.rawEvent = #"{"exact":true}"#
        let sink = CapturingSink()
        let bridge = AgentFeedBridge(
            client: fake,
            rawEventDeliveryMode: .direct,
            send: sink.accept
        )

        bridge.handleThreadSubscribe(AgentThreadSubscribe(
            source: "claude", sessionId: "same"
        ))
        await waitFor { sink.count == 1 }
        bridge.handleThreadLoadOlder(AgentThreadLoadOlder(
            source: "claude",
            sessionId: "same",
            beforeIndex: 5,
            limit: 3
        ))
        bridge.handleRawEvent(AgentRawEventRequest(
            requestId: "raw-1",
            source: "codex",
            sessionId: "same",
            eventIndex: 7
        ))
        await waitFor { sink.count == 3 }

        #expect(fake.eventRequests.contains {
            $0.source == "claude" && $0.sessionId == "same"
        })
        #expect(fake.rawRequests.contains {
            $0.source == "codex" && $0.sessionId == "same" && $0.eventIndex == 7
        })
        let rawIndex = try #require((0..<sink.count).first { index in
            guard let object = try? JSONSerialization.jsonObject(
                with: sink.data(at: index)
            ) as? [String: Any] else {
                return false
            }
            return object["t"] as? String == "agent-raw-event"
        })
        let response = try sink.decode(AgentRawEventResponse.self, at: rawIndex)
        #expect(response.source == "codex")
        #expect(response.text == #"{"exact":true}"#)
    }

    @Test func anOlderPageFromAReplacedGenerationCannotReachTheViewer() async throws {
        let fake = FakeSidecarClient()
        fake.eventFetchDelayMilliseconds = 100
        fake.eventsPage = AgentFeedEventsPage(events: [event(index: 0)], total: 1)
        let sink = CapturingSink()
        let bridge = AgentFeedBridge(client: fake, send: sink.accept)
        let subscription = AgentThreadSubscribe(source: "pi", sessionId: "shared", mode: "nice")

        bridge.handleThreadSubscribe(subscription)
        bridge.handleThreadLoadOlder(AgentThreadLoadOlder(
            source: "pi", sessionId: "shared", beforeIndex: 1, limit: 1, mode: "nice"
        ))
        bridge.handleThreadSubscribe(subscription)

        await waitFor { sink.count == 1 }
        try await Task.sleep(for: .milliseconds(150))

        #expect(sink.count == 1)
        let snapshot = try sink.decode(AgentThreadChunk.self, at: 0)
        #expect(snapshot.kind == "snapshot")
    }

    @Test func threadReadsRejectInvalidPhoneIdentifiersBeforeCallingTheSidecar() throws {
        let fake = FakeSidecarClient()
        let sink = CapturingSink()
        let bridge = AgentFeedBridge(
            client: fake,
            rawEventDeliveryMode: .direct,
            send: sink.accept
        )

        bridge.handleThreadSubscribe(AgentThreadSubscribe(
            source: "pi", sessionId: "../other", mode: "nice"
        ))
        bridge.handleThreadLoadOlder(AgentThreadLoadOlder(
            source: "pi/other", sessionId: "session", beforeIndex: 5, limit: 3, mode: "nice"
        ))
        bridge.handleThreadUnsubscribe(AgentThreadUnsubscribe(
            source: "pi", sessionId: "session/other"
        ))
        bridge.handleRawEvent(AgentRawEventRequest(
            requestId: "raw/1", source: "pi", sessionId: "session", eventIndex: 0, mode: "nice"
        ))

        #expect(fake.eventRequests.isEmpty)
        #expect(fake.rawRequests.isEmpty)
        #expect(fake.openedEventStreams == 0)
        #expect(sink.count == 4)
        for index in 0..<3 {
            let error = try sink.decode(AgentThreadError.self, at: index)
            #expect(error.reason == "invalid source or session id")
        }
        let rawError = try sink.decode(AgentRawEventError.self, at: 3)
        #expect(rawError.reason == "invalid source, session id, or request id")
    }

    @Test func projectAndSessionDTOsDecodeFractionalTimestamps() throws {
        let projectJSON = """
        {
          "projects": [{
            "projectPath": "/project",
            "displayName": "project",
            "sourceCounts": {"claude": 1, "codex": 0},
            "sessionCount": 1,
            "lastEventAt": 1782851101572.0078
          }]
        }
        """.data(using: .utf8)!
        let sessionJSON = """
        {
          "projectPath": "/project",
          "sessions": [{
            "sessionId": "session",
            "source": "claude",
            "title": "Title",
            "lastEventAt": 1782851101572.0078,
            "activity": "paused",
            "capabilities": {
              "modes": ["raw", "nice"],
              "canSend": false,
              "canSteer": false,
              "canAbort": false,
              "canFetchRaw": true,
              "canOpenTerminal": true,
              "supportsExtensionUi": false
            }
          }]
        }
        """.data(using: .utf8)!

        let projects = try JSONDecoder().decode(AgentFeedProjectsSnapshot.self, from: projectJSON)
        let sessions = try JSONDecoder().decode(AgentFeedSessionsSnapshot.self, from: sessionJSON)
        #expect(projects.projects[0].lastEventAt == 1782851101572.0078)
        #expect(sessions.sessions[0].activity == "paused")
    }

    @Test func commandErrorsPreserveSidecarCodeAndRetryability() async throws {
        let fake = FakeSidecarClient()
        fake.messageError = SidecarClientError.command(
            code: "request-conflict",
            message: "request id was reused",
            requestId: "send-1",
            retryable: false
        )
        let sink = CapturingSink()
        let bridge = AgentFeedBridge(client: fake, send: sink.accept)

        bridge.handleSessionSend(AgentSessionSend(
            requestId: "send-1",
            source: "pi",
            sessionId: "session",
            text: "hello",
            delivery: "next"
        ))
        await waitFor { sink.count == 1 }

        let error = try sink.decode(AgentCommandError.self, at: 0)
        #expect(error.code == "request-conflict")
        #expect(error.message == "request id was reused")
        #expect(error.retryable == false)
    }

    @Test func createReceiptCarriesTheBackendAuthoredSessionDescriptor() async throws {
        let fake = FakeSidecarClient()
        let sink = CapturingSink()
        let bridge = AgentFeedBridge(client: fake, send: sink.accept)

        bridge.handleSessionCreate(AgentSessionCreate(
            requestId: "create-1",
            source: "pi",
            projectPath: "/project"
        ))
        await waitFor { sink.count == 1 }

        let receipt = try sink.decode(AgentCommandReceipt.self, at: 0)
        let session = try #require(receipt.session)
        #expect(receipt.sessionId == "created")
        #expect(session.source == "pi")
        #expect(session.capabilities.canSend)
        #expect(session.capabilities.supportsExtensionUI)
        #expect(session.capabilities.canOpenTerminal == false)
    }

    @Test func liveCommandsRejectInvalidPhoneIdentifiersBeforeCallingTheSidecar() async throws {
        let fake = FakeSidecarClient()
        let sink = CapturingSink()
        let bridge = AgentFeedBridge(client: fake, send: sink.accept)

        bridge.handleSessionCreate(AgentSessionCreate(
            requestId: "create-1", source: "pi/other", projectPath: "/project"
        ))
        bridge.handleSessionSend(AgentSessionSend(
            requestId: "send-1", source: "pi", sessionId: "../other",
            text: "hello", delivery: "next"
        ))
        bridge.handleSessionAbort(AgentSessionAbort(
            requestId: "abort/1", source: "pi", sessionId: "session"
        ))
        bridge.handleExtensionUIResponse(AgentExtensionUIResponse(
            source: "pi", sessionId: "session/other", requestId: "ui-1", value: .bool(true)
        ))

        #expect(fake.liveCommandCalls == 0)
        #expect(sink.count == 4)
        for index in 0..<4 {
            let error = try sink.decode(AgentCommandError.self, at: index)
            #expect(error.code == "invalid-agent-command")
            #expect(error.retryable == false)
        }
    }

    @Test func extensionRequestAndDismissalFanOutOnTheSameViewerStream() async throws {
        let fake = FakeSidecarClient()
        let sink = CapturingSink()
        let bridge = AgentFeedBridge(client: fake, send: sink.accept)

        bridge.handleThreadSubscribe(AgentThreadSubscribe(
            source: "pi",
            sessionId: "shared",
            mode: "nice"
        ))
        await waitFor { sink.count == 1 && fake.openedUIStreams == 1 }
        fake.pushUIEvent(
            source: "pi",
            sessionId: "shared",
            event: AgentFeedExtensionUIEvent(
                type: "request",
                request: AgentFeedExtensionUIRequest(
                    requestId: "ui-1",
                    kind: "confirm",
                    title: "Proceed?",
                    message: "Run the extension?",
                    options: nil,
                    placeholder: nil,
                    prefill: nil,
                    level: nil,
                    key: nil,
                    lines: nil,
                    expectsResponse: true
                ),
                requestId: nil
            )
        )
        fake.pushUIEvent(
            source: "pi",
            sessionId: "shared",
            event: AgentFeedExtensionUIEvent(
                type: "dismiss",
                request: nil,
                requestId: "ui-1"
            )
        )
        await waitFor { sink.count == 3 }

        let request = try sink.decode(AgentExtensionUIRequest.self, at: 1)
        let dismissed = try sink.decode(AgentExtensionUIDismissed.self, at: 2)
        #expect(request.requestId == "ui-1")
        #expect(request.expectsResponse)
        #expect(dismissed.source == "pi")
        #expect(dismissed.sessionId == "shared")
        #expect(dismissed.requestId == "ui-1")
    }
}

/// Records whichever of snapshot-or-error a stream reports first.
private final class SidecarOutcomeBox: @unchecked Sendable {
    enum Outcome { case snapshot, error }
    private let lock = NSLock()
    private var outcome: Outcome?

    func record(_ next: Outcome) {
        lock.lock()
        defer { lock.unlock() }
        if outcome == nil { outcome = next }
    }

    var value: Outcome? {
        lock.lock()
        defer { lock.unlock() }
        return outcome
    }
}

/// A base URL that is absent until someone publishes it, like the real sidecar.
private final class LateBaseURL: @unchecked Sendable {
    private let lock = NSLock()
    private var url: URL?
    private var waiters: [(URL) -> Void] = []
    private(set) var waitCount = 0

    /// Resolves now if published, otherwise waits -- the provider shape the client takes.
    func resolve() async -> URL? {
        await withCheckedContinuation { (continuation: CheckedContinuation<URL?, Never>) in
            lock.lock()
            if let url {
                lock.unlock()
                continuation.resume(returning: url)
                return
            }
            waitCount += 1
            waiters.append { continuation.resume(returning: $0) }
            lock.unlock()
        }
    }

    func publish(_ url: URL) {
        lock.lock()
        self.url = url
        let pending = waiters
        waiters.removeAll()
        lock.unlock()
        for waiter in pending { waiter(url) }
    }
}

private final class RequestHeaderBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value: String?

    func record(_ value: String?) {
        lock.withLock { self.value = value }
    }

    var authorization: String? {
        lock.withLock { value }
    }
}

private final class AgentFeedURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            let handler = try #require(Self.handler)
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

@Suite(.serialized) struct HttpSidecarClientReadinessTests {
    @Test func everySidecarRequestCarriesThePerSpawnBearerToken() async throws {
        let headers = RequestHeaderBox()
        AgentFeedURLProtocol.handler = { request in
            headers.record(request.value(forHTTPHeaderField: "Authorization"))
            let response = try #require(HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            ))
            return (response, Data(#"{"projects":[]}"#.utf8))
        }
        defer { AgentFeedURLProtocol.handler = nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AgentFeedURLProtocol.self]
        let client = HttpSidecarClient(
            endpointProvider: {
                AgentFeedSidecarEndpoint(
                    baseURL: URL(string: "https://agent-feed.invalid")!,
                    controlToken: "spawn-secret"
                )
            },
            session: URLSession(configuration: configuration)
        )

        _ = try await client.fetchProjects()

        #expect(headers.authorization == "Bearer spawn-secret")
    }

    @Test func commandFailuresDecodeTheSidecarErrorContract() async throws {
        AgentFeedURLProtocol.handler = { request in
            let response = try #require(HTTPURLResponse(
                url: request.url!,
                statusCode: 409,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            ))
            return (response, Data(#"{"error":{"code":"request-conflict","message":"request id was reused","requestId":"send-2","retryable":false}}"#.utf8))
        }
        defer { AgentFeedURLProtocol.handler = nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AgentFeedURLProtocol.self]
        let client = HttpSidecarClient(
            endpointProvider: {
                AgentFeedSidecarEndpoint(
                    baseURL: URL(string: "https://agent-feed.invalid")!,
                    controlToken: "spawn-secret"
                )
            },
            session: URLSession(configuration: configuration)
        )

        do {
            _ = try await client.sendMessage(
                requestId: "send-2",
                source: "pi",
                sessionId: "session",
                text: "hello",
                delivery: "next"
            )
            Issue.record("expected structured sidecar error")
        } catch {
            #expect(error as? SidecarClientError == .command(
                code: "request-conflict",
                message: "request id was reused",
                requestId: "send-2",
                retryable: false
            ))
        }
    }

    @Test func streamFailuresDecodeTheTypedSidecarErrorContract() async throws {
        AgentFeedURLProtocol.handler = { request in
            let response = try #require(HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "text/event-stream"]
            ))
            return (response, Data("data: {\"error\":{\"code\":\"session-not-found\",\"message\":\"missing\",\"retryable\":false}}\n\n".utf8))
        }
        defer { AgentFeedURLProtocol.handler = nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AgentFeedURLProtocol.self]
        let client = HttpSidecarClient(
            endpointProvider: {
                AgentFeedSidecarEndpoint(
                    baseURL: URL(string: "https://agent-feed.invalid")!,
                    controlToken: "spawn-secret"
                )
            },
            session: URLSession(configuration: configuration)
        )

        let error: Error = await withCheckedContinuation { continuation in
            _ = client.openEventStream(
                source: "pi",
                sessionId: "missing",
                afterSequence: 0,
                mode: .nice,
                onEnvelope: { _ in Issue.record("unexpected timeline envelope") },
                onError: { continuation.resume(returning: $0) }
            )
        }

        #expect(error as? SidecarClientError == .command(
            code: "session-not-found",
            message: "missing",
            requestId: nil,
            retryable: false
        ))
    }

    /// The failure this exists to prevent: the host starts the sidecar alongside the
    /// windows that read it, so a consumer can arrive first. On 2026-07-30 the restored
    /// Agents window subscribed at 16:04:24.200 and the sidecar published its URL at
    /// 16:04:25.251; the window took a hard "not ready", its subscription was torn down,
    /// and nothing re-subscribed, so it showed "agent feed is not ready" for the whole
    /// session over a one-second overlap.
    @Test func aStreamOpenedBeforeTheSidecarIsUpWaitsForItInsteadOfFailing() async throws {
        let late = LateBaseURL()
        let client = HttpSidecarClient(endpointProvider: {
            await late.resolve().map { AgentFeedSidecarEndpoint(baseURL: $0, controlToken: "test-token") }
        })

        // Subscribing before anything is published must NOT report an error.
        let outcome = SidecarOutcomeBox()
        let handle = client.openProjectsStream(
            onSnapshot: { _ in outcome.record(.snapshot) },
            onError: { _ in outcome.record(.error) }
        )
        defer { handle.cancel() }

        // Give the stream task room to reach the provider and park there.
        try await Task.sleep(for: .milliseconds(200))
        #expect(outcome.value == nil, "opening early must not fail the subscription")
        #expect(late.waitCount == 1, "the stream should be waiting on readiness, not polling once")
    }

    @Test func aStreamStillReportsFailureWhenTheSidecarNeverArrives() async {
        // Waiting must be bounded: a provider that gives up still surfaces an error, so a
        // genuinely dead sidecar shows as one rather than hanging the window forever.
        let client = HttpSidecarClient(endpointProvider: { nil })
        let error: Error = await withCheckedContinuation { continuation in
            _ = client.openProjectsStream(
                onSnapshot: { _ in },
                onError: { continuation.resume(returning: $0) }
            )
        }
        #expect((error as? SidecarClientError) == .notReady)
    }

    @Test func streamsAndRequestsUseSeparatePoolsAwayFromTheSharedSession() {
        // The regression this pins: on `URLSession.shared` the two roles share ONE six-connection
        // pool, so three Agents windows' worth of never-ending SSE streams fill it and every request
        // that renders a thread queues behind them until the panel times out. Separate pools mean an
        // RPC never waits on a stream, and staying off `.shared` means neither competes with the rest
        // of the host's HTTP.
        let client = HttpSidecarClient(endpointProvider: { nil })

        #expect(client.requestSessionForTesting !== client.streamSessionForTesting)
        #expect(client.requestSessionForTesting !== URLSession.shared)
        #expect(client.streamSessionForTesting !== URLSession.shared)
        #expect(
            client.streamSessionForTesting.configuration.httpMaximumConnectionsPerHost
                == Config.agentFeedSidecarStreamConnectionLimit
        )
        #expect(
            client.requestSessionForTesting.configuration.httpMaximumConnectionsPerHost
                == Config.agentFeedSidecarRequestConnectionLimit
        )
        // Well clear of the system default that caused this, since the limit has to cover every
        // window's and every phone's streams at once.
        #expect(client.streamSessionForTesting.configuration.httpMaximumConnectionsPerHost > 6)
    }

    @Test func anInjectedSessionStillServesBothRolesForProtocolStubbing() {
        // Existing tests stub `URLProtocol` through one injected session and drive streams over it.
        // If that session stopped covering the stream path, those tests would silently start hitting
        // the real network seam instead of the stub.
        let configuration = URLSessionConfiguration.ephemeral
        let injected = URLSession(configuration: configuration)
        let client = HttpSidecarClient(endpointProvider: { nil }, session: injected)

        #expect(client.requestSessionForTesting === injected)
        #expect(client.streamSessionForTesting === injected)
    }

    @Test func oneShotAPIsThrowNotReadyWhenSidecarDown() async {
        let client = HttpSidecarClient(endpointProvider: { nil })
        do {
            _ = try await client.fetchProjects()
            Issue.record("expected notReady")
        } catch {
            #expect((error as? SidecarClientError) == .notReady)
        }
        do {
            _ = try await client.fetchSessions(projectPath: "/project")
            Issue.record("expected notReady")
        } catch {
            #expect((error as? SidecarClientError) == .notReady)
        }
    }

    @Test func eventStreamReportsNotReadyWhenSidecarDown() async {
        let client = HttpSidecarClient(endpointProvider: { nil })
        let error: Error = await withCheckedContinuation { continuation in
            _ = client.openEventStream(
                source: "codex",
                sessionId: "session",
                afterSequence: 0,
                mode: .raw,
                onEnvelope: { _ in },
                onError: { continuation.resume(returning: $0) }
            )
        }
        #expect((error as? SidecarClientError) == .notReady)
    }
}
