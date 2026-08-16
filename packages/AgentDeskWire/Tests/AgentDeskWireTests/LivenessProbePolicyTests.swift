import Testing
@testable import AgentDeskWire

@Suite struct LivenessProbePolicyTests {
    private let interval: Double = 2000
    private let threshold = 3

    private func evaluate(
        hasEverArrived: Bool = true,
        sawArrival: Bool = false,
        msSinceLastProbe: Double? = nil,
        unansweredProbes: Int = 0
    ) -> LivenessProbePolicy.Decision {
        LivenessProbePolicy.evaluate(
            hasEverArrived: hasEverArrived,
            sawArrival: sawArrival,
            msSinceLastProbe: msSinceLastProbe,
            unansweredProbes: unansweredProbes,
            probeIntervalMs: interval,
            failureThreshold: threshold
        )
    }

    // MARK: - The case this exists for

    @Test func aStableLinkThatStoppedCarryingTrafficIsDeclaredDead() {
        // R212's measured shape: the connection died twice with the link completely stable, so
        // nothing armed the handover watch and the client sat on a dead session until it was
        // force quit. Unanswered probes are the only evidence available here.
        #expect(evaluate(msSinceLastProbe: 2000, unansweredProbes: threshold).declareDead)
    }

    @Test func theFirstSilentWindowProbesImmediately() {
        // Nil means no probe has ever gone out. Waiting a full interval before starting to wait
        // would add the interval to every detection for no evidence in return.
        let decision = evaluate(msSinceLastProbe: nil)
        #expect(decision.sendProbe)
        #expect(!decision.declareDead)
    }

    // MARK: - What must NOT fire

    @Test func trafficIsTheAnswerSoAnActiveSessionNeverProbes() {
        // The steady-state cost has to be zero: a session with frames flowing already knows the
        // downlink works, and probing it would spend a datagram each way to learn nothing.
        let decision = evaluate(sawArrival: true, msSinceLastProbe: 60_000, unansweredProbes: 2)
        #expect(!decision.sendProbe)
        #expect(!decision.declareDead)
    }

    @Test func anArrivalOutranksAFullRunOfUnansweredProbes() {
        // The echo comes back as an ordinary arrival, so this is how an answered probe reports.
        // If a run at the threshold could still declare, a session would die on the very window
        // that proved it alive.
        #expect(!evaluate(sawArrival: true, unansweredProbes: threshold + 5).declareDead)
    }

    @Test func aQuietHostIsNotADeadOneUntilItsProbesGoUnanswered() {
        // R212 recorded healthy idle windows 12.4s apart, which is why silence alone is never
        // the evidence. Long silence with nothing yet unanswered probes rather than declares.
        let decision = evaluate(msSinceLastProbe: 12_400, unansweredProbes: 0)
        #expect(decision.sendProbe)
        #expect(!decision.declareDead)
    }

    @Test func aSessionThatHasNeverCarriedAnythingIsNotProbed() {
        // Startup and death are indistinguishable from here, and a host that has not begun
        // reading control messages cannot answer. Without this, a slow-starting session would
        // be declared dead about six seconds into its own startup by probes nobody was there
        // to receive.
        let decision = evaluate(hasEverArrived: false, msSinceLastProbe: 60_000, unansweredProbes: 99)
        #expect(!decision.sendProbe)
        #expect(!decision.declareDead)
    }

    @Test func aSingleLostDatagramDoesNotFireIt() {
        // Below the threshold nothing is declared, which is the whole reason the threshold is
        // above one: ordinary loss ran 0.2% at rest and 18% inside a freeze.
        for unanswered in 0..<threshold {
            #expect(!evaluate(msSinceLastProbe: 5000, unansweredProbes: unanswered).declareDead)
        }
    }

    // MARK: - Pacing

    @Test func probesAreSpacedByTheInterval() {
        #expect(!evaluate(msSinceLastProbe: interval - 1).sendProbe)
        #expect(evaluate(msSinceLastProbe: interval).sendProbe)
    }

    @Test func theVerdictIsCheckedBeforeSendingNotAfter() {
        // At the threshold it declares instead of sending a fourth probe, so the verdict always
        // rests on probes that had a full interval to be answered rather than on one just
        // handed to the network.
        let decision = evaluate(msSinceLastProbe: 10_000, unansweredProbes: threshold)
        #expect(decision.declareDead)
        #expect(!decision.sendProbe)
    }

    // MARK: - Sizing

    @Test func theRunToDeathIsShorterThanTheTransportNoticing() {
        // Probes at 0, interval, 2*interval leave the third unanswered at 2*interval, when the
        // next window declares. That is ~4s of probing plus up to one report window, against
        // the 9.6s the transport itself took in R212, and far inside the host's 20s resume
        // window so the session can be resumed rather than re-paired.
        let reportWindowMs: Double = 500
        var unanswered = 0
        var elapsed: Double = 0
        var lastProbeAt: Double?
        var declaredAt: Double?
        while declaredAt == nil, elapsed <= 30_000 {
            let decision = evaluate(
                msSinceLastProbe: lastProbeAt.map { elapsed - $0 },
                unansweredProbes: unanswered
            )
            if decision.declareDead {
                declaredAt = elapsed
            } else if decision.sendProbe {
                unanswered += 1
                lastProbeAt = elapsed
            }
            elapsed += reportWindowMs
        }
        #expect(unanswered == threshold)
        #expect(declaredAt == 4_500)
        #expect(declaredAt! < 9_600)
    }
}
