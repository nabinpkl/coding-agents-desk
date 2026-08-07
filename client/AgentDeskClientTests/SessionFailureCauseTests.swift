import Testing
import Foundation
import Network
import AgentDeskWire

// The reconnect loop never stops, so the status label is the only thing that can tell a
// two-second blip from a Mac whose host process died. These pin the distinction.
struct SessionFailureCauseTests {
    // A refused connection is the one unambiguous signal available: the Mac answered, which
    // means it is up and on the tailnet, and it said nothing is listening on that port.
    @Test func refusedConnectionMeansTheHostIsNotRunning() {
        #expect(SessionFailureCause.classify(POSIXError(.ECONNREFUSED)) == .hostNotRunning)
        #expect(SessionFailureCause.classify(NWError.posix(.ECONNREFUSED)) == .hostNotRunning)
        #expect(
            SessionFailureCause.classify(
                NSError(domain: NSPOSIXErrorDomain, code: Int(ECONNREFUSED))
            ) == .hostNotRunning
        )
    }

    // Silence is not a refusal. A Mac that is asleep and a Mac whose host is dead look the
    // same from here, so this must not claim the stronger of the two.
    @Test func silenceIsReportedAsUnreachableNotAsHostNotRunning() {
        #expect(SessionFailureCause.classify(SessionConnectionReadyTimeout()) == .hostUnreachable)
        #expect(SessionFailureCause.classify(POSIXError(.ETIMEDOUT)) == .hostUnreachable)
        #expect(SessionFailureCause.classify(POSIXError(.EHOSTUNREACH)) == .hostUnreachable)
    }

    @Test func aDeadLocalNetworkIsItsOwnCause() {
        #expect(SessionFailureCause.classify(POSIXError(.ENETDOWN)) == .networkUnavailable)
        #expect(SessionFailureCause.classify(POSIXError(.ENETUNREACH)) == .networkUnavailable)
    }

    // A blocked dial only carries the transport's reason as text, so the POSIX spelling has
    // to be recognised there too or the most useful case degrades to "unknown".
    @Test func aBlockedDialIsClassifiedFromItsReasonText() {
        #expect(
            SessionFailureCause.classify(
                SessionConnectionBlocked(reason: "POSIXErrorCode(rawValue: 61): ECONNREFUSED", afterMs: 2000)
            ) == .hostNotRunning
        )
        #expect(
            SessionFailureCause.classify(
                SessionConnectionBlocked(reason: "ENETDOWN", afterMs: 2000)
            ) == .networkUnavailable
        )
    }

    // Anything unrecognised says so rather than picking the nearest plausible cause. A wrong
    // confident answer sends someone to the wrong machine.
    @Test func anUnrecognisedFailureStaysUnknown() {
        struct Mystery: Error {}
        #expect(SessionFailureCause.classify(Mystery()) == .unknown)
    }

    @Test func aRejectionCarriesItsReason() {
        #expect(
            SessionFailureCause.classify(SessionRejected(reason: .expiredResume))
                == .rejected(.expiredResume)
        )
    }

    // One failure happens on every ordinary host restart. Announcing it would make the label
    // flap through a normal relaunch.
    @Test func oneFailureSaysNothingBeyondReconnecting() {
        #expect(
            SessionFailureCause.reconnectingStatusText(cause: .hostNotRunning, consecutiveFailures: 1)
                == "Paired (reconnecting)"
        )
        #expect(
            SessionFailureCause.reconnectingStatusText(cause: nil, consecutiveFailures: 0)
                == "Paired (reconnecting)"
        )
    }

    @Test func aPersistingFailureNamesItselfAndSaysWhatToDo() {
        let text = SessionFailureCause.reconnectingStatusText(
            cause: .hostNotRunning,
            consecutiveFailures: 2
        )
        #expect(text.hasPrefix("Paired (reconnecting)"))
        #expect(text.contains("AgentDesk isn't running"))
        #expect(text.contains("Open AgentDesk on the Mac"))
    }

    // Only the recoverable reasons reach this label: PairingClient.applyRejection routes
    // revoked, unknown-device, bad-signature to .revoked and incompatible-protocol to
    // .rejected, and the reconnect loop stops on both. What survives here is retryable, so the
    // wording must not tell the user that retrying is hopeless.
    @Test func aRetryableRejectionSaysItIsStillTrying() {
        let text = SessionFailureCause.reconnectingStatusText(
            cause: .rejected(.expiredResume),
            consecutiveFailures: 2
        )
        #expect(text.contains("expired-resume"))
        #expect(text.contains("Trying again"))
    }
}
