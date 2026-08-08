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
                    sourceCounts: ["claude": 1, "codex": 2, "pi": 1],
                    sessionCount: 3,
                    lastEventAt: 100
                ),
            ]
        )
        let decodedProjects = try roundTrip(projects, tag: "agent-projects")
        #expect(decodedProjects.subscriptionId == "projects-1")
        #expect(decodedProjects.projects[0].sourceCounts["codex"] == 2)

        let sessions = AgentProjectSessionsPush(
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
                    activity: "cold",
                    capabilities: transcriptCapabilities
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
                        id: "event-1",
                        index: 1,
                        revision: 2,
                        phase: "streaming",
                        ts: 2,
                        type: "assistant",
                        blocks: [ActivityBlock(kind: "text", text: "hello")]
                    ),
                ],
                windowStart: 1,
                total: 2,
                isLive: true,
                kind: "upsert",
                sequence: 3,
                runState: "running"
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
                    sourceCounts: ["claude": 1, "codex": 0],
                    sessionCount: 1,
                    lastEventAt: 1
                ),
            ]
        ))
        for key in ["\"t\"", "\"sub\"", "\"p\"", "\"pp\"", "\"dn\"", "\"sc\"", "\"claude\"", "\"codex\"", "\"sn\"", "\"lea\""] {
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
                    activity: "ready",
                    capabilities: transcriptCapabilities
                ),
            ]
        ))
        for key in ["\"sub\"", "\"pp\"", "\"ss\"", "\"sid\"", "\"src\"", "\"ttl\"", "\"lea\"", "\"ac\""] {
            #expect(sessionJSON.contains(key))
        }
    }

    @Test func windowInputMessagesRoundTripWithAbbreviatedKeys() throws {
        try roundTrip(
            AgentWindowInputWatch(subscriptionId: "window-1", sessionId: "session-1"),
            tag: "agent-window-input-watch"
        )
        try roundTrip(
            AgentWindowInputUnwatch(subscriptionId: "window-1"),
            tag: "agent-window-input-unwatch"
        )
        try roundTrip(
            AgentWindowInputSync(requestId: "sync-1", sessionId: "session-1", text: "review the diff"),
            tag: "agent-window-input-sync"
        )
        try roundTrip(
            AgentWindowInputRead(requestId: "read-1", sessionId: "session-1"),
            tag: "agent-window-input-read"
        )
        try roundTrip(
            AgentWindowInputSubmit(requestId: "submit-1", sessionId: "session-1", text: "run the tests"),
            tag: "agent-window-input-submit"
        )

        let enabled = try roundTrip(
            AgentWindowInputStatus(
                subscriptionId: "window-1",
                sessionId: "session-1",
                enabled: true,
                onActiveDesktop: true,
                composerText: "already typed"
            ),
            tag: "agent-window-input-status"
        )
        #expect(enabled.reason == nil)
        #expect(enabled.composerText == "already typed")

        let disabled = try roundTrip(
            AgentWindowInputStatus(
                subscriptionId: "window-1",
                sessionId: "session-1",
                enabled: false,
                reason: AgentWindowInputReason.terminalOnly.rawValue
            ),
            tag: "agent-window-input-status"
        )
        #expect(disabled.reason == "terminal-only")
        #expect(!disabled.onActiveDesktop)
        #expect(disabled.composerText == nil)

        let failure = try roundTrip(
            AgentWindowInputResult(
                requestId: "sync-1",
                sessionId: "session-1",
                ok: false,
                reason: AgentWindowInputReason.composerMissing.rawValue
            ),
            tag: "agent-window-input-result"
        )
        #expect(failure.text == nil)

        // The panel keys off these abbreviations by hand, so pin them here rather than trusting that a
        // round trip through one Codable implementation agrees with the other two mirrors of this wire.
        let statusJSON = try encodedString(AgentWindowInputStatus(
            subscriptionId: "window-1",
            sessionId: "session-1",
            enabled: false,
            reason: AgentWindowInputReason.notRunning.rawValue
        ))
        for key in ["\"sub\"", "\"sid\"", "\"en\"", "\"r\"", "\"cur\""] {
            #expect(statusJSON.contains(key))
        }
        let resultJSON = try encodedString(AgentWindowInputResult(
            requestId: "sync-1",
            sessionId: "session-1",
            ok: true,
            text: "review the diff"
        ))
        for key in ["\"rid\"", "\"sid\"", "\"ok\"", "\"tx\""] {
            #expect(resultJSON.contains(key))
        }
    }

    @Test func questionMessagesRoundTripWithAbbreviatedKeys() throws {
        try roundTrip(
            AgentWindowQuestionWatch(subscriptionId: "question-1", sessionId: "session-1"),
            tag: "agent-window-question-watch"
        )
        try roundTrip(
            AgentWindowQuestionUnwatch(subscriptionId: "question-1"),
            tag: "agent-window-question-unwatch"
        )
        try roundTrip(
            AgentWindowQuestionAction(
                requestId: "action-1",
                sessionId: "session-1",
                kind: AgentWindowQuestionActionKind.select.rawValue,
                optionIndex: 1,
                desired: 1,
                text: nil
            ),
            tag: "agent-window-question-action"
        )
        try roundTrip(
            AgentWindowQuestionAction(
                requestId: "action-2",
                sessionId: "session-1",
                kind: AgentWindowQuestionActionKind.other.rawValue,
                optionIndex: nil,
                desired: nil,
                text: "custom answer"
            ),
            tag: "agent-window-question-action"
        )

        let status = try roundTrip(
            AgentWindowQuestionStatus(
                subscriptionId: "question-1",
                sessionId: "session-1",
                enabled: true,
                onActiveDesktop: true,
                present: true,
                selected: [0, 2],
                otherText: "custom",
                submitEnabled: false
            ),
            tag: "agent-window-question-status"
        )
        #expect(status.present == true)
        #expect(status.selected == [0, 2])
        #expect(status.otherText == "custom")
        #expect(status.submitEnabled == false)

        // A window on another Desktop reads as present-nil, never a claim of absence.
        let offDesktop = try roundTrip(
            AgentWindowQuestionStatus(
                subscriptionId: "question-1",
                sessionId: "session-1",
                enabled: true,
                onActiveDesktop: false,
                present: nil
            ),
            tag: "agent-window-question-status"
        )
        #expect(offDesktop.present == nil)

        let result = try roundTrip(
            AgentWindowQuestionResult(
                requestId: "action-1",
                sessionId: "session-1",
                ok: true,
                present: false,
                selected: [],
                otherText: nil,
                submitEnabled: nil
            ),
            tag: "agent-window-question-result"
        )
        #expect(result.present == false)

        // The webview mirrors these abbreviations by hand, so pin them here.
        let statusJSON = try encodedString(AgentWindowQuestionStatus(
            subscriptionId: "question-1",
            sessionId: "session-1",
            enabled: true,
            present: true,
            selected: [0]
        ))
        for key in ["\"sub\"", "\"sid\"", "\"en\"", "\"cur\"", "\"pr\"", "\"sel\"", "\"oth\"", "\"sb\""] {
            #expect(statusJSON.contains(key))
        }
        let actionJSON = try encodedString(AgentWindowQuestionAction(
            requestId: "action-1",
            sessionId: "session-1",
            kind: AgentWindowQuestionActionKind.submit.rawValue
        ))
        for key in ["\"rid\"", "\"sid\"", "\"k\"", "\"oi\"", "\"v\"", "\"tx\""] {
            #expect(actionJSON.contains(key))
        }
        let resultJSON = try encodedString(AgentWindowQuestionResult(
            requestId: "action-1",
            sessionId: "session-1",
            ok: false,
            reason: AgentWindowInputReason.questionMissing.rawValue
        ))
        for key in ["\"rid\"", "\"sid\"", "\"ok\"", "\"r\"", "\"pr\"", "\"sel\"", "\"oth\"", "\"sb\""] {
            #expect(resultJSON.contains(key))
        }
    }

    private var transcriptCapabilities: AgentSessionCapabilities {
        AgentSessionCapabilities(modes: ["raw", "nice"], canSend: false, canSteer: false, canAbort: false, canFetchRaw: true, canOpenTerminal: true, supportsExtensionUI: false)
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
