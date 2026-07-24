import Foundation
import Testing
@testable import AgentPanel

struct AgentPanelTests {
    @Test func packageResourcesResolveThePreferredAvailablePanel() throws {
        let locator = AgentPanelResourceLocator()

        let root = try #require(locator.rootDirectory())
        let index = try #require(locator.indexURL())
        let requestURL = try #require(locator.requestURL())

        #expect(["AgentPanelWebview", "AgentPanelFixture"].contains(root.lastPathComponent))
        #expect(index.lastPathComponent == "index.html")
        #expect(!(try Data(contentsOf: index)).isEmpty)
        #expect(requestURL.absoluteString == "agentfeed://app/index.html")
    }

    @Test func customContractControlsTheRequestURL() throws {
        let contract = AgentPanelJavaScriptContract(scheme: "agentpanel", host: "local")
        let locator = AgentPanelResourceLocator(contract: contract)

        #expect(locator.requestURL()?.absoluteString == "agentpanel://local/index.html")
        #expect(locator.rootDirectory(indexPath: contract.indexPath) == locator.rootDirectory())
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
            ) == .threadSubscribe(source: "codex", sessionId: "session-1")
        )
        #expect(
            AgentPanelRequest.decode(
                tag: "agent-thread-older",
                body: ["src": "claude", "sid": "session-1", "bi": 100, "lim": 25]
            ) == .threadLoadOlder(
                source: "claude",
                sessionId: "session-1",
                beforeIndex: 100,
                limit: 25
            )
        )
        #expect(AgentPanelRequest.decode(tag: "agent-thread-sub", body: [:]) == nil)
        #expect(AgentPanelRequest.decode(
            tag: "agent-thread-sub",
            body: ["sid": "session-1"]
        ) == nil)
        #expect(AgentPanelRequest.decode(tag: "future-message", body: [:]) == nil)
    }

    @Test func requestDecoderPreservesRawEventIdentity() {
        #expect(AgentPanelRequest.decode(
            tag: "agent-raw-event-get",
            body: ["rid": "r1", "src": "codex", "sid": "s1", "ei": 9]
        ) == .rawEvent(
            requestId: "r1",
            source: "codex",
            sessionId: "s1",
            eventIndex: 9
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
