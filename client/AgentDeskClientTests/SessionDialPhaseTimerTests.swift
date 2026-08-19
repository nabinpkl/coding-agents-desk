import Foundation
import Testing

@testable import AgentDeskClient

@Suite struct SessionDialPhaseTimerTests {
    /// Drives the timer off a scripted clock so the assertions are about arithmetic, not speed.
    private func timer(steppingMs: [Int]) -> (SessionDialPhaseTimer, () -> Void) {
        var nowNs: UInt64 = 1_000_000_000
        var remaining = steppingMs
        let advance = {
            let step = remaining.isEmpty ? 0 : remaining.removeFirst()
            nowNs &+= UInt64(step) * 1_000_000
        }
        return (SessionDialPhaseTimer(clockNs: { nowNs }), advance)
    }

    @Test func eachPhaseMeasuresOnlyItsOwnStretch() {
        var (subject, advance) = timer(steppingMs: [8_400, 3, 90])
        advance()
        subject.mark("connect")
        advance()
        subject.mark("control")
        advance()
        subject.mark("challenge")

        #expect(subject.phases == [
            .init(name: "connect", ms: 8_400),
            .init(name: "control", ms: 3),
            .init(name: "challenge", ms: 90),
        ])
    }

    // The whole point of the split: a nine-second dial has to name the phase that owned it.
    @Test func theSlowestPhaseIsTheOneThatOwnedTheTime() {
        var (subject, advance) = timer(steppingMs: [120, 8_600, 40])
        advance()
        subject.mark("connect")
        advance()
        subject.mark("challenge")
        advance()
        subject.mark("lanes")

        #expect(subject.slowestPhase == .init(name: "challenge", ms: 8_600))
    }

    // Total is measured from construction, not summed from the phases, so any stretch that no
    // phase covers still shows up rather than vanishing.
    @Test func theTotalCoversStretchesNoPhaseClaims() {
        var (subject, advance) = timer(steppingMs: [100, 200, 700])
        advance()
        subject.mark("connect")
        advance()
        subject.mark("lanes")
        advance()

        #expect(subject.phases.reduce(0) { $0 + $1.ms } == 300)
        #expect(subject.totalMs == 1_000)
    }

    @Test func diagnosticsFieldsCarryEveryPhaseAndTheTotal() {
        var (subject, advance) = timer(steppingMs: [50, 25])
        advance()
        subject.mark("connect")
        advance()
        subject.mark("lanes")

        #expect(subject.diagnosticsFields == [
            "connectMs": "50",
            "lanesMs": "25",
            "totalMs": "75",
        ])
    }

    @Test func anUnmarkedDialHasNoPhasesAndNoSlowest() {
        let (subject, _) = timer(steppingMs: [])

        #expect(subject.phases.isEmpty)
        #expect(subject.slowestPhase == nil)
        #expect(subject.summary.isEmpty)
    }
}
