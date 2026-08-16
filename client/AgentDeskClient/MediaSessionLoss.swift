import AgentDeskWire

/// Why a media session stopped.
///
/// Dependency-free (no UIKit) so the presentation mapping that reads it stays test-compiled.
enum MediaSessionLoss: Equatable {
    /// ADR-0104: the session stopped completing round trips with the host.
    ///
    /// This replaced a pair of reasons -- `linkChanged` and `hostSilent` -- that claimed to
    /// distinguish "the phone's radio moved" from "the Mac stopped answering". The distinction
    /// read well and could not actually be made: each came from a separate detector watching a
    /// different signal, and the one that fired first named the cause. Measured, that produced
    /// `hostSilent` thirteen times in a session where the host had answered every single probe,
    /// and `linkChanged` on the one occasion the host genuinely was still there. Naming a cause
    /// we cannot determine is worse than declining to, because the name reaches the user as a
    /// sentence about which of their machines is broken.
    case hostUnreachable
    /// The transport reported failure with no more specific cause, or the session went quiet
    /// long enough for the disconnect grace to expire.
    case transportFailed
    /// The host refused the session. Not recoverable by retrying, so this one ends the session
    /// rather than starting a recovery.
    case rejected(SessionRejected)
}

/// Thrown when a caller reaches for a transport's connection after it closed.
///
/// Loud on purpose. The transport releases its QUIC connection at close (see `Channels`), so
/// every send and receive afterwards has to fail; a silent no-op here would turn "the session
/// is gone" into "nothing happened", which is the shape of bug that takes a device run to find.
struct QuicSessionTransportClosed: Error, Equatable {}
