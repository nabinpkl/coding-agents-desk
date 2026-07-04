import Foundation
import Testing
import UIKit
import WebKit
import AgentDeskWire

@testable import AgentDeskClient

@MainActor
struct AgentFeedSurfaceTests {

    // MARK: - Inbound decode: JS message body -> AgentFeedRequest

    @Test func projectsSubscribeDecodes() {
        let body: [String: Any] = ["t": "agent-projects-sub"]
        let result = AgentFeedRequest.decode(tag: "agent-projects-sub", body: body)
        guard case .projectsSubscribe = result else {
            Issue.record("expected .projectsSubscribe, got \(String(describing: result))")
            return
        }
    }

    @Test func threadSubscribeDecodesAllFields() {
        let body: [String: Any] = [
            "t": "agent-thread-sub",
            "pp": "/work/my-project",
            "src": "claude",
            "sid": "session-abc"
        ]
        let result = AgentFeedRequest.decode(tag: "agent-thread-sub", body: body)
        guard case .threadSubscribe(let sub) = result else {
            Issue.record("expected .threadSubscribe, got \(String(describing: result))")
            return
        }
        #expect(sub.projectPath == "/work/my-project")
        #expect(sub.source == "claude")
        #expect(sub.sessionId == "session-abc")
    }

    @Test func threadSubscribeDecodesWithoutOptionalFields() {
        let body: [String: Any] = [
            "t": "agent-thread-sub",
            "pp": "/work/proj"
        ]
        let result = AgentFeedRequest.decode(tag: "agent-thread-sub", body: body)
        guard case .threadSubscribe(let sub) = result else {
            Issue.record("expected .threadSubscribe, got \(String(describing: result))")
            return
        }
        #expect(sub.projectPath == "/work/proj")
        #expect(sub.source == nil)
        #expect(sub.sessionId == nil)
    }

    @Test func threadSubscribeWithOnlySessionIdDecodes() {
        // The phone subscribes by sessionId alone (no projectPath). Requiring pp
        // here previously dropped every phone thread-sub, leaving the thread view
        // stuck on "loading session events..." forever.
        let body: [String: Any] = ["t": "agent-thread-sub", "sid": "session-only"]
        let result = AgentFeedRequest.decode(tag: "agent-thread-sub", body: body)
        guard case .threadSubscribe(let sub) = result else {
            Issue.record("expected .threadSubscribe, got \(String(describing: result))")
            return
        }
        #expect(sub.projectPath == nil)
        #expect(sub.sessionId == "session-only")
    }

    @Test func threadSubscribeWithNoIdentifierReturnsNil() {
        // Neither pp nor sid: nothing to subscribe to, so the request is dropped.
        let body: [String: Any] = ["t": "agent-thread-sub", "src": "claude"]
        let result = AgentFeedRequest.decode(tag: "agent-thread-sub", body: body)
        #expect(result == nil)
    }

    @Test func threadLoadOlderDecodesAllFields() {
        let body: [String: Any] = [
            "t": "agent-thread-older",
            "sid": "session-xyz",
            "bi": 50,
            "lim": 25
        ]
        let result = AgentFeedRequest.decode(tag: "agent-thread-older", body: body)
        guard case .threadLoadOlder(let older) = result else {
            Issue.record("expected .threadLoadOlder, got \(String(describing: result))")
            return
        }
        #expect(older.sessionId == "session-xyz")
        #expect(older.beforeIndex == 50)
        #expect(older.limit == 25)
    }

    @Test func threadLoadOlderMissingFieldReturnsNil() {
        // limit is missing; must return nil.
        let body: [String: Any] = ["t": "agent-thread-older", "sid": "s", "bi": 10]
        let result = AgentFeedRequest.decode(tag: "agent-thread-older", body: body)
        #expect(result == nil)
    }

