import AgentDeskWire

/// Why the media path stopped, as reported through `MediaConnectionState.failed`.
///
/// ADR-0104 split what used to be one idea into two. A **carrier** loss
/// (`.transportFailed`) says this QUIC connection is finished and says nothing about the
/// session -- the session keeps its surfaces and redials. A **session** end (`.unreachable`,
/// `.rejected`) is a verdict, and only two things may produce one: the session's own
/// liveness clock, and the host refusing us. The deleted reasons (`linkChanged`,
/// `hostSilent`) claimed to know WHICH end broke; measured, that attribution was wrong in
/// 13 of 14 teardowns, and each wrong name reached the user as a sentence about which of
/// their machines had failed.
///
/// Dependency-free (no UIKit) so the presentation mapping that reads it stays test-compiled.
enum MediaSessionLoss: Equatable {
    /// This carrier died (QUIC failure, stream loss). Not a verdict: the session survives,
    /// keeps its surfaces, and replaces the carrier.
    case transportFailed
    /// The one silence verdict: no completed exchange with the host for the session silence
    /// limit, counted across every carrier tried. Produced only by `SessionLivenessClock`.
    case unreachable(silentMs: Int)
    /// The host refused the session. Not recoverable by retrying, so this one ends the
    /// session rather than starting a recovery.
    case rejected(SessionRejected)
}

/// Thrown when a caller reaches for a transport's connection after it closed.
///
/// Loud on purpose. The transport releases its QUIC connection at close (see `Channels`), so
/// every send and receive afterwards has to fail; a silent no-op here would turn "the session
/// is gone" into "nothing happened", which is the shape of bug that takes a device run to find.
struct QuicSessionTransportClosed: Error, Equatable {}
