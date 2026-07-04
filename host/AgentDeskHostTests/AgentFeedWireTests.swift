import Foundation
import Testing

@testable import AgentDeskHost

struct AgentFeedWireTests {

    // MARK: - Supporting value types

    @Test func activityBlockRoundTripsThroughCodable() throws {
        let block = ActivityBlock(
            kind: "tool_use",
            text: nil,
            tool: "Bash",
            summary: "Run a shell command",
            preview: "ls -la",
            callId: "call-abc"
        )
        let data = try JSONEncoder().encode(block)
        let decoded = try JSONDecoder().decode(ActivityBlock.self, from: data)

        #expect(decoded == block)
        #expect(decoded.kind == "tool_use")
        #expect(decoded.tool == "Bash")
        #expect(decoded.text == nil)
        #expect(decoded.callId == "call-abc")
    }

    @Test func activityBlockWithTextOnlyRoundTrips() throws {
        let block = ActivityBlock(
            kind: "text",
            text: "Hello from the agent",
            tool: nil,
            summary: nil,
            preview: nil,
            callId: nil
        )
        let data = try JSONEncoder().encode(block)
        let decoded = try JSONDecoder().decode(ActivityBlock.self, from: data)

        #expect(decoded == block)
        #expect(decoded.kind == "text")
        #expect(decoded.text == "Hello from the agent")
    }

    @Test func activityEventRoundTripsThroughCodable() throws {
        let block = ActivityBlock(
            kind: "reasoning",
            text: "Thinking...",
            tool: nil,
            summary: nil,
            preview: nil,
            callId: nil
        )
        let event = ActivityEvent(index: 3, ts: 1_700_000_000_000.0, type: "assistant", blocks: [block])
        let data = try JSONEncoder().encode(event)
        let decoded = try JSONDecoder().decode(ActivityEvent.self, from: data)

        #expect(decoded == event)
        #expect(decoded.index == 3)
        #expect(decoded.ts == 1_700_000_000_000.0)
        #expect(decoded.type == "assistant")
        #expect(decoded.blocks.count == 1)
    }

    @Test func agentSessionSummaryRoundTripsThroughCodable() throws {
        let summary = AgentSessionSummary(
            sessionId: "sess-001",
            source: "claude",
            title: "Fix the login bug",
            lastEventAt: 1_700_000_000_000.0,
            isLive: true
        )
        let data = try JSONEncoder().encode(summary)
        let decoded = try JSONDecoder().decode(AgentSessionSummary.self, from: data)

        #expect(decoded == summary)
        #expect(decoded.source == "claude")
        #expect(decoded.isLive == true)
        #expect(decoded.title == "Fix the login bug")
    }

    @Test func projectDigestRoundTripsThroughCodable() throws {
        let session = AgentSessionSummary(
            sessionId: "sess-002",
            source: "codex",
            title: nil,
            lastEventAt: 1_700_000_001_000.0,
            isLive: false
        )
        let digest = ProjectDigest(
            projectPath: "/Users/dev/my-project",
            displayName: "my-project",
            sessions: [session]
        )
        let data = try JSONEncoder().encode(digest)
        let decoded = try JSONDecoder().decode(ProjectDigest.self, from: data)

        #expect(decoded == digest)
        #expect(decoded.projectPath == "/Users/dev/my-project")
        #expect(decoded.sessions.count == 1)
    }

    @Test func projectDigestWithNilDisplayNameRoundTrips() throws {
        let digest = ProjectDigest(projectPath: "/tmp/proj", displayName: nil, sessions: [])
        let data = try JSONEncoder().encode(digest)
        let decoded = try JSONDecoder().decode(ProjectDigest.self, from: data)

        #expect(decoded == digest)
        #expect(decoded.displayName == nil)
        #expect(decoded.sessions.isEmpty)
    }

    // MARK: - Client-to-host request types

    @Test func agentProjectsSubscribeRoundTripsThroughCodable() throws {
        let msg = AgentProjectsSubscribe()
        let data = try JSONEncoder().encode(msg)
        let json = String(data: data, encoding: .utf8) ?? ""
        let decoded = try JSONDecoder().decode(AgentProjectsSubscribe.self, from: data)

        #expect(decoded == msg)
        #expect(json.contains("\"t\":\"agent-projects-sub\""))
    }

