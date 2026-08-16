import Foundation

/// Phase 2 of the handover architecture: decide, from a detected link change, whether the
/// session is actually dead and recovery should start.
///
/// The measurement this exists to act on (R208, ADR-0089): a WiFi-to-cellular switch was
/// detected on the client within one report window, about half a second. The media session then
/// delivered nothing for nine seconds. **The transport never reported a failure at all** -- the
/// only `Network is down` in the host log that day was session startup. So recovery cannot wait
/// on the transport admitting anything, because sometimes it never does.
///
/// The obvious rule -- "a link changed, so reconnect" -- is wrong, and expensively so. Tailnet
/// route changes (direct <-> DERP) were measured as transparent: magicsock re-selected the path
/// three times mid-session with no visible break. Tearing down a healthy session on those would
/// turn a non-event into a reconnect, which costs a handshake and a keyframe.
///
/// So a link change **arms** this, it does not fire it. What fires it is a link change followed
/// by continued silence. A transparent route change keeps delivering datagrams, so
/// `sawArrivalSinceChange` goes true and this never fires; a real handover black-holes the
/// downlink, so it stays false and the grace expires.
///
/// The remaining trap is a calm screen. Silence alone is not evidence of a dead link when the
/// host has nothing to send -- that is exactly the false positive fixed host-side in
/// `MediaQualityController.clientLinkStalled`, where a quiet host read as a stalled client.
/// The client cannot see the host's quiet period, so it does not try to infer one: on detecting
/// a change it sends a keyframe request, which obliges the host to produce a frame if the path
/// works at all. That turns ambiguous silence into an answered or unanswered probe, which is
/// why this is probe-then-resume rather than silence-then-resume.
public enum HandoverRecoveryPolicy {
    /// - Parameters:
    ///   - msSinceLinkChange: time since the most recent detected link change, or nil if the
    ///     link has not moved since the session opened. Nil means never recover: with no
    ///     observed change, ordinary stall handling owns the problem (ADR-0087).
    ///   - sawArrivalSinceChange: whether any datagram has arrived since that change. True is a
    ///     hard veto -- the path demonstrably carries traffic, whatever else moved.
    ///   - graceMs: how long to let the link settle before giving up on it.
    /// - Returns: whether to declare the session dead and start recovery.
    public static func shouldRecover(
        msSinceLinkChange: Double?,
        sawArrivalSinceChange: Bool,
        graceMs: Double
    ) -> Bool {
        guard let msSinceLinkChange else { return false }
        guard !sawArrivalSinceChange else { return false }
        return msSinceLinkChange >= graceMs
    }
}
