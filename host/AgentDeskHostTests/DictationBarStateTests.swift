import CoreGraphics
import InteractionPanel
import Testing
@testable import AgentDeskHost

struct DictationBarStateTests {
    @Test func fnCommandsWaitForWebReadinessAndDeduplicateEdges() {
        var state = DictationBarState()

        #expect(state.captureCommand(functionPressed: true) == nil)
        #expect(state.captureCommand(functionPressed: false) == nil)

        state.markWebReady()
        #expect(state.captureCommand(functionPressed: true) == .start)
        #expect(state.captureCommand(functionPressed: true) == nil)
        #expect(state.captureCommand(functionPressed: false) == .stop)
        #expect(state.captureCommand(functionPressed: false) == nil)
    }

    @Test func busyStateAndPanelSizeFollowMiniRunState() {
        var state = DictationBarState()
        #expect(!state.isBusy)
        #expect(DictationBarState.panelSize(expanded: false) == CGSize(width: 68, height: 68))
        #expect(DictationBarState.panelSize(expanded: true) == CGSize(width: 520, height: 76))

        state.applyRunStatus(.capturing)
        #expect(state.isBusy)
        state.applyRunStatus(.analyzing)
        #expect(state.isBusy)
        state.applyRunStatus(.complete)
        #expect(!state.isBusy)
        state.applyRunStatus(.error)
        #expect(!state.isBusy)
    }

    @Test func finalInsertionIsOnePerNonemptyRecording() {
        var state = DictationBarState()
        let blank = state.shouldCommit(recordingID: "session-a", transcript: "   ")
        #expect(!blank)
        let first = state.shouldCommit(recordingID: "session-a", transcript: "hello")
        #expect(first)
        let duplicate = state.shouldCommit(recordingID: "session-a", transcript: "hello")
        #expect(!duplicate)
        let second = state.shouldCommit(recordingID: "session-b", transcript: "hello")
        #expect(second)
    }
}
