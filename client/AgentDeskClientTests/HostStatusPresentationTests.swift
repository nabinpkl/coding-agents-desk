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
    @Test func recoveryOutranksTheAvailabilityItsOwnTeardownSynthesizes() {
        let resolved = HostStatusPresentation.resolve(
            activity: .recovering(.linkChanged),
            availability: .captureUnavailable
        )
        #expect(resolved == HostStatusPresentation.forLoss(.linkChanged))
        #expect(resolved != HostStatusPresentation.forAvailability(.captureUnavailable))
    }

    /// A network switch blames the network. Naming the Mac here was the complaint.
    @Test func aLinkChangeNeverBlamesTheMac() {
        let message = HostStatusPresentation.forLoss(.linkChanged).message
        #expect(message == "Switching network…")
        #expect(HostStatusPresentation.forLoss(.linkChanged).showsActivity)
    }

    /// An unanswered probe on a path that never moved is the opposite diagnosis, and says so.
    @Test func silenceOnAStablePathBlamesTheHost() {
        #expect(HostStatusPresentation.forLoss(.hostSilent).message == "Mac stopped responding")
        #expect(HostStatusPresentation.forLoss(.transportFailed).message == "Connection lost")
    }

    /// Every recovery keeps a way out, whatever it blames: any of them can fail to land.
    @Test func everyRecoveryKeepsAnEscapeHatch() {
        for loss in [MediaSessionLoss.linkChanged, .hostSilent, .transportFailed] {
            #expect(HostStatusPresentation.forLoss(loss).offersReconnect)
        }
    }

    @Test func aLiveSessionLetsTheHostSpeakForItself() {
        #expect(
            HostStatusPresentation.resolve(activity: .live, availability: .locked)
                == HostStatusPresentation.forAvailability(.locked)
        )
        #expect(HostStatusPresentation.resolve(activity: .live, availability: .active) == .hidden)
    }
}
