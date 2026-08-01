import Foundation
import Testing
import AgentDeskWire

@testable import AgentDeskClient

struct AgentFeedWireTests {
    @Test func visibilityMessagesRoundTripWithSubscriptionIdentity() throws {
        let projectWatch = try roundTrip(
            AgentProjectsWatch(subscriptionId: "projects-1"),
            tag: "agent-projects-watch"
        )
        #expect(projectWatch.subscriptionId == "projects-1")

        let sessionWatch = try roundTrip(
            AgentProjectSessionsWatch(
                subscriptionId: "sessions-1",
                projectPath: "/project"
            ),
            tag: "agent-project-sessions-watch"
        )
        #expect(sessionWatch.projectPath == "/project")

        let projects = try roundTrip(
            AgentProjectsPush(
                subscriptionId: "projects-1",
                projects: [
                    AgentProjectSummary(
                        projectPath: "/project",
                        displayName: "project",
                        sourceCounts: ["claude": 1, "codex": 1, "pi": 1],
                        sessionCount: 2,
                        lastEventAt: 100
                    ),
                ]
            ),
            tag: "agent-projects"
        )
        #expect(projects.subscriptionId == "projects-1")
        #expect(projects.projects[0].sessionCount == 2)

        let sessions = try roundTrip(
            AgentProjectSessionsPush(
                subscriptionId: "sessions-1",
                projectPath: "/project",
                sessions: [
                    AgentSessionSummary(
                        sessionId: "same",
                        source: "claude",
                        title: "Claude",
                        lastEventAt: 100,
                        activity: "live",
                        capabilities: transcriptCapabilities
                    ),
                    AgentSessionSummary(
                        sessionId: "same",
                        source: "codex",
                        title: "Codex",
                        lastEventAt: 90,
                        activity: "ready",
                        capabilities: transcriptCapabilities
                    ),
                ]
            ),
            tag: "agent-project-sessions"
        )
        #expect(sessions.sessions.map(\.source) == ["claude", "codex"])
    }

    private var transcriptCapabilities: AgentSessionCapabilities {
        AgentSessionCapabilities(modes: ["raw", "nice"], canSend: false, canSteer: false, canAbort: false, canFetchRaw: true, canOpenTerminal: true, supportsExtensionUI: false)
    }

    @Test func threadAndRawMessagesCarrySourceAndSession() throws {
        let thread = try roundTrip(
            AgentThreadSubscribe(source: "codex", sessionId: "same"),
            tag: "agent-thread-sub"
        )
        #expect(thread.source == "codex")

        let older = try roundTrip(
            AgentThreadLoadOlder(
                source: "claude",
                sessionId: "same",
                beforeIndex: 100,
                limit: 20
            ),
            tag: "agent-thread-older"
        )
        #expect(older.source == "claude")

        let raw = try roundTrip(
            AgentRawEventRequest(
                requestId: "raw",
                source: "codex",
                sessionId: "same",
                eventIndex: 7
            ),
            tag: "agent-raw-event-get"
        )
        #expect(raw.source == "codex")
    }

    private func roundTrip<Value: Codable & Equatable>(
        _ value: Value,
        tag: String
    ) throws -> Value {
        let data = try JSONEncoder().encode(value)
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(object["t"] as? String == tag)
        let decoded = try JSONDecoder().decode(Value.self, from: data)
        #expect(decoded == value)
        return decoded
    }
}
