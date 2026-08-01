import Testing
import AgentDeskWire

struct HostStatusPresentationTests {
    @Test func healthyAvailabilityShowsNothing() {
        #expect(HostStatusPresentation.forAvailability(.active) == .hidden)
        #expect(HostStatusPresentation.forAvailability(.disconnected) == .hidden)
    }

    /// A locked Mac is a healthy session: nothing is in flight and nothing needs recovering,
    /// so neither affordance belongs on screen.
    @Test func lockedMacExplainsItselfWithoutOfferingRecovery() {
        let locked = HostStatusPresentation.forAvailability(.locked)
        #expect(locked.message != nil)
        #expect(!locked.showsActivity)
        #expect(!locked.offersReconnect)
    }

    /// The measured case this overlay exists for: the host ended the session and the client
    /// still believed it was connected, so the only way out was force-quitting the app.
    @Test func captureUnavailableAlwaysOffersAWayOut() {
        let unavailable = HostStatusPresentation.forAvailability(.captureUnavailable)
        #expect(unavailable.message != nil)
        #expect(unavailable.offersReconnect)
    }

    /// A handover is a transition over a picture that is still on screen, so it spins; and it
    /// keeps the escape hatch, because a redial that never lands would otherwise strand the
    /// user watching a frozen frame forever.
    @Test func networkSwitchSpinsAndStillOffersAWayOut() {
        #expect(HostStatusPresentation.switchingNetwork.showsActivity)
        #expect(HostStatusPresentation.switchingNetwork.offersReconnect)
    }

    /// Once the user has asked for the reconnect by hand, offering it again says nothing.
    @Test func manualReconnectWithdrawsTheOfferWhileItRuns() {
        #expect(HostStatusPresentation.reconnecting.showsActivity)
        #expect(!HostStatusPresentation.reconnecting.offersReconnect)
    }
}
