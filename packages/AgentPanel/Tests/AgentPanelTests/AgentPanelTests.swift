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
