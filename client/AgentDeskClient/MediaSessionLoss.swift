import AgentDeskWire

/// Why a media session stopped.
///
/// The client already knows the difference at the moment it decides a session is dead, and
/// used to throw it away: both the handover path and the liveness path yielded a bare
/// `failed(nil)`. Downstream that left one undifferentiated failure, so a network switch and a
/// Mac that stopped answering produced the same words on screen -- and "Mac display
/// unavailable" is actively wrong during a WiFi-to-cellular handover, where the Mac is fine and
/// the phone's own radio moved.
///
/// Dependency-free (no UIKit) so the presentation mapping that reads it stays test-compiled.
enum MediaSessionLoss: Equatable {
    /// The path under the session moved -- interface or local address changed -- and then went
    /// silent past the grace window. The network under us switched; nothing says the host is
    /// unwell. See `HandoverRecoveryPolicy` for why a link change alone is not enough.
    case linkChanged
    /// Liveness probes went unanswered on a path that never moved. The host stopped answering
    /// and the network is not the obvious suspect.
    case hostSilent
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