    @Test func threadUnsubscribeDecodes() {
        let body: [String: Any] = ["t": "agent-thread-unsub", "sid": "session-end"]
        let result = AgentFeedRequest.decode(tag: "agent-thread-unsub", body: body)
        guard case .threadUnsubscribe(let unsub) = result else {
            Issue.record("expected .threadUnsubscribe, got \(String(describing: result))")
            return
        }
        #expect(unsub.sessionId == "session-end")
    }

    @Test func threadUnsubscribeMissingSessionIdReturnsNil() {
        let body: [String: Any] = ["t": "agent-thread-unsub"]
        let result = AgentFeedRequest.decode(tag: "agent-thread-unsub", body: body)
        #expect(result == nil)
    }

    @Test func unknownTagReturnsNil() {
        let body: [String: Any] = ["t": "agent-future-feature", "payload": 42]
        let result = AgentFeedRequest.decode(tag: "agent-future-feature", body: body)
        #expect(result == nil)
    }

    // MARK: - Outbound: deliver queues before load, flushes on load

    @Test func deliverBeforeLoadQueuesAndFlushesAfterLoad() {
        let surface = AgentFeedSurface()
        var capturedPayloads: [String] = []

        // Override the delivery seam to capture payloads without a real WKWebView.
        surface.deliverForTesting = { payload in
            capturedPayloads.append(payload)
        }

        // Deliver before the page finishes loading (isLoaded is false by default).
        surface.deliver(rawJSON: #"{"t":"agent-projects","p":[]}"#)
        surface.deliver(rawJSON: #"{"t":"agent-thread-chunk","sid":"s1"}"#)

        // Nothing should have been delivered yet.
        #expect(capturedPayloads.isEmpty)

        // Trigger the load-complete path synchronously via the testable entry point.
        surface.markLoaded()

        // After the simulated load, all queued payloads should have flushed, verbatim.
        #expect(capturedPayloads.count == 2)
        #expect(capturedPayloads[0] == #"{"t":"agent-projects","p":[]}"#)
        #expect(capturedPayloads[1] == #"{"t":"agent-thread-chunk","sid":"s1"}"#)
    }

    @Test func deliverAfterLoadDeliversImmediately() {
        let surface = AgentFeedSurface()
        var capturedPayloads: [String] = []
        surface.deliverForTesting = { payload in capturedPayloads.append(payload) }

        // Mark the surface as loaded via the testable path.
        surface.markLoaded()
        capturedPayloads.removeAll()

        surface.deliver(rawJSON: #"{"t":"agent-projects","p":[]}"#)

        // The raw payload crosses to JS unchanged (marshaled as an argument, not
        // interpolated into source), so the seam sees it verbatim.
        #expect(capturedPayloads.count == 1)
        #expect(capturedPayloads[0] == #"{"t":"agent-projects","p":[]}"#)
    }

    @Test func deliverPassesPayloadVerbatim() {
        let surface = AgentFeedSurface()
        var capturedPayloads: [String] = []
        surface.deliverForTesting = { payload in capturedPayloads.append(payload) }

        surface.markLoaded()
        capturedPayloads.removeAll()

        let payload = #"{"t":"agent-thread-error","sid":"s","r":"not-found"}"#
        surface.deliver(rawJSON: payload)

        #expect(capturedPayloads.count == 1)
        #expect(capturedPayloads[0] == payload)
    }

    // MARK: - Teardown: post-teardown callbacks are no-ops

    @Test func deliverAfterTeardownDoesNotEvaluate() {
        let surface = AgentFeedSurface()
        var capturedPayloads: [String] = []
        surface.deliverForTesting = { payload in capturedPayloads.append(payload) }

        surface.markLoaded()
        surface.teardown()
        capturedPayloads.removeAll()

        // A lagging onAgentPush task could still call deliver after teardown.
        surface.deliver(rawJSON: #"{"t":"agent-projects","p":[]}"#)

        #expect(capturedPayloads.isEmpty)
    }

    @Test func markLoadedAfterTeardownDoesNotFlush() {
        let surface = AgentFeedSurface()
        var capturedPayloads: [String] = []
        surface.deliverForTesting = { payload in capturedPayloads.append(payload) }

        // Queue a payload before load completes.
        surface.deliver(rawJSON: #"{"t":"agent-projects","p":[]}"#)
        // Tear down before the page finishes loading.
        surface.teardown()
        capturedPayloads.removeAll()

        // A didFinish firing after teardown must not flush the queued payload.
        surface.markLoaded()

        #expect(capturedPayloads.isEmpty)
    }

    // MARK: - No-channel safety (mirrors "select Agent before a channel exists")

    // When the user switches to Agent before any input channel is wired, the
    // surface must construct and accept inbound messages without crashing. The
    // onAgentRequest closure is simply absent (nil), so an inbound message is a
    // no-op rather than a trap. This mirrors PairingViewController.ensureAgentSurface
    // tolerating a nil activeInputChannel (which we cannot drive in a unit test
    // because PairingViewController is not in the test target).
    @Test func inboundWithNoRequestClosureDoesNotCrash() async {
        let surface = AgentFeedSurface()
        // onAgentRequest intentionally left nil (no channel wired yet).

        let body: [String: Any] = ["t": "agent-projects-sub"]
        surface.userContentController(WKUserContentController(), didReceive: FakeScriptMessage(body: body))

        await Task.yield()
        // No assertion needed beyond "did not crash"; reaching here is the pass.
        #expect(Bool(true))
    }

    // MARK: - Inbound: request closure is called with correct type

    @Test func inboundProjectsSubscribeCallsOnAgentRequest() async {
        let surface = AgentFeedSurface()
        var received: [AgentFeedRequest] = []
        surface.onAgentRequest = { received.append($0) }

        // Simulate the WKScriptMessageHandler path by calling the handler directly.
        let body: [String: Any] = ["t": "agent-projects-sub"]
        surface.userContentController(WKUserContentController(), didReceive: FakeScriptMessage(body: body))

        // The onAgentRequest dispatch is async (via Task { @MainActor }), so yield once.
        await Task.yield()
        #expect(received.count == 1)
        guard case .projectsSubscribe = received[0] else {
            Issue.record("expected .projectsSubscribe")
            return
        }
    }

    @Test func inboundUnknownTagDoesNotCallOnAgentRequest() async {
        let surface = AgentFeedSurface()
        var received: [AgentFeedRequest] = []
        surface.onAgentRequest = { received.append($0) }

        let body: [String: Any] = ["t": "agent-future-feature"]
        surface.userContentController(WKUserContentController(), didReceive: FakeScriptMessage(body: body))

        await Task.yield()
        #expect(received.isEmpty)
    }

    @Test func inboundMissingTypeTagDoesNotCallOnAgentRequest() async {
        let surface = AgentFeedSurface()
        var received: [AgentFeedRequest] = []
        surface.onAgentRequest = { received.append($0) }

        // body has no "t" key
        let body: [String: Any] = ["payload": 42]
        surface.userContentController(WKUserContentController(), didReceive: FakeScriptMessage(body: body))

        await Task.yield()
        #expect(received.isEmpty)
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

// MARK: - AgentFeedRequest equatability helper (for test assertions)

extension AgentFeedRequest: Equatable {
    public static func == (lhs: AgentFeedRequest, rhs: AgentFeedRequest) -> Bool {
        switch (lhs, rhs) {
        case (.projectsSubscribe, .projectsSubscribe):
            return true
        case (.threadSubscribe(let a), .threadSubscribe(let b)):
            return a == b
        case (.threadLoadOlder(let a), .threadLoadOlder(let b)):
            return a == b
        case (.threadUnsubscribe(let a), .threadUnsubscribe(let b)):
            return a == b
        default:
            return false
        }
    }
}

// MARK: - Test helpers

// A minimal WKScriptMessage stand-in that returns a pre-baked body dictionary.
private final class FakeScriptMessage: WKScriptMessage {
    private let _body: Any
    override var body: Any { _body }
    override var name: String { "agentFeed" }

    init(body: Any) {
        self._body = body
        super.init()
    }
}
