import Foundation
import Testing
import AgentDeskWire

@testable import AgentDeskHost

struct AgentFeedWireTests {
    @Test func visibilityMessagesRoundTripWithSubscriptionIdentity() throws {
        try roundTrip(
            AgentProjectsWatch(subscriptionId: "projects-1"),
            tag: "agent-projects-watch"
        )
        try roundTrip(
            AgentProjectsUnwatch(subscriptionId: "projects-1"),
            tag: "agent-projects-unwatch"
        )
        try roundTrip(
            AgentProjectSessionsWatch(
                subscriptionId: "sessions-1",
                projectPath: "/project"
            ),
            tag: "agent-project-sessions-watch"
        )
        try roundTrip(
            AgentProjectSessionsUnwatch(subscriptionId: "sessions-1"),
            tag: "agent-project-sessions-unwatch"
        )

        let projects = AgentProjectsPush(
            subscriptionId: "projects-1",
            projects: [
                AgentProjectSummary(
                    projectPath: "/project",
                    displayName: "project",
                    sourceCounts: AgentProjectSourceCounts(claude: 1, codex: 2),
                    sessionCount: 3,
                    lastEventAt: 100
                ),
            ]
        )
        let decodedProjects = try roundTrip(projects, tag: "agent-projects")
        #expect(decodedProjects.subscriptionId == "projects-1")
        #expect(decodedProjects.projects[0].sourceCounts.codex == 2)

        let sessions = AgentProjectSessionsPush(
            subscriptionId: "sessions-1",
            projectPath: "/project",
            sessions: [
                AgentSessionSummary(
                    sessionId: "same",
                    source: "claude",
                    title: "Claude",
                    lastEventAt: 100,
                    activity: "live"
                ),
                AgentSessionSummary(
                    sessionId: "same",
                    source: "codex",
                    title: "Codex",
                    lastEventAt: 90,
                    activity: "cold"
                ),
            ]
        )
        let decodedSessions = try roundTrip(
            sessions,
            tag: "agent-project-sessions"
        )
        #expect(decodedSessions.subscriptionId == "sessions-1")
        #expect(decodedSessions.sessions.map(\.source) == ["claude", "codex"])
    }

    @Test func threadAndRawMessagesRequireSourceIdentity() throws {
        let subscription = try roundTrip(
            AgentThreadSubscribe(source: "claude", sessionId: "same"),
            tag: "agent-thread-sub"
        )
        #expect(subscription.source == "claude")

        let older = try roundTrip(
            AgentThreadLoadOlder(
                source: "codex",
                sessionId: "same",
                beforeIndex: 50,
                limit: 25
            ),
            tag: "agent-thread-older"
        )
        #expect(older.source == "codex")

        let chunk = try roundTrip(
            AgentThreadChunk(
                source: "codex",
                sessionId: "same",
                events: [
                    ActivityEvent(
                        index: 1,
                        ts: 2,
                        type: "assistant",
                        blocks: [ActivityBlock(kind: "text", text: "hello")]
                    ),
                ],
                windowStart: 1,
                total: 2,
                isLive: true
            ),
            tag: "agent-thread-chunk"
        )
        #expect(chunk.source == "codex")
        #expect(chunk.events[0].type == "assistant")

        let raw = try roundTrip(
            AgentRawEventRequest(
                requestId: "raw-1",
                source: "claude",
                sessionId: "same",
                eventIndex: 7
            ),
            tag: "agent-raw-event-get"
        )
        #expect(raw.source == "claude")
    }

    @Test func JavaScriptMirrorUsesTheCompactKeys() throws {
        let projectJSON = try encodedString(AgentProjectsPush(
            subscriptionId: "sub",
            projects: [
                AgentProjectSummary(
                    projectPath: "/p",
                    displayName: "p",
                    sourceCounts: AgentProjectSourceCounts(claude: 1, codex: 0),
                    sessionCount: 1,
                    lastEventAt: 1
                ),
            ]
        ))
        for key in ["\"t\"", "\"sub\"", "\"p\"", "\"pp\"", "\"dn\"", "\"sc\"", "\"cl\"", "\"co\"", "\"sn\"", "\"lea\""] {
            #expect(projectJSON.contains(key))
        }

        let sessionJSON = try encodedString(AgentProjectSessionsPush(
            subscriptionId: "sub",
            projectPath: "/p",
            sessions: [
                AgentSessionSummary(
                    sessionId: "s",
                    source: "claude",
                    title: "title",
                    lastEventAt: 1,
                    activity: "ready"
                ),
            ]
        ))
        for key in ["\"sub\"", "\"pp\"", "\"ss\"", "\"sid\"", "\"src\"", "\"ttl\"", "\"lea\"", "\"ac\""] {
            #expect(sessionJSON.contains(key))
        }
    }

    private func roundTrip<Value: Codable & Equatable>(
        _ value: Value,
        tag: String
    ) throws -> Value {
        let data = try JSONEncoder().encode(value)
        let json = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(json["t"] as? String == tag)
        let decoded = try JSONDecoder().decode(Value.self, from: data)
        #expect(decoded == value)
        return decoded
    }

    private func encodedString<Value: Encodable>(_ value: Value) throws -> String {
        try #require(String(data: JSONEncoder().encode(value), encoding: .utf8))
    }
}
