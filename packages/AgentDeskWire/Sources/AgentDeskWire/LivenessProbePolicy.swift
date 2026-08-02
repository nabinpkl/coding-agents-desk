import Foundation

/// Phase 3 of the handover architecture: decide, from unanswered probes, whether the downlink is
/// dead when nothing about the link has visibly moved.
///
/// `HandoverRecoveryPolicy` only fires on a detected link change, and R212 measured the failure
/// that gate cannot see: twice, the connection died with the link completely stable. The host
/// ended the session, the client never noticed, and force-quitting the app was the only way out.
/// The gate is not wrong, it is too narrow -- a session can die without the link moving.
///
/// The obvious replacement, "silent for N seconds means dead", is unusable. The datagram carrier
/// is host-to-client only and the host sends nothing when the screen is static, so R212 recorded
/// **healthy** windows with arrival gaps up to 12.4 seconds. Any threshold below that fires on
/// an idle desktop; any threshold above it is slower than the transport it is meant to beat.
///
/// So silence is not the evidence. The client sends a probe the host is obliged to answer, and
/// counts probes that go unanswered. That converts an ambiguous quiet period into a positive
/// signal, and it costs one small datagram each way rather than the ~244KB keyframe that
/// `HandoverRecoveryPolicy` uses as its probe -- affordable for a handover at one per switch,
/// unaffordable as a poll.
///
/// Probing only while nothing is arriving keeps the steady-state cost at zero: a session with
/// frames flowing already has its answer, and the arrival that proves the downlink is the same
/// counter that clears the unanswered run.
public enum LivenessProbePolicy {
    public struct Decision: Equatable, Sendable {
        /// Send a probe now and count it as outstanding.
        public let sendProbe: Bool
        /// Enough probes have gone unanswered; the downlink is dead.
        public let declareDead: Bool

        public init(sendProbe: Bool, declareDead: Bool) {
            self.sendProbe = sendProbe
            self.declareDead = declareDead
        }
    }

    /// - Parameters:
    ///   - hasEverArrived: whether this session has carried a single datagram yet. Until it has,
    ///     this stays silent: it detects a session dying, not one failing to start, and the two
    ///     look identical from here. A session whose host has not begun reading control messages
    ///     would otherwise be declared dead by the probes it cannot yet answer, roughly six
    ///     seconds into its own startup.
    ///   - sawArrival: whether any datagram arrived in this window. The echo is itself an
    ///     arrival, so this is how an answered probe reports back -- there is no separate
    ///     matching of echoes to probes, because any traffic at all proves the same thing.
    ///   - msSinceLastProbe: time since the last probe went out, or nil if none has. Nil probes
    ///     immediately, so the first silent window starts the clock rather than waiting a full
    ///     interval to begin waiting.
    ///   - unansweredProbes: how many probes have gone out with no arrival since.
    ///   - probeIntervalMs: minimum spacing between probes. Also the resolution of the verdict,
    ///     since the run is counted in probes rather than in time.
    ///   - failureThreshold: unanswered probes required to declare the downlink dead. Above one
    ///     so ordinary datagram loss cannot fire it: at the 0.2% measured at rest, three
    ///     consecutive round trips lost is about one in ten million.
    public static func evaluate(
        hasEverArrived: Bool,
        sawArrival: Bool,
        msSinceLastProbe: Double?,
        unansweredProbes: Int,
        probeIntervalMs: Double,
        failureThreshold: Int
    ) -> Decision {
        // Nothing has ever arrived, so there is no established liveness to lose.
        guard hasEverArrived else { return Decision(sendProbe: false, declareDead: false) }
        // Traffic is the answer, whatever produced it. Nothing to probe, nothing to declare.
        guard !sawArrival else { return Decision(sendProbe: false, declareDead: false) }
        // Checked before sending rather than after, so the verdict rests on probes that have
        // had a full interval to be answered rather than on one just handed to the network.
        guard unansweredProbes < failureThreshold else {
            return Decision(sendProbe: false, declareDead: true)
        }
        let due = msSinceLastProbe.map { $0 >= probeIntervalMs } ?? true
        return Decision(sendProbe: due, declareDead: false)
    }
}
