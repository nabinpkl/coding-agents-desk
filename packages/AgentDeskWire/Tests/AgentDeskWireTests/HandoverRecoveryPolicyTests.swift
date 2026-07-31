import Testing
@testable import AgentDeskWire

@Suite struct HandoverRecoveryPolicyTests {
    private let grace: Double = 2000

    // MARK: - The case this exists for

    @Test func aHandoverThatStaysSilentPastTheGraceRecovers() {
        // R208's measured shape: the link moved, the probe went unanswered, and the transport
        // said nothing for nine seconds. Recovery has to come from here or not at all.
        #expect(HandoverRecoveryPolicy.shouldRecover(
            msSinceLinkChange: 2500,
            sawArrivalSinceChange: false,
            graceMs: grace
        ))
    }

    // MARK: - What must NOT fire

    @Test func aTransparentRouteChangeNeverRecovers() {
        // Tailnet direct <-> DERP was measured mid-session three times with no visible break.
        // Datagrams keep arriving, so this is vetoed no matter how long ago the change was --
        // reacting to these is an explicit non-goal, and would turn a non-event into a
        // reconnect that costs a handshake and a keyframe.
        #expect(!HandoverRecoveryPolicy.shouldRecover(
            msSinceLinkChange: 60_000,
            sawArrivalSinceChange: true,
            graceMs: grace
        ))
    }

    @Test func aSilentSessionWithNoLinkChangeIsNotOurProblem() {
        // Silence without a detected change is an ordinary stall, owned by ADR-0087's recovery.
        // If this fired on silence alone it would reconnect a session that is merely idle.
        #expect(!HandoverRecoveryPolicy.shouldRecover(
            msSinceLinkChange: nil,
            sawArrivalSinceChange: false,
            graceMs: grace
        ))
    }

    @Test func aLinkThatJustMovedIsGivenTimeToSettle() {
        // Detection fires within ~0.5s, but the interface needs longer than that to carry
        // traffic. Recovering instantly would abandon a link that was about to come back.
        #expect(!HandoverRecoveryPolicy.shouldRecover(
            msSinceLinkChange: 400,
            sawArrivalSinceChange: false,
            graceMs: grace
        ))
    }

    @Test func aHandoverThatRecoveredOnItsOwnInsideTheGraceIsLeftAlone() {
        // The 9-second freeze self-recovered. Had it recovered inside the grace instead, the
        // arrival veto must hold even though the change is recent and real.
        #expect(!HandoverRecoveryPolicy.shouldRecover(
            msSinceLinkChange: 1200,
            sawArrivalSinceChange: true,
            graceMs: grace
        ))
    }

    // MARK: - Boundary

    @Test func theGraceBoundaryItselfRecovers() {
        // Inclusive, so a grace expressed as a whole number of report windows fires on the
        // window that reaches it rather than the one after.
        #expect(HandoverRecoveryPolicy.shouldRecover(
            msSinceLinkChange: grace,
            sawArrivalSinceChange: false,
            graceMs: grace
        ))
    }
}
