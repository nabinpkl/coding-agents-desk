import Foundation
import Testing
import AgentDeskWire

/// The whole reconnect decision, tested exhaustively because it is pure and because getting it
/// wrong is silent: a client that decides not to dial does not crash, log, or fail a test. It
/// just goes quiet, which is how every bug in this area shipped.
@MainActor
struct SessionDialPolicyTests {
    private let session = ActiveSession(
        sessionId: "session-1",
        deviceFingerprint: DeviceFingerprint("device"),
        establishedAt: 1_800_000_000
    )

    private func inputs(
        state: PairingClientState = .pairedDisconnected,
        disconnected: Bool = false,
        surface: ControlSurface = .control,
        foreground: Bool = true,
        outcome: SessionDialOutcome = .clean
    ) -> SessionDialInputs {
        SessionDialInputs(
            state: state,
            userRequestedDisconnect: disconnected,
            surface: surface,
            isForeground: foreground,
            lastOutcome: outcome
        )
    }

    // MARK: The gate

    /// The three reasons a human or the OS took the session away. Each closes the gate, and a
    /// closed gate is what cancels a dial in flight.
    @Test func theGateClosesForBackgroundDisconnectAndVoice() {
        #expect(SessionDialPolicy.isAllowed(inputs()))
        #expect(!SessionDialPolicy.isAllowed(inputs(foreground: false)))
        #expect(!SessionDialPolicy.isAllowed(inputs(disconnected: true)))
        #expect(!SessionDialPolicy.isAllowed(inputs(surface: .voice)))
    }

    /// The trap this design has to avoid. `.sessionConnecting` is not dialable, so keying
    /// cancellation on the plan would have every dial cancel itself the instant `attemptSession`
    /// moved the state. The gate must stay OPEN across the states a dial itself produces.
    @Test func aDialDoesNotCancelItselfByChangingTheState() {
        #expect(SessionDialPolicy.isAllowed(inputs(state: .sessionConnecting)))
        #expect(SessionDialPolicy.isAllowed(inputs(state: .connected(session))))
        #expect(SessionDialPolicy.plan(for: inputs(state: .sessionConnecting)) == .idle)
        #expect(SessionDialPolicy.plan(for: inputs(state: .connected(session))) == .idle)
    }

    /// Backgrounding must not be expressed by tearing the supervisor down, so it has to be
    /// expressed here. This is the assertion that stands in for "the client comes back".
    @Test func backgroundIsAGateNotATeardown() {
        #expect(SessionDialPolicy.plan(for: inputs(foreground: false)) == .idle)
        #expect(SessionDialPolicy.plan(for: inputs(foreground: true)) == .dial)
    }

    // MARK: The plan

    @Test func onlyADisconnectedPairingDials() {
        #expect(SessionDialPolicy.plan(for: inputs(state: .pairedDisconnected)) == .dial)
        for state: PairingClientState in [
            .unpaired, .scanning, .sessionConnecting, .connected(session), .revoked,
            .rejected("nope")
        ] {
            #expect(SessionDialPolicy.plan(for: inputs(state: state)) == .idle,
                    "\(state) must not dial")
        }
    }

    /// The rung ladder. A clean history dials at once, which is what keeps ADR-0089's "re-dial
    /// NOW during a handover" true without a special case: a session that was healthy until the
    /// carrier died left the outcome clean.
    @Test func theRungLadderFollowsTheLastOutcome() {
        #expect(SessionDialPolicy.plan(for: inputs(outcome: .clean)) == .dial)
        #expect(SessionDialPolicy.plan(for: inputs(outcome: .failed))
                == .backoff(ms: Config.sessionReconnectRetryDelayMs))
        #expect(SessionDialPolicy.plan(for: inputs(outcome: .unreachable))
                == .backoff(ms: Config.sessionEndedRetryDelayMs))
    }

    /// ADR-0104's verdict is a longer rung, never a stop. A client that gives up entirely is
    /// one the user has to force-quit, which is the failure this whole area keeps producing.
    @Test func theUnreachableVerdictStillRetries() {
        let plan = SessionDialPolicy.plan(for: inputs(outcome: .unreachable))
        guard case .backoff(let ms) = plan else {
            Issue.record("unreachable must still schedule a retry, got \(plan)")
            return
        }
        #expect(ms > Config.sessionReconnectRetryDelayMs)
    }

    /// A closed gate outranks the rung: no amount of elapsed backoff dials a backgrounded or
    /// deliberately disconnected client.
    @Test func aClosedGateOutranksTheRung() {
        #expect(SessionDialPolicy.plan(for: inputs(foreground: false, outcome: .clean)) == .idle)
        #expect(SessionDialPolicy.plan(for: inputs(disconnected: true, outcome: .clean)) == .idle)
    }
}