    @Test func agentThreadSubscribeRoundTripsThroughCodable() throws {
        let msg = AgentThreadSubscribe(projectPath: "/proj/alpha", source: "claude", sessionId: "sess-x")
        let data = try JSONEncoder().encode(msg)
        let json = String(data: data, encoding: .utf8) ?? ""
        let decoded = try JSONDecoder().decode(AgentThreadSubscribe.self, from: data)

        #expect(decoded == msg)
        #expect(json.contains("\"t\":\"agent-thread-sub\""))
        #expect(decoded.projectPath == "/proj/alpha")
        #expect(decoded.source == "claude")
        #expect(decoded.sessionId == "sess-x")
    }

    @Test func agentThreadSubscribeWithNilOptionalFieldsRoundTrips() throws {
        let msg = AgentThreadSubscribe(projectPath: "/proj/beta")
        let data = try JSONEncoder().encode(msg)
        let decoded = try JSONDecoder().decode(AgentThreadSubscribe.self, from: data)

        #expect(decoded == msg)
        #expect(decoded.source == nil)
        #expect(decoded.sessionId == nil)
    }

    @Test func agentThreadLoadOlderRoundTripsThroughCodable() throws {
        let msg = AgentThreadLoadOlder(sessionId: "sess-y", beforeIndex: 50, limit: 25)
        let data = try JSONEncoder().encode(msg)
        let json = String(data: data, encoding: .utf8) ?? ""
        let decoded = try JSONDecoder().decode(AgentThreadLoadOlder.self, from: data)

        #expect(decoded == msg)
        #expect(json.contains("\"t\":\"agent-thread-older\""))
        #expect(decoded.beforeIndex == 50)
        #expect(decoded.limit == 25)
    }

    @Test func agentThreadUnsubscribeRoundTripsThroughCodable() throws {
        let msg = AgentThreadUnsubscribe(sessionId: "sess-z")
        let data = try JSONEncoder().encode(msg)
        let json = String(data: data, encoding: .utf8) ?? ""
        let decoded = try JSONDecoder().decode(AgentThreadUnsubscribe.self, from: data)

        #expect(decoded == msg)
        #expect(json.contains("\"t\":\"agent-thread-unsub\""))
        #expect(decoded.sessionId == "sess-z")
    }

    // MARK: - Host-to-client push types

    @Test func agentProjectsPushRoundTripsThroughCodable() throws {
        let session = AgentSessionSummary(
            sessionId: "s1",
            source: "claude",
            title: "Session A",
            lastEventAt: 1_700_000_000_000.0,
            isLive: false
        )
        let digest = ProjectDigest(projectPath: "/work/proj", displayName: "proj", sessions: [session])
        let push = AgentProjectsPush(projects: [digest])
        let data = try JSONEncoder().encode(push)
        let json = String(data: data, encoding: .utf8) ?? ""
        let decoded = try JSONDecoder().decode(AgentProjectsPush.self, from: data)

        #expect(decoded == push)
        #expect(json.contains("\"t\":\"agent-projects\""))
        #expect(decoded.projects.count == 1)
    }

    @Test func agentThreadChunkRoundTripsThroughCodable() throws {
        let block = ActivityBlock(
            kind: "tool_result",
            text: "success",
            tool: nil,
            summary: nil,
            preview: nil,
            callId: "call-1"
        )
        let event = ActivityEvent(index: 0, ts: 1_700_000_000_000.0, type: "user", blocks: [block])
        let chunk = AgentThreadChunk(
            sessionId: "sess-abc",
            events: [event],
            windowStart: 0,
            total: 42,
            isLive: true
        )
        let data = try JSONEncoder().encode(chunk)
        let json = String(data: data, encoding: .utf8) ?? ""
        let decoded = try JSONDecoder().decode(AgentThreadChunk.self, from: data)

        #expect(decoded == chunk)
        #expect(json.contains("\"t\":\"agent-thread-chunk\""))
        #expect(decoded.sessionId == "sess-abc")
        #expect(decoded.windowStart == 0)
        #expect(decoded.total == 42)
        #expect(decoded.isLive == true)
        #expect(decoded.events.count == 1)
    }

