import Foundation
import Testing
import AgentDeskWire

@testable import AgentDeskHost

final class FakeSidecarClient: SidecarClient, @unchecked Sendable {
    var projects = AgentFeedProjectsSnapshot(projects: [])
    var sessions = AgentFeedSessionsSnapshot(projectPath: "/project", sessions: [])
    var eventsPage = AgentFeedEventsPage(events: [], total: 0)
    var rawEvent = ""
    var eventFetchDelayMilliseconds = 0

    private let lock = NSLock()
    private var projectSnapshot: (@Sendable (AgentFeedProjectsSnapshot) -> Void)?
    private var projectError: (@Sendable (Error) -> Void)?
    private var sessionSnapshot: (@Sendable (AgentFeedSessionsSnapshot) -> Void)?
    private var sessionError: (@Sendable (Error) -> Void)?
    private var eventCallbacks: [String: @Sendable (AgentFeedActivityEvent) -> Void] = [:]
    private var eventErrors: [String: @Sendable (Error) -> Void] = [:]
    private var _cancelledStreams = 0
    private var _eventRequests: [(source: String, sessionId: String, offset: Int, limit: Int)] = []
    private var _rawRequests: [(source: String, sessionId: String, eventIndex: Int)] = []
    private var _openedEventStreams = 0

    var cancelledStreams: Int { lock.withLock { _cancelledStreams } }
    var eventRequests: [(source: String, sessionId: String, offset: Int, limit: Int)] {
        lock.withLock { _eventRequests }
    }
    var rawRequests: [(source: String, sessionId: String, eventIndex: Int)] {
        lock.withLock { _rawRequests }
    }
    var openedEventStreams: Int { lock.withLock { _openedEventStreams } }

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
        limit: Int
    ) async throws -> AgentFeedEventsPage {
        lock.withLock {
            _eventRequests.append((source, sessionId, offset, limit))
        }
        if eventFetchDelayMilliseconds > 0 {
            try await Task.sleep(for: .milliseconds(eventFetchDelayMilliseconds))
        }
        return eventsPage
    }

    func fetchRawEvent(source: String, sessionId: String, eventIndex: Int) async throws -> String {
        lock.withLock {
            _rawRequests.append((source, sessionId, eventIndex))
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
        after: Int,
        onEvent: @escaping @Sendable (AgentFeedActivityEvent) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> SidecarStreamHandle {
        lock.withLock {
            _openedEventStreams += 1
            eventCallbacks["\(source):\(sessionId)"] = onEvent
            eventErrors["\(source):\(sessionId)"] = onError
        }
        return cancellableHandle()
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
        callback?(event)
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

private func event(index: Int) -> AgentFeedActivityEvent {
    AgentFeedActivityEvent(
        index: index,
        ts: 1_700_000_000_000,
        type: "assistant",
        blocks: [AgentFeedActivityBlock(kind: "text", text: "hello")]
    )
}

struct AgentFeedBridgeTests {
    @Test func projectAndSessionWatchesEchoSubscriptionIdentity() async throws {
        let fake = FakeSidecarClient()
        fake.projects = AgentFeedProjectsSnapshot(projects: [
            AgentFeedProjectSummary(
                projectPath: "/project",
                displayName: "project",
                sourceCounts: AgentFeedProjectSourceCounts(claude: 1, codex: 1),
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
                activity: "live"
            ),
            AgentFeedSessionSummary(
                sessionId: "shared",
                source: "codex",
                title: "Codex thread",
                lastEventAt: 9,
                activity: "ready"
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
        #expect(projects.projects[0].sourceCounts == AgentProjectSourceCounts(claude: 1, codex: 1))

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

    @Test func sameSessionIDAcrossSourcesUsesIndependentThreadStreams() async throws {
        let fake = FakeSidecarClient()
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
        await waitFor { sink.count == 2 }

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
            "activity": "paused"
          }]
        }
        """.data(using: .utf8)!

        let projects = try JSONDecoder().decode(AgentFeedProjectsSnapshot.self, from: projectJSON)
        let sessions = try JSONDecoder().decode(AgentFeedSessionsSnapshot.self, from: sessionJSON)
        #expect(projects.projects[0].lastEventAt == 1782851101572.0078)
        #expect(sessions.sessions[0].activity == "paused")
    }
}

@Suite struct HttpSidecarClientNotReadyTests {
    @Test func oneShotAPIsThrowNotReadyWhenSidecarDown() async {
        let client = HttpSidecarClient(baseURLProvider: { nil })
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
        let client = HttpSidecarClient(baseURLProvider: { nil })
        let error: Error = await withCheckedContinuation { continuation in
            _ = client.openEventStream(
                source: "codex",
                sessionId: "session",
                after: 0,
                onEvent: { _ in },
                onError: { continuation.resume(returning: $0) }
            )
        }
        #expect((error as? SidecarClientError) == .notReady)
    }
}
