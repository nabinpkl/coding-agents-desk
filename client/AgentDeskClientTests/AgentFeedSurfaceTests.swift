import Foundation
import Testing
import UIKit
import AgentDeskWire
import AgentPanel

@testable import AgentDeskClient

@MainActor
struct AgentFeedSurfaceTests {

    // MARK: - Request bridge: AgentPanelRequest -> AgentFeedRequest
    //
    // Webview-message decoding is authoritative in the AgentPanel package
    // (`requestDecoderPreservesCurrentAgentFeedContract`). The client's only
    // request responsibility now is bridging the package's request type onto the
    // wire types carried over the QUIC input lane. These tests pin that bridge.

    @Test func bridgesProjectsSubscribe() {
        #expect(AgentFeedRequest(.projectsSubscribe) == .projectsSubscribe)
    }

    @Test func bridgesThreadSubscribeAllFields() {
        let request = AgentFeedRequest(
            .threadSubscribe(projectPath: "/work/my-project", source: "claude", sessionId: "session-abc")
        )
        #expect(request == .threadSubscribe(AgentThreadSubscribe(
            projectPath: "/work/my-project", source: "claude", sessionId: "session-abc"
        )))
    }

    @Test func bridgesThreadSubscribeSessionOnly() {
        // The phone subscribes by sessionId alone; projectPath/source are nil.
        let request = AgentFeedRequest(
            .threadSubscribe(projectPath: nil, source: nil, sessionId: "session-only")
        )
        guard case .threadSubscribe(let sub) = request else {
            Issue.record("expected .threadSubscribe, got \(request)")
            return
        }
        #expect(sub.projectPath == nil)
        #expect(sub.source == nil)
        #expect(sub.sessionId == "session-only")
    }

    @Test func bridgesThreadLoadOlder() {
        let request = AgentFeedRequest(
            .threadLoadOlder(sessionId: "session-xyz", beforeIndex: 50, limit: 25)
        )
        #expect(request == .threadLoadOlder(AgentThreadLoadOlder(
            sessionId: "session-xyz", beforeIndex: 50, limit: 25
        )))
    }

    @Test func bridgesThreadUnsubscribe() {
        let request = AgentFeedRequest(.threadUnsubscribe(sessionId: "session-end"))
        #expect(request == .threadUnsubscribe(AgentThreadUnsubscribe(sessionId: "session-end")))
    }

    // MARK: - Transport: inbound panel request forwards to the input-lane callback

    @Test func sendAgentPanelRequestForwardsBridgedRequest() {
        let surface = AgentFeedSurface()
        var received: [AgentFeedRequest] = []
        surface.onAgentRequest = { received.append($0) }

        surface.sendAgentPanelRequest(.projectsSubscribe)
        surface.sendAgentPanelRequest(.threadUnsubscribe(sessionId: "s1"))

        #expect(received == [
            .projectsSubscribe,
            .threadUnsubscribe(AgentThreadUnsubscribe(sessionId: "s1")),
        ])
    }

    @Test func sendAgentPanelRequestWithNoCallbackIsNoOp() {
        // When Agent is selected before any input channel is wired, onAgentRequest
        // is nil and an inbound request is a no-op rather than a trap.
        let surface = AgentFeedSurface()
        // onAgentRequest intentionally nil.
        surface.sendAgentPanelRequest(.projectsSubscribe)
        // Reaching here without a crash is the pass.
        #expect(Bool(true))
    }

    @Test func terminalIntentsUseTheirOwnNativeCallback() {
        let surface = AgentFeedSurface()
        var feedRequests: [AgentFeedRequest] = []
        var terminalIntents: [AgentPanelTerminalIntent] = []
        surface.onAgentRequest = { feedRequests.append($0) }
        surface.onTerminalIntent = { terminalIntents.append($0) }
        let context = AgentPanelTerminalContext(
            projectPath: "/Users/dev/projects/alpha",
            source: .claude,
            sessionID: "session-1"
        )

        surface.sendAgentPanelRequest(.terminal(.open(requestID: "request-1", context: context)))
        surface.sendAgentPanelRequest(.terminal(.close(requestID: "request-1", context: context)))
        surface.sendAgentPanelRequest(.terminal(.contextEnded(requestID: "request-1", context: context)))

        #expect(feedRequests.isEmpty)
        #expect(terminalIntents == [
            .open(requestID: "request-1", context: context),
            .close(requestID: "request-1", context: context),
            .contextEnded(requestID: "request-1", context: context),
        ])
    }

    // MARK: - Delivery seam: deliver/resume route through the injectable seam

    @Test func deliverRoutesToSeam() {
        let surface = AgentFeedSurface()
        var captured: [String] = []
        surface.deliverForTesting = { captured.append($0) }

        surface.deliver(rawJSON: #"{"t":"agent-projects","p":[]}"#)
        surface.deliver(rawJSON: #"{"t":"agent-thread-chunk","sid":"s1"}"#)

        #expect(captured == [
            #"{"t":"agent-projects","p":[]}"#,
            #"{"t":"agent-thread-chunk","sid":"s1"}"#,
        ])
    }

    @Test func resumeRoutesToSeam() {
        let surface = AgentFeedSurface()
        var resumeCount = 0
        surface.resumeAfterReconnectForTesting = { resumeCount += 1 }

        surface.resumeAfterSessionReconnect()
        #expect(resumeCount == 1)
    }
}

// MARK: - InputChannel agent-request send encoding tests

struct AgentFeedInputChannelSendTests {
    @Test func agentProjectsSubscribeEncodesCorrectTag() throws {
        let msg = AgentProjectsSubscribe()
        let data = try JSONEncoder().encode(msg)
        let json = String(data: data, encoding: .utf8) ?? ""
        #expect(json.contains("\"t\":\"agent-projects-sub\""))
    }

    @Test func agentThreadSubscribeEncodesProjectPathAndOptionals() throws {
        let msg = AgentThreadSubscribe(projectPath: "/proj/x", source: "claude", sessionId: "s1")
        let data = try JSONEncoder().encode(msg)
        let json = String(data: data, encoding: .utf8) ?? ""
        let decoded = try JSONDecoder().decode(AgentThreadSubscribe.self, from: data)
        #expect(json.contains("\"t\":\"agent-thread-sub\""))
        // JSONEncoder may escape '/' as '\/' so compare via decoded struct.
        #expect(decoded.projectPath == "/proj/x")
        #expect(json.contains("\"src\":\"claude\""))
        #expect(json.contains("\"sid\":\"s1\""))
    }

    @Test func agentThreadLoadOlderEncodesAllFields() throws {
        let msg = AgentThreadLoadOlder(sessionId: "sess-q", beforeIndex: 100, limit: 20)
        let data = try JSONEncoder().encode(msg)
        let json = String(data: data, encoding: .utf8) ?? ""
        #expect(json.contains("\"t\":\"agent-thread-older\""))
        #expect(json.contains("\"sid\":\"sess-q\""))
        #expect(json.contains("\"bi\":100"))
        #expect(json.contains("\"lim\":20"))
    }

    @Test func agentThreadUnsubscribeEncodesSessionId() throws {
        let msg = AgentThreadUnsubscribe(sessionId: "sess-done")
        let data = try JSONEncoder().encode(msg)
        let json = String(data: data, encoding: .utf8) ?? ""
        #expect(json.contains("\"t\":\"agent-thread-unsub\""))
        #expect(json.contains("\"sid\":\"sess-done\""))
    }
}
