import Foundation
import Testing
import AgentDeskWire

/// Where a client lands when the session under it is gone.
///
/// This is the guard on a bug that had no other alarm: `triggerSessionIfPaired` re-dials only
/// from `.pairedDisconnected`, nothing observes the state reactively, and every re-dial trigger
/// is an explicit call site. So a live state that does NOT fall back is not a wrong label, it is
/// a client that never dials again -- no video, no session, until the user force-quits.
/// Backgrounding mid-dial stranded `.sessionConnecting` exactly that way.
struct SessionTeardownStateTests {
    private let session = ActiveSession(
        sessionId: "session-1",
        deviceFingerprint: DeviceFingerprint("device"),
        establishedAt: 1_800_000_000
    )

    private func payload() -> PairingPayload {
        PairingPayload(
            hostFingerprint: "host",
            hostPublicKey: Data(repeating: 1, count: 32),
            tailnetFQDN: "mac.tailnet.ts.net",
            tailnetIPv4: "100.64.0.10",
            oneTimeNonce: Data(repeating: 7, count: 32),
            expiresAt: 1_800_000_090,
            signalingPort: 41_888
        )
    }

    /// The regression. `.connected` was handled and `.sessionConnecting` was not, which is the
    /// difference between backgrounding a working session (recovered) and backgrounding one that
    /// was still dialing (dead).
    @Test func bothLiveSessionStatesFallBackToDialable() {
        #expect(PairingClientState.connected(session).afterSessionTeardown == .pairedDisconnected)
        #expect(PairingClientState.sessionConnecting.afterSessionTeardown == .pairedDisconnected)
    }

    /// Terminal verdicts must never be resurrected into a dialable state by a transport event:
    /// a revoked or rejected pairing that starts dialing again is a security regression, not a
    /// recovery.
    @Test func terminalVerdictsAreNotResurrected() {
        #expect(PairingClientState.revoked.afterSessionTeardown == nil)
        #expect(PairingClientState.rejected("nope").afterSessionTeardown == nil)
        #expect(PairingClientState.unpaired.afterSessionTeardown == nil)
    }

    /// The pairing flow is a different flow, and may not have stored material yet. A session
    /// teardown arriving mid-pairing must not shunt it to a state that implies a stored pairing.
    @Test func pairingFlowStatesAreLeftAlone() {
        let payload = payload()
        #expect(PairingClientState.scanning.afterSessionTeardown == nil)
        #expect(PairingClientState.pairing(payload).afterSessionTeardown == nil)
        #expect(PairingClientState.awaitingApproval(payload).afterSessionTeardown == nil)
    }

    /// Already down: no transition, so a repeated teardown cannot churn the state.
    @Test func anAlreadyDisconnectedClientStaysPut() {
        #expect(PairingClientState.pairedDisconnected.afterSessionTeardown == nil)
    }
}