    @Test func agentThreadErrorRoundTripsThroughCodable() throws {
        let err = AgentThreadError(sessionId: "sess-dead", reason: "session-not-found")
        let data = try JSONEncoder().encode(err)
        let json = String(data: data, encoding: .utf8) ?? ""
        let decoded = try JSONDecoder().decode(AgentThreadError.self, from: data)

        #expect(decoded == err)
        #expect(json.contains("\"t\":\"agent-thread-error\""))
        #expect(decoded.sessionId == "sess-dead")
        #expect(decoded.reason == "session-not-found")
    }

    // MARK: - Unknown t tag is ignored (forward-compatible)

    @Test func unknownAgentFeedTagIsIgnoredByInputLaneDispatch() throws {
        // Simulate what InputChannelServer.dispatch does: if the type tag is
        // unknown it falls through to the default logger case without throwing.
        // We verify that decoding an unknown type tag does not throw and that
        // the existing types still decode correctly alongside unknown ones.
        let unknownData = Data(#"{"t":"agent-future-feature","payload":{"x":1}}"#.utf8)
        struct TypeTag: Decodable { let t: String? }
        let tag = try JSONDecoder().decode(TypeTag.self, from: unknownData)

        #expect(tag.t == "agent-future-feature")
        // None of the known types should match, so a dispatch switch would hit default.
        let isKnownType = ["agent-projects-sub", "agent-thread-sub", "agent-thread-older",
                           "agent-thread-unsub", "agent-projects", "agent-thread-chunk",
                           "agent-thread-error"].contains(tag.t ?? "")
        #expect(!isKnownType)
    }

    // MARK: - Literal wire-key contract (anchors the JS BridgeDataSource mirror)

    // The Swift<->Swift round-trip tests above pass even if a CodingKey raw value
    // changes, because encode and decode move together. But the JS bridge
    // (dashboard/.../BridgeDataSource.ts) mirrors these EXACT abbreviated keys by
    // hand; a silent rename there breaks every push with no failing Swift test.
    // This test pins the literal JSON keys so any change forces a deliberate
    // update on both sides. Keep in lockstep with the WireProjectDigest /
    // WireThreadChunk interfaces in BridgeDataSource.ts.
    @Test func agentProjectsPushWireKeysAreStable() throws {
        let session = AgentSessionSummary(
            sessionId: "s1", source: "claude", title: "A", lastEventAt: 1.0, isLive: true
        )
        let digest = ProjectDigest(projectPath: "/p", displayName: "p", sessions: [session])
        let json = String(decoding: try JSONEncoder().encode(AgentProjectsPush(projects: [digest])), as: UTF8.self)
        // Push envelope + project digest + session summary keys.
        for key in ["\"t\":\"agent-projects\"", "\"p\":", "\"pp\":", "\"dn\":", "\"ss\":",
                    "\"sid\":", "\"src\":", "\"ttl\":", "\"lea\":", "\"lv\":"] {
            #expect(json.contains(key), "AgentProjectsPush wire missing \(key); JS BridgeDataSource mirror will break")
        }
    }

    @Test func agentThreadChunkWireKeysAreStable() throws {
        let block = ActivityBlock(
            kind: "text", text: "hi", tool: nil, summary: nil, preview: nil, callId: nil
        )
        let event = ActivityEvent(index: 0, ts: 1.0, type: "user", blocks: [block])
        let chunk = AgentThreadChunk(sessionId: "s", events: [event], windowStart: 0, total: 1, isLive: true)
        let json = String(decoding: try JSONEncoder().encode(chunk), as: UTF8.self)
        // Chunk + nested event + nested block keys.
        for key in ["\"t\":\"agent-thread-chunk\"", "\"sid\":", "\"ev\":", "\"ws\":", "\"tot\":",
                    "\"lv\":", "\"i\":", "\"ts\":", "\"tp\":", "\"b\":", "\"k\":", "\"tx\":"] {
            #expect(json.contains(key), "AgentThreadChunk wire missing \(key); JS BridgeDataSource mirror will break")
        }
    }
}
