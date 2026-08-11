import Foundation
import Testing
import AgentDeskWire
import AgentPanel

@testable import AgentDeskHost

/// What the Mac Agents window's transport owes: route each panel request to the one thing that
/// answers it, and carry a relayed request through without editing it.
///
/// This used to assert per-endpoint field mapping, because the transport rewrote every payload into
/// a second set of Swift structs. It rewrites nothing now, so what is left to get wrong is the
/// routing.
@MainActor
struct AgentPanelBridgeTransportTests {
    @Test func aRelayedRequestReachesTheSidecarUnedited() async throws {
        let client = TransportRelayClient()
        let sink = CapturingSink()
        let transport = AgentPanelBridgeTransport(
            relay: AgentFeedHTTPRelay(client: client, send: sink.accept)
        )

        transport.sendAgentPanelRequest(.httpRequest(
            rid: "r1",
            method: "POST",
            path: "/api/sessions/pi/s1/message",
            body: #"{"text":"hello"}"#,
            stream: false
        ))

        #expect(client.performed.count == 1)
        #expect(client.performed.first?.method == "POST")
        #expect(client.performed.first?.path == "/api/sessions/pi/s1/message")
        #expect(client.performed.first?.body == Data(#"{"text":"hello"}"#.utf8))
    }

    @Test func aSubscriptionOpensAStreamRatherThanAOneShotRequest() async throws {
        let client = TransportRelayClient()
        let sink = CapturingSink()
        let transport = AgentPanelBridgeTransport(
            relay: AgentFeedHTTPRelay(client: client, send: sink.accept)
        )

        transport.sendAgentPanelRequest(.httpRequest(
            rid: "r1",
            method: "GET",
            path: "/api/sessions/claude/s1/timeline?mode=nice",
            body: nil,
            stream: true
        ))
        transport.sendAgentPanelRequest(.httpCancel(rid: "r1"))
        // The slot the cancelled subscription held is free, so a second one is admitted.
        transport.sendAgentPanelRequest(.httpRequest(
            rid: "r2",
            method: "GET",
            path: "/api/projects/watch",
            body: nil,
            stream: true
        ))

        #expect(client.performed.isEmpty)
        #expect(client.subscribed == [
            "/api/sessions/claude/s1/timeline?mode=nice",
            "/api/projects/watch",
        ])
    }

    @Test func terminalIntentsRemainNative() {
        let client = TransportRelayClient()
        var received: [AgentPanelTerminalIntent] = []
        let sink = CapturingSink()
        let transport = AgentPanelBridgeTransport(
            relay: AgentFeedHTTPRelay(client: client, send: sink.accept),
            onTerminalIntent: { received.append($0) }
        )
        let context = AgentPanelTerminalContext(
            projectPath: "/project",
            source: .codex,
            sessionID: "session"
        )

        transport.sendAgentPanelRequest(.terminal(
            .open(requestID: "request", context: context)
        ))
        transport.sendAgentPanelRequest(.terminal(
            .close(requestID: "request", context: context)
        ))
        transport.sendAgentPanelRequest(.terminal(
            .contextEnded(requestID: "request", context: context)
        ))

        #expect(received.count == 3)
        #expect(sink.count == 0)
        #expect(client.performed.isEmpty)
    }

    /// Composer sync and the question mirror write into another application's window through
    /// Accessibility. Routing one of them at the sidecar would send a keystroke nowhere and leave
    /// the panel believing it landed.
    @Test func nativeAuthorityRequestsNeverReachTheRelay() {
        let client = TransportRelayClient()
        var received: [AgentPanelRequest] = []
        let sink = CapturingSink()
        let transport = AgentPanelBridgeTransport(
            relay: AgentFeedHTTPRelay(client: client, send: sink.accept),
            onWindowInput: { received.append($0) }
        )

        transport.sendAgentPanelRequest(.windowInputWatch(subscriptionId: "w-1", sessionId: "s1"))
        transport.sendAgentPanelRequest(.windowInputSubmit(requestId: "r-1", sessionId: "s1", text: "hi"))
        transport.sendAgentPanelRequest(.questionAction(
            requestId: "r-2",
            sessionId: "s1",
            kind: .submit,
            optionIndex: nil,
            desired: nil,
            otherText: nil
        ))

        #expect(received.count == 3)
        #expect(client.performed.isEmpty)
        #expect(client.subscribed.isEmpty)
        #expect(sink.count == 0)
    }
}

/// A sidecar transport that records what the relay asked of it and never answers.
private final class TransportRelayClient: AgentFeedRelayClient, @unchecked Sendable {
    private let lock = NSLock()
    private var _performed: [(method: String, path: String, body: Data?)] = []
    private var _subscribed: [String] = []

    var performed: [(method: String, path: String, body: Data?)] {
        lock.lock(); defer { lock.unlock() }
        return _performed
    }

    var subscribed: [String] {
        lock.lock(); defer { lock.unlock() }
        return _subscribed
    }

    func perform(
        method: String,
        path: String,
        body: Data?,
        onResponse: @escaping @Sendable (Int, Data) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> SidecarStreamHandle {
        lock.lock()
        _performed.append((method, path, body))
        lock.unlock()
        return SidecarStreamHandle(task: Task {})
    }

    func subscribe(
        path: String,
        onOpen: @escaping @Sendable (Int) -> Void,
        onMessage: @escaping @Sendable (String) -> Void,
        onError: @escaping @Sendable (Error) -> Void
    ) -> SidecarStreamHandle {
        lock.lock()
        _subscribed.append(path)
        lock.unlock()
        return SidecarStreamHandle(task: Task {})
    }
}
