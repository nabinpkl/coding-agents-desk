import Foundation
import Testing

@testable import AgentDeskHost

// The decisions a starting sidecar is judged by, without a process or a sleep: times are passed in.
struct AgentFeedSidecarStartupTests {

    // MARK: - Classifying what the port said

    private func http(_ status: Int) -> HTTPURLResponse {
        HTTPURLResponse(url: URL(string: "http://127.0.0.1:1")!, statusCode: status, httpVersion: nil, headerFields: nil)!
    }

    private func body(_ json: String) -> Data { json.data(using: .utf8)! }

    @Test func aRefusedConnectionIsNotListeningAndATimeoutIsSilent() {
        #expect(SidecarStageProbe.classify(data: nil, response: nil, error: URLError(.cannotConnectToHost)) == .notListening)
        #expect(SidecarStageProbe.classify(data: nil, response: nil, error: URLError(.timedOut)) == .silent)
        #expect(SidecarStageProbe.classify(data: nil, response: nil, error: URLError(.networkConnectionLost)) == .silent)
    }

    @Test func theWatcherStateNamesTheStageAndOnlyLiveIsLive() {
        let reconciling = SidecarStageProbe.classify(
            data: body(#"{"watcherState":"reconciling"}"#), response: http(200), error: nil)
        #expect(reconciling == .answering("reconciling"))
        let live = SidecarStageProbe.classify(data: body(#"{"watcherState":"live"}"#), response: http(200), error: nil)
        #expect(live == .live)
    }

    @Test func anAnswerWithoutAWatcherStateOrWithAnErrorStatusIsStillAnAnswer() {
        #expect(SidecarStageProbe.classify(data: body("{}"), response: http(200), error: nil) == .answering("http 200"))
        #expect(SidecarStageProbe.classify(data: body("nope"), response: http(200), error: nil) == .answering("http 200"))
        #expect(SidecarStageProbe.classify(data: nil, response: http(503), error: nil) == .answering("http 503"))
    }

    // MARK: - Progress, not elapsed time

    @Test func aStartThatKeepsAdvancingIsNeverStalledHoweverLongItTakes() {
        var watch = SidecarStartWatch(startedAt: 0)
        watch.observe(.notListening, at: 0)
        watch.observe(.answering("idle"), at: 8)
        watch.observe(.answering("reconciling"), at: 16)
        // Twenty seconds in against a ten second allowance, but the last new stage was four ago.
        #expect(watch.verdict(at: 20, stallAllowance: 10, ceiling: 90) == .waiting)
    }

    @Test func aStartThatStopsAdvancingIsStalledFromTheLastNewStage() {
        var watch = SidecarStartWatch(startedAt: 0)
        watch.observe(.notListening, at: 0)
        watch.observe(.answering("reconciling"), at: 3)
        #expect(watch.verdict(at: 12, stallAllowance: 10, ceiling: 90) == .waiting)
        #expect(watch.verdict(at: 13, stallAllowance: 10, ceiling: 90) == .stalled(seconds: 10))
    }

    @Test func goingBackwardsAndFlappingDoNotRestartTheClock() {
        var watch = SidecarStartWatch(startedAt: 0)
        watch.observe(.answering("reconciling"), at: 2)
        // The port stops answering and comes back: neither is a stage this start had not seen.
        watch.observe(.silent, at: 5)
        watch.observe(.answering("reconciling"), at: 8)
        watch.observe(.silent, at: 11)
        #expect(watch.verdict(at: 12, stallAllowance: 10, ceiling: 90) == .stalled(seconds: 10))
    }

    @Test func theCeilingBoundsAStartThatAdvancesForever() {
        var watch = SidecarStartWatch(startedAt: 0)
        watch.observe(.answering("a"), at: 85)
        #expect(watch.verdict(at: 90, stallAllowance: 10, ceiling: 90) == .overCeiling(seconds: 90))
    }

    @Test func theTimelineRecordsEachStageOnceWithTheTimeItWasReached() {
        var watch = SidecarStartWatch(startedAt: 100)
        let first = watch.observe(.notListening, at: 100)
        let again = watch.observe(.notListening, at: 101)
        let second = watch.observe(.answering("reconciling"), at: 102.5)
        let third = watch.observe(.live, at: 105)
        #expect(first && !again && second && third)
        #expect(watch.timelineDescription == "not-listening@0.0s answering:reconciling@2.5s live@5.0s")
    }

    // MARK: - A loop is named and then given longer

    @Test func eachFailureInARowDoublesTheAllowanceUpToTheCeiling() {
        var failures = SidecarStartFailures()
        #expect(failures.allowance(base: 10, ceiling: 90) == 10)
        failures.record(stage: .notListening)
        #expect(failures.allowance(base: 10, ceiling: 90) == 20)
        failures.record(stage: .notListening)
        failures.record(stage: .notListening)
        #expect(failures.allowance(base: 10, ceiling: 90) == 80)
        failures.record(stage: .notListening)
        #expect(failures.allowance(base: 10, ceiling: 90) == 90)
    }

    @Test func theLoopCountsHowManyFailuresEndedAtTheSameStage() {
        var failures = SidecarStartFailures()
        failures.record(stage: .notListening)
        failures.record(stage: .answering("reconciling"))
        failures.record(stage: .answering("reconciling"))
        #expect(failures.consecutive == 3)
        #expect(failures.atLastStage == 2)
        #expect(failures.lastStage == .answering("reconciling"))
    }

    @Test func aStartThatArrivesEndsTheLoop() {
        var failures = SidecarStartFailures()
        failures.record(stage: .silent)
        failures.record(stage: .silent)
        failures.reset()
        #expect(failures.consecutive == 0)
        #expect(failures.allowance(base: 10, ceiling: 90) == 10)
    }
}
