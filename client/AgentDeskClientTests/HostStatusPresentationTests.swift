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

    /// Once the user has asked for the reconnect by hand, offering it again says nothing.
    @Test func manualReconnectWithdrawsTheOfferWhileItRuns() {
        #expect(HostStatusPresentation.reconnecting.showsActivity)
        #expect(!HostStatusPresentation.reconnecting.offersReconnect)
    }
}

/// The race this resolver exists to settle. During a handover the client applies its own
/// state, and milliseconds later its transport reaches `.closed` and synthesizes a
/// `captureUnavailable` push -- from the client, about itself. Under last-writer-wins that
/// second write won, and a WiFi-to-cellular switch told the user the Mac was unavailable.
struct HostStatusResolutionTests {
    @Test func reattachingOutranksTheAvailabilityItsOwnTeardownSynthesizes() {
        let resolved = HostStatusPresentation.resolve(
            activity: .reattaching,
            availability: .captureUnavailable
        )
        #expect(resolved == HostStatusPresentation.reattaching)
        #expect(resolved != HostStatusPresentation.forAvailability(.captureUnavailable))
    }

    /// ADR-0104: the client cannot tell which end broke, so it must not say. "Mac stopped
    /// responding" was shown thirteen times in one measured session while the Mac was
    /// answering every probe. Asserted as an absence: whatever this string becomes, it may
    /// not name a culprit.
    @Test func aReattachBlamesNeitherEnd() {
        let message = HostStatusPresentation.reattaching.message
        #expect(message != nil)
        #expect(!(message ?? "").contains("Mac"))
        #expect(!(message ?? "").contains("network"))
    }

    /// Every recovery keeps a way out: a redial that never lands would otherwise strand the
    /// user waiting on a spinner.
    @Test func aReattachKeepsAnEscapeHatch() {
        #expect(HostStatusPresentation.reattaching.showsActivity)
        #expect(HostStatusPresentation.reattaching.offersReconnect)
    }

    @Test func aLiveSessionLetsTheHostSpeakForItself() {
        #expect(
            HostStatusPresentation.resolve(activity: .live, availability: .locked)
                == HostStatusPresentation.forAvailability(.locked)
        )
        #expect(HostStatusPresentation.resolve(activity: .live, availability: .active) == .hidden)
    }
}
