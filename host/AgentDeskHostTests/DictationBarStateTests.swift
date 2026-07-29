import CoreGraphics
import InteractionPanel
import Testing
@testable import AgentDeskHost

struct DictationBarStateTests {
    @Test func fnCommandsWaitForWebReadinessAndDeduplicateEdges() {
        var state = DictationBarState()

        #expect(state.captureDecision(functionPressed: true) == .ignoredWebNotReady)
        #expect(state.captureDecision(functionPressed: false) == .ignoredWebNotReady)

        state.markWebReady()
        #expect(state.captureDecision(functionPressed: true) == .deliver(.start))
        #expect(state.captureDecision(functionPressed: true) == .ignoredRepeatedFnState)
        #expect(state.captureDecision(functionPressed: false) == .deliver(.stop))
        #expect(state.captureDecision(functionPressed: false) == .ignoredRepeatedFnState)
    }

    @Test func busyStateAndPanelSizeFollowMiniRunState() {
        var state = DictationBarState()
        #expect(!state.isBusy)
        #expect(DictationBarState.compactSize == CGSize(width: 68, height: 68))

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
