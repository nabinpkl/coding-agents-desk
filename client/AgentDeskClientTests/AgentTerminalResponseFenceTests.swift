import Foundation
import Testing
import AgentDeskWire

@testable import AgentDeskClient

struct AgentTerminalResponseFenceTests {
    private let firstContext = AgentResumeTerminalContext(
        projectPath: "/Users/dev/project-a",
        source: "claude",
        harnessSessionID: "a4cdd7b8-3f9a-4d80-bc72-5f4aab6f39e1"
    )

    @Test func readyBindsOnlyToCurrentRequestAndContext() {
        var fence = AgentTerminalResponseFence()
        let open = AgentTerminalOpen(requestID: "request-1", context: firstContext)
        fence.begin(open)
        let ready = AgentTerminalHostMessage.ready(AgentTerminalReady(
            requestID: open.requestID,
            context: firstContext,
            ptySessionName: "agent-resume-claude-a4cdd7b8-3f9a-4d80-bc72-5f4aab6f39e1"
        ))

        #expect(fence.accept(ready) == ready)
    }

    @Test func readyArrivingAfterContextChangedCannotBind() {
        var fence = AgentTerminalResponseFence()
        let open = AgentTerminalOpen(requestID: "request-1", context: firstContext)
        fence.begin(open)
        fence.contextChanged(to: AgentResumeTerminalContext(
            projectPath: "/Users/dev/project-b",
            source: "codex",
            harnessSessionID: "5315800f-fab6-42ed-a80f-a622f563b57a"
        ))

        let accepted = fence.accept(.ready(AgentTerminalReady(
            requestID: open.requestID,
            context: firstContext,
            ptySessionName: "agent-resume-claude-a4cdd7b8-3f9a-4d80-bc72-5f4aab6f39e1"
        )))

        #expect(accepted == nil)
        #expect(fence.activeRequest == nil)
    }

    @Test func endedAndErrorClearOnlyTheirMatchingRequest() {
        var fence = AgentTerminalResponseFence()
        let open = AgentTerminalOpen(requestID: "request-1", context: firstContext)
        fence.begin(open)
        let staleError = AgentTerminalHostMessage.error(AgentTerminalError(
            requestID: "stale",
            context: firstContext,
            ptySessionName: nil,
            code: .sessionEnded
        ))
        #expect(fence.accept(staleError) == nil)
        #expect(fence.activeRequest == open)

        let ended = AgentTerminalHostMessage.ended(AgentTerminalEnded(
            requestID: open.requestID,
            context: firstContext,
            ptySessionName: "agent-resume-claude-a4cdd7b8-3f9a-4d80-bc72-5f4aab6f39e1",
            exitStatus: 0
        ))
        #expect(fence.accept(ended) == ended)
        #expect(fence.activeRequest == nil)
    }

    @Test func terminalPushDecoderRoutesOnlyTypedHostMessages() throws {
        let ready = AgentTerminalHostMessage.ready(AgentTerminalReady(
            requestID: "request-1",
            context: firstContext,
            ptySessionName: "agent-resume-claude-a4cdd7b8-3f9a-4d80-bc72-5f4aab6f39e1"
        ))

        #expect(AgentTerminalPushDecoder.decode(try JSONEncoder().encode(ready)) == ready)
        #expect(AgentTerminalPushDecoder.decode(Data(#"{"t":"agent-projects"}"#.utf8)) == nil)
    }
}
