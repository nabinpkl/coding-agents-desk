import Foundation
import Testing
@testable import AgentPanel

struct AgentPanelTests {
    @Test func packageFixtureResolvesForCleanBuilds() throws {
        let locator = AgentPanelResourceLocator()

        let root = try #require(locator.rootDirectory())
        let index = try #require(locator.indexURL())
        let requestURL = try #require(locator.requestURL())

        #expect(root.lastPathComponent == "AgentPanelFixture")
        #expect(index.lastPathComponent == "index.html")
        #expect(String(decoding: try Data(contentsOf: index), as: UTF8.self).contains("AgentPanel fixture"))
        #expect(requestURL.absoluteString == "agentfeed://app/index.html")
    }

    @Test func customContractControlsTheRequestURL() throws {
        let contract = AgentPanelJavaScriptContract(scheme: "agentpanel", host: "local")
        let locator = AgentPanelResourceLocator(contract: contract)

        #expect(locator.requestURL()?.absoluteString == "agentpanel://local/index.html")
        #expect(try #require(locator.rootDirectory(indexPath: contract.indexPath)).lastPathComponent == "AgentPanelFixture")
    }

    @Test func requestDecoderPreservesCurrentAgentFeedContract() {
        #expect(
            AgentPanelRequest.decode(tag: "agent-projects-sub", body: [:]) == .projectsSubscribe
        )
        #expect(
            AgentPanelRequest.decode(
                tag: "agent-thread-sub",
                body: ["sid": "session-1", "src": "codex"]
            ) == .threadSubscribe(projectPath: nil, source: "codex", sessionId: "session-1")
        )
        #expect(
            AgentPanelRequest.decode(
                tag: "agent-thread-older",
                body: ["sid": "session-1", "bi": 100, "lim": 25]
            ) == .threadLoadOlder(sessionId: "session-1", beforeIndex: 100, limit: 25)
        )
        #expect(AgentPanelRequest.decode(tag: "agent-thread-sub", body: [:]) == nil)
        #expect(AgentPanelRequest.decode(tag: "future-message", body: [:]) == nil)
    }

    @Test func requestDecoderPreservesRawEventIdentity() {
        #expect(AgentPanelRequest.decode(
            tag: "agent-raw-event-get",
            body: ["rid": "r1", "sid": "s1", "ei": 9]
        ) == .rawEvent(requestId: "r1", sessionId: "s1", eventIndex: 9))
        #expect(AgentPanelRequest.decode(
            tag: "agent-raw-event-get",
            body: ["rid": "", "sid": "s1", "ei": 9]
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
