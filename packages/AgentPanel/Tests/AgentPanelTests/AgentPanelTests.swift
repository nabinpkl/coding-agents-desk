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

    @Test func requestDecoderPreservesCurrentAgentFeedContract() {
        #expect(
            AgentPanelRequest.decode(
                tag: "agent-projects-watch",
                body: ["sub": "projects-1"]
            ) == .projectsWatch(subscriptionId: "projects-1")
        )
        #expect(
            AgentPanelRequest.decode(
                tag: "agent-project-sessions-watch",
                body: ["sub": "sessions-1", "pp": "/project"]
            ) == .projectSessionsWatch(
                subscriptionId: "sessions-1",
                projectPath: "/project"
            )
        )
        #expect(
            AgentPanelRequest.decode(
                tag: "agent-thread-sub",
                body: ["sid": "session-1", "src": "codex"]
            ) == .threadSubscribe(source: "codex", sessionId: "session-1", mode: .raw)
        )
        #expect(
            AgentPanelRequest.decode(
                tag: "agent-thread-older",
                body: ["src": "claude", "sid": "session-1", "bi": 100, "lim": 25]
            ) == .threadLoadOlder(
                source: "claude",
                sessionId: "session-1",
                beforeIndex: 100,
                limit: 25,
                mode: .raw
            )
        )
        #expect(AgentPanelRequest.decode(tag: "agent-thread-sub", body: [:]) == nil)
        #expect(AgentPanelRequest.decode(
            tag: "agent-thread-sub",
            body: ["sid": "session-1"]
        ) == nil)
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

        let atLimit = String(repeating: "x", count: AgentPanelRequest.composerTextLimit)
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

    @Test func requestDecoderAcceptsProviderNeutralSourcesAndRejectsInvalidIdentifiers() {
        for tag in ["agent-thread-sub", "agent-thread-unsub"] {
            #expect(AgentPanelRequest.decode(
                tag: tag,
                body: ["sid": "session-1", "src": "gemini"]
            ) != nil)
        }
        #expect(AgentPanelRequest.decode(
            tag: "agent-thread-older",
            body: ["src": "Invalid Source", "sid": "session-1", "bi": 100, "lim": 25]
        ) == nil)
        #expect(AgentPanelRequest.decode(
            tag: "agent-raw-event-get",
            body: ["rid": "r1", "src": "../pi", "sid": "s1", "ei": 9]
        ) == nil)
    }

    /// The host turns this pair into `offset = max(0, bi - lim)` / `limit = bi - offset`, so an
    /// out-of-range pair reaches the sidecar as a negative limit and a 400 the panel shows as a
    /// thread error. The decoder is the boundary that has to refuse it.
    @Test func requestDecoderRejectsAnOutOfRangeOlderPage() {
        #expect(AgentPanelRequest.decode(
            tag: "agent-thread-older",
            body: ["src": "claude", "sid": "session-1", "bi": -1, "lim": 25]
        ) == nil)
        #expect(AgentPanelRequest.decode(
            tag: "agent-thread-older",
            body: ["src": "claude", "sid": "session-1", "bi": 100, "lim": 0]
        ) == nil)
        #expect(AgentPanelRequest.decode(
            tag: "agent-thread-older",
            body: ["src": "claude", "sid": "session-1", "bi": 100, "lim": -25]
        ) == nil)
        // The first page a thread asks for starts at index 0 with a full window.
        #expect(AgentPanelRequest.decode(
            tag: "agent-thread-older",
            body: ["src": "claude", "sid": "session-1", "bi": 0, "lim": 1]
        ) == .threadLoadOlder(
            source: "claude",
            sessionId: "session-1",
            beforeIndex: 0,
            limit: 1,
            mode: .raw
        ))
    }

    /// A mode decides what an event index MEANS, so the same integer names a different line in the two
    /// views. An absent mode is the fidelity view, which is what every caller meant before modes
    /// existed; a present but unrecognized one is refused, because guessing would answer with indices
    /// counted in a view the caller did not ask for and nothing downstream could tell.
    @Test func requestDecoderDefaultsAnAbsentModeToRawAndRefusesAnUnknownOne() {
        #expect(AgentPanelRequest.decode(
            tag: "agent-thread-sub",
            body: ["sid": "session-1", "src": "codex", "md": "nice"]
        ) == .threadSubscribe(source: "codex", sessionId: "session-1", mode: .nice))
        #expect(AgentPanelRequest.decode(
            tag: "agent-thread-older",
            body: ["src": "claude", "sid": "session-1", "bi": 100, "lim": 25, "md": "nice"]
        ) == .threadLoadOlder(
            source: "claude",
            sessionId: "session-1",
            beforeIndex: 100,
            limit: 25,
            mode: .nice
        ))
        #expect(AgentPanelRequest.decode(
            tag: "agent-raw-event-get",
            body: ["rid": "r1", "src": "codex", "sid": "s1", "ei": 9, "md": "nice"]
        ) == .rawEvent(
            requestId: "r1",
            source: "codex",
            sessionId: "s1",
            eventIndex: 9,
            mode: .nice
        ))

        for body: [String: Any] in [
            ["sid": "session-1", "src": "codex", "md": "pretty"],
            ["sid": "session-1", "src": "codex", "md": ""],
            ["sid": "session-1", "src": "codex", "md": 3],
        ] {
            #expect(AgentPanelRequest.decode(tag: "agent-thread-sub", body: body) == nil)
        }
        #expect(AgentPanelRequest.decode(
            tag: "agent-thread-older",
            body: ["src": "claude", "sid": "session-1", "bi": 100, "lim": 25, "md": "pretty"]
        ) == nil)
        #expect(AgentPanelRequest.decode(
            tag: "agent-raw-event-get",
            body: ["rid": "r1", "src": "codex", "sid": "s1", "ei": 9, "md": "pretty"]
        ) == nil)
    }

    @Test func requestDecoderPreservesRawEventIdentity() {
        #expect(AgentPanelRequest.decode(
            tag: "agent-raw-event-get",
            body: ["rid": "r1", "src": "codex", "sid": "s1", "ei": 9]
        ) == .rawEvent(
            requestId: "r1",
            source: "codex",
            sessionId: "s1",
            eventIndex: 9,
            mode: .raw
        ))
        #expect(AgentPanelRequest.decode(
            tag: "agent-raw-event-get",
            body: ["rid": "", "src": "codex", "sid": "s1", "ei": 9]
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
