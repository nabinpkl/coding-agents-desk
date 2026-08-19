import Foundation
import Testing

@testable import AgentDeskClient

@Suite struct DiagnosticsTrimPolicyTests {
    private struct Line: Equatable {
        let id: String
        let bytes: Int
        let retention: DiagnosticsRetention
    }

    private func keep(_ lines: [Line], limit: Int) -> [String] {
        DiagnosticsTrimPolicy.keep(
            lines,
            limit: limit,
            bytes: { $0.bytes },
            retention: { $0.retention }
        ).map(\.id)
    }

    private func stream(_ id: String, _ bytes: Int = 10) -> Line {
        Line(id: id, bytes: bytes, retention: .stream)
    }

    private func lifecycle(_ id: String, _ bytes: Int = 10) -> Line {
        Line(id: id, bytes: bytes, retention: .lifecycle)
    }

    @Test func nothingIsSacrificedWhileTheBudgetHolds() {
        let lines = [lifecycle("launch"), stream("frame1"), stream("frame2")]

        #expect(keep(lines, limit: 30) == ["launch", "frame1", "frame2"])
    }

    // The measurement this policy exists for: lifecycle events are the OLDEST lines in a run,
    // so an oldest-first budget destroyed exactly them. Age must not outrank class.
    @Test func theOldestLifecycleEventOutlivesEveryStreamEvent() {
        let lines = [
            lifecycle("launch"),
            stream("frame1"), stream("frame2"), stream("frame3"), stream("frame4")
        ]

        #expect(keep(lines, limit: 10) == ["launch"])
    }

    @Test func streamEventsAreSacrificedOldestFirst() {
        let lines = [stream("frame1"), stream("frame2"), stream("frame3"), lifecycle("dial")]

        #expect(keep(lines, limit: 30) == ["frame2", "frame3", "dial"])
    }

    // A budget that cannot be met by dropping the whole stream still has to be met, and it is
    // met the old way rather than by overshooting the limit.
    @Test func lifecycleGivesWayOnceNoStreamIsLeftToSacrifice() {
        let lines = [lifecycle("a"), lifecycle("b"), stream("frame"), lifecycle("c")]

        #expect(keep(lines, limit: 20) == ["b", "c"])
    }

    @Test func survivorsKeepTheirOriginalOrder() {
        let lines = [
            lifecycle("launch"), stream("f1"), lifecycle("dial"), stream("f2"), lifecycle("ready")
        ]

        #expect(keep(lines, limit: 30) == ["launch", "dial", "ready"])
    }

    @Test func aZeroBudgetKeepsNothing() {
        #expect(keep([lifecycle("a"), stream("b")], limit: 0).isEmpty)
    }

    @Test func anEmptyRunIsUnchanged() {
        #expect(keep([], limit: 100).isEmpty)
    }

    // Sizes differ per line, so the budget has to count bytes rather than events.
    @Test func theBudgetCountsBytesNotEvents() {
        let lines = [stream("big", 100), stream("small", 5), lifecycle("keep", 5)]

        #expect(keep(lines, limit: 10) == ["small", "keep"])
    }
}
