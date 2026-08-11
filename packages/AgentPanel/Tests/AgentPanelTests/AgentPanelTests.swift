import Foundation
import Testing
@testable import AgentPanel

struct AgentPanelTests {
    @Test func packageResourcesResolveThePreferredAvailablePanel() throws {
        let locator = AgentPanelResourceLocator()

        let resolved = try #require(locator.resolve())
        let index = try #require(locator.indexURL())
        let requestURL = try #require(locator.requestURL())

        // Either tree is a legitimate resolution: a clean checkout carries only the fixture until
        // `just build-agent-webview` runs. Which one it is decides whether the panel is servable,
        // and that is `servableRoot`'s call, asserted below.
        switch resolved {
        case .builtWebview(let url):
            #expect(url.lastPathComponent == "AgentPanelWebview")
            #expect(!resolved.isFixture)
        case .fixture(let url):
            #expect(url.lastPathComponent == "AgentPanelFixture")
            #expect(resolved.isFixture)
        }
        #expect(index.lastPathComponent == "index.html")
        #expect(!(try Data(contentsOf: index)).isEmpty)
        #expect(requestURL.absoluteString == "agentfeed://app/index.html")
    }

    @Test func customContractControlsTheRequestURL() throws {
        let contract = AgentPanelJavaScriptContract(scheme: "agentpanel", host: "local")
        let locator = AgentPanelResourceLocator(contract: contract)

        #expect(locator.requestURL()?.absoluteString == "agentpanel://local/index.html")
        #expect(locator.resolve(indexPath: contract.indexPath) == locator.resolve())
    }

    @Test func onlyTheBuiltWebviewIsServable() throws {
        let url = URL(fileURLWithPath: "/panel")

        #expect(try AgentPanelWebViewController.servableRoot(.builtWebview(url)) == url)

        // The fixture is an inert stub: it renders placeholder text and no-ops `__agentFeedDeliver`,
        // so accepting it would present a blank panel that silently drops every host push. It has to
        // fail construction instead, which routes both containers to their visible unavailable view.
        #expect(throws: AgentPanelWebViewController.InitializationError.missingWebviewBuild) {
            try AgentPanelWebViewController.servableRoot(.fixture(url))
        }
        #expect(throws: AgentPanelWebViewController.InitializationError.missingResourceRoot) {
            try AgentPanelWebViewController.servableRoot(nil)
        }
    }

    /// The decoder's whole job for a relayed request: carry it, do not read it.
    ///
    /// It bounds the request id, because that id keys an in-flight transfer in the host. It does
    /// NOT vet the path -- `AgentFeedRelay.PathPolicy` is the one allow-list and the one security
    /// boundary, and a second copy here would be free to disagree with the one that executes.
    @Test func requestDecoderCarriesARelayedRequestWithoutReadingIt() {
        #expect(
            AgentPanelRequest.decode(
                tag: "agent-http-req",
                body: ["rid": "r1", "method": "GET", "path": "/api/projects"]
            ) == .httpRequest(rid: "r1", method: "GET", path: "/api/projects", body: nil, stream: false)
        )
        #expect(
            AgentPanelRequest.decode(
                tag: "agent-http-req",
                body: [
                    "rid": "r2",
                    "method": "POST",
                    "path": "/api/sessions/pi/s1/message",
                    "body": #"{"text":"hello"}"#,
                    "stream": true,
                ]
            ) == .httpRequest(
                rid: "r2",
                method: "POST",
                path: "/api/sessions/pi/s1/message",
                body: #"{"text":"hello"}"#,
                stream: true
            )
        )
        #expect(
            AgentPanelRequest.decode(tag: "agent-http-cancel", body: ["rid": "r1"])
                == .httpCancel(rid: "r1")
        )
        // An unbounded or malformed request id is refused: it keys a host-side transfer.
        #expect(AgentPanelRequest.decode(
            tag: "agent-http-req",
            body: ["rid": "", "method": "GET", "path": "/api/projects"]
        ) == nil)
        #expect(AgentPanelRequest.decode(
            tag: "agent-http-req",
            body: ["rid": String(repeating: "r", count: 129), "method": "GET", "path": "/api/x"]
        ) == nil)
        #expect(AgentPanelRequest.decode(
            tag: "agent-http-req",
            body: ["rid": "r1", "method": "GET"]
        ) == nil)
        #expect(AgentPanelRequest.decode(tag: "agent-http-cancel", body: [:]) == nil)
        #expect(AgentPanelRequest.decode(tag: "future-message", body: [:]) == nil)
    }

    @Test func windowInputRequestsDecodeWithBoundedIdentifiers() {
        let session = "9f2c1d54-0b3a-4e77-8c21-6a5be0d41f3e"

        #expect(
            AgentPanelRequest.decode(
                tag: "agent-window-input-watch",
                body: ["sub": "window-1", "sid": session]
            ) == .windowInputWatch(subscriptionId: "window-1", sessionId: session)
        )
        #expect(
            AgentPanelRequest.decode(
                tag: "agent-window-input-unwatch",
                body: ["sub": "window-1"]
            ) == .windowInputUnwatch(subscriptionId: "window-1")
        )
        #expect(
            AgentPanelRequest.decode(
                tag: "agent-window-input-read",
                body: ["rid": "read-1", "sid": session]
            ) == .windowInputRead(requestId: "read-1", sessionId: session)
        )

        // The session id addresses a WINDOW here, by comparison against live process argv, so it is
        // charset-bounded where the sidecar-facing requests accept any nonempty string.
        #expect(AgentPanelRequest.decode(
            tag: "agent-window-input-watch",
            body: ["sub": "window-1", "sid": "session one"]
        ) == nil)
        #expect(AgentPanelRequest.decode(
            tag: "agent-window-input-watch",
            body: ["sub": "window-1", "sid": String(repeating: "a", count: 129)]
        ) == nil)
        #expect(AgentPanelRequest.decode(
            tag: "agent-window-input-watch",
            body: ["sid": session]
        ) == nil)
    }

    @Test func windowInputSyncAcceptsClearingButNotAnUnboundedComposerWrite() {
        let session = "9f2c1d54-0b3a-4e77-8c21-6a5be0d41f3e"

        #expect(
            AgentPanelRequest.decode(
                tag: "agent-window-input-sync",
                body: ["rid": "sync-1", "sid": session, "tx": "review the diff"]
            ) == .windowInputSync(requestId: "sync-1", sessionId: session, text: "review the diff")
        )

        // Empty is a real intent here -- it clears the composer -- where `agent-session-send` rejects it
        // because an empty prompt means nothing.
        #expect(
            AgentPanelRequest.decode(
                tag: "agent-window-input-sync",
                body: ["rid": "sync-1", "sid": session, "tx": ""]
            ) == .windowInputSync(requestId: "sync-1", sessionId: session, text: "")
        )

        let atLimit = String(repeating: "x", count: AgentPanelWindowInputBounds.textLimit)
        #expect(AgentPanelRequest.decode(
            tag: "agent-window-input-sync",
            body: ["rid": "sync-1", "sid": session, "tx": atLimit]
        ) != nil)
        #expect(AgentPanelRequest.decode(
            tag: "agent-window-input-sync",
            body: ["rid": "sync-1", "sid": session, "tx": atLimit + "x"]
        ) == nil)
        #expect(AgentPanelRequest.decode(
            tag: "agent-window-input-sync",
            body: ["rid": "sync-1", "sid": session]
        ) == nil)
    }

    @Test func windowInputSubmitDecodesWithTheSameBoundsAsASync() {
        let session = "9f2c1d54-0b3a-4e77-8c21-6a5be0d41f3e"

        #expect(
            AgentPanelRequest.decode(
                tag: "agent-window-input-submit",
                body: ["rid": "submit-1", "sid": session, "tx": "run the tests"]
            ) == .windowInputSubmit(requestId: "submit-1", sessionId: session, text: "run the tests")
        )

        // The same text bound as a sync: the submit string is also written verbatim into another
        // application's field, so an unbounded one is a way to wedge that app.
        let atLimit = String(repeating: "x", count: AgentPanelWindowInputBounds.textLimit)
        #expect(AgentPanelRequest.decode(
            tag: "agent-window-input-submit",
            body: ["rid": "submit-1", "sid": session, "tx": atLimit]
        ) != nil)
        #expect(AgentPanelRequest.decode(
            tag: "agent-window-input-submit",
            body: ["rid": "submit-1", "sid": session, "tx": atLimit + "x"]
        ) == nil)
        #expect(AgentPanelRequest.decode(
            tag: "agent-window-input-submit",
            body: ["rid": "submit-1", "sid": session]
        ) == nil)
    }

    @Test func questionActionsDecodeWithPerKindPayloadBounds() {
        let session = "9f2c1d54-0b3a-4e77-8c21-6a5be0d41f3e"

        #expect(
            AgentPanelRequest.decode(
                tag: "agent-window-question-watch",
                body: ["sub": "question-1", "sid": session]
            ) == .questionWatch(subscriptionId: "question-1", sessionId: session)
        )
        #expect(
            AgentPanelRequest.decode(
                tag: "agent-window-question-unwatch",
                body: ["sub": "question-1"]
            ) == .questionUnwatch(subscriptionId: "question-1")
        )

        // `select` needs an in-range option index and an explicit desired state.
        #expect(
            AgentPanelRequest.decode(
                tag: "agent-window-question-action",
                body: ["rid": "action-1", "sid": session, "k": "select", "oi": 1, "v": 1]
            ) == .questionAction(
                requestId: "action-1",
                sessionId: session,
                kind: .select,
                optionIndex: 1,
                desired: true,
                otherText: nil
            )
        )
        #expect(
            AgentPanelRequest.decode(
                tag: "agent-window-question-action",
                body: ["rid": "action-1", "sid": session, "k": "select", "oi": 0, "v": 0]
            ) == .questionAction(
                requestId: "action-1",
                sessionId: session,
                kind: .select,
                optionIndex: 0,
                desired: false,
                otherText: nil
            )
        )
        // The index addresses an element in another application's window, so it is bounded.
        #expect(AgentPanelRequest.decode(
            tag: "agent-window-question-action",
            body: ["rid": "action-1", "sid": session, "k": "select", "oi": -1, "v": 1]
        ) == nil)
        #expect(AgentPanelRequest.decode(
            tag: "agent-window-question-action",
            body: ["rid": "action-1", "sid": session, "k": "select", "oi": 64, "v": 1]
        ) == nil)
        // `select` without a desired state is a malformed press, not a default.
        #expect(AgentPanelRequest.decode(
            tag: "agent-window-question-action",
            body: ["rid": "action-1", "sid": session, "k": "select", "oi": 1]
        ) == nil)

        // `other` needs the answer text; empty clears the input, which is a real intent.
        #expect(
            AgentPanelRequest.decode(
                tag: "agent-window-question-action",
                body: ["rid": "action-2", "sid": session, "k": "other", "tx": "custom answer"]
            ) == .questionAction(
                requestId: "action-2",
                sessionId: session,
                kind: .other,
                optionIndex: nil,
                desired: nil,
                otherText: "custom answer"
            )
        )
        #expect(
            AgentPanelRequest.decode(
                tag: "agent-window-question-action",
                body: ["rid": "action-2", "sid": session, "k": "other", "tx": ""]
            ) == .questionAction(
                requestId: "action-2",
                sessionId: session,
                kind: .other,
                optionIndex: nil,
                desired: nil,
                otherText: ""
            )
        )
        let atLimit = String(repeating: "x", count: AgentPanelWindowInputBounds.textLimit)
        #expect(AgentPanelRequest.decode(
            tag: "agent-window-question-action",
            body: ["rid": "action-2", "sid": session, "k": "other", "tx": atLimit + "x"]
        ) == nil)

        // The button kinds take no payload at all; a stray one is rejected rather than ignored.
        for kind in ["submit", "skip", "dismiss", "view-options"] {
            #expect(AgentPanelRequest.decode(
                tag: "agent-window-question-action",
                body: ["rid": "action-3", "sid": session, "k": kind]
            ) == .questionAction(
                requestId: "action-3",
                sessionId: session,
                kind: AgentPanelQuestionActionKind(rawValue: kind)!,
                optionIndex: nil,
                desired: nil,
                otherText: nil
            ))
            #expect(AgentPanelRequest.decode(
                tag: "agent-window-question-action",
                body: ["rid": "action-3", "sid": session, "k": kind, "oi": 0]
            ) == nil)
        }
        // An unknown kind is rejected, not mapped to a default action.
        #expect(AgentPanelRequest.decode(
            tag: "agent-window-question-action",
            body: ["rid": "action-3", "sid": session, "k": "answer"]
        ) == nil)
    }

    @Test func requestDecoderPreservesTerminalIntentContext() {
        let context = AgentPanelTerminalContext(
            projectPath: "/Users/dev/projects/alpha",
            source: .claude,
            sessionID: "3A58D7B8-4E2D-4E06-93C2-49BB6F6CB21A"
        )

        #expect(
            AgentPanelRequest.decode(
                tag: "agent-terminal-open",
                body: [
                    "rid": "request-1",
                    "ctx": [
                        "pp": context.projectPath,
                        "src": context.source.rawValue,
                        "sid": context.sessionID,
                    ],
                ]
            ) == .terminal(.open(requestID: "request-1", context: context))
        )
        #expect(
            AgentPanelRequest.decode(
                tag: "agent-terminal-close",
                body: [
                    "rid": "request-1",
                    "ctx": [
                        "pp": context.projectPath,
                        "src": context.source.rawValue,
                        "sid": context.sessionID,
                    ],
                ]
            ) == .terminal(.close(requestID: "request-1", context: context))
        )
        #expect(
            AgentPanelRequest.decode(
                tag: "agent-terminal-context-ended",
                body: [
                    "rid": "request-1",
                    "ctx": [
                        "pp": context.projectPath,
                        "src": context.source.rawValue,
                        "sid": context.sessionID,
                    ],
                ]
            ) == .terminal(.contextEnded(requestID: "request-1", context: context))
        )
    }

    @Test func requestDecoderRejectsIncompleteOrUnknownTerminalContext() {
        #expect(
            AgentPanelRequest.decode(
                tag: "agent-terminal-open",
                body: [
                    "rid": "request-1",
                    "ctx": ["pp": "/project", "src": "other", "sid": "session-1"],
                ]
            ) == nil
        )
        #expect(
            AgentPanelRequest.decode(
                tag: "agent-terminal-open",
                body: [
                    "rid": "",
                    "ctx": ["pp": "/project", "src": "codex", "sid": "session-1"],
                ]
            ) == nil
        )
        #expect(
            AgentPanelRequest.decode(
                tag: "agent-terminal-open",
                body: ["rid": "request-1", "ctx": ["src": "codex", "sid": "session-1"]]
            ) == nil
        )
    }
}
