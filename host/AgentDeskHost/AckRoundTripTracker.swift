import Foundation

/// ADR-0088: the queueing detector.
///
/// `MediaQualityController` already samples a true round-trip time on every ack
/// (`noteAck` returns the acked frame's send timestamp), but it only kept per-window
/// p50/p95/max. Those describe the current level and cannot tell you whether the level is
/// *inflated*, because there is no baseline to compare against. A path that delays instead
/// of dropping shows a healthy loss count and a p50 that has quietly moved from 40ms to
/// 12s, and the loss-only ladder reads that as fine.
///
/// The standard test is smoothed RTT against minimum RTT. Smoothed rises with queueing;
/// the minimum is the path's floor when its buffers are empty. Their ratio is queue depth.
///
/// Smoothing follows RFC 6298's constants (1/8 for the mean, 1/4 for the variation), which
/// is what every congestion controller uses and is well behaved on the bursty, 2Hz-ish
/// sample rate the ack loop produces.
///
/// The minimum decays deliberately. A permanent minimum would latch onto one lucky early
/// sample and then claim every later measurement is inflated; a minimum that only ever
/// tracks the recent past would follow the queue up and report no inflation at all. So the
/// floor is the lowest sample within a sliding window, and it is allowed to rise once that
/// window ages out, which is also what makes it survive a genuine path change to a slower
/// link.
struct AckRoundTripTracker: Equatable, Sendable {
    /// RFC 6298 SRTT gain.
    private static let smoothingAlpha = 0.125
    /// RFC 6298 RTTVAR gain.
    private static let variationBeta = 0.25

    private struct MinimumSample: Equatable, Sendable {
        let rttMs: Double
        let atNs: UInt64
    }

    /// How long a sample stays eligible to be the minimum.
    let minimumWindowNs: UInt64

    private(set) var smoothedMs: Double?
    private(set) var variationMs: Double?
    private(set) var sampleCount: Int = 0
    private(set) var latestMs: Double?

    /// Monotonically increasing floor candidates: each entry is strictly lower than the one
    /// before it, so the head is always the window minimum. Bounded by construction, since a
    /// new sample pops every candidate it undercuts.
    private var minimumCandidates: [MinimumSample] = []

    init(minimumWindowMs: Int) {
        self.minimumWindowNs = UInt64(max(1, minimumWindowMs)) * 1_000_000
    }

    /// The path's floor: the lowest RTT still inside the sliding window.
    var minimumMs: Double? { minimumCandidates.first?.rttMs }

    /// How many times the smoothed RTT exceeds the floor. 1.0 is an empty queue.
    ///
    /// nil until there is a floor to divide by. Guards against a zero floor, which a
    /// same-host or loopback path can genuinely produce.
    var inflationRatio: Double? {
        guard let smoothedMs, let minimumMs, minimumMs > 0.0001 else { return nil }
        return smoothedMs / minimumMs
    }

    mutating func record(rttMs: Double, nowNs: UInt64) {
        guard rttMs.isFinite, rttMs >= 0 else { return }
        sampleCount += 1
        latestMs = rttMs

        if let previous = smoothedMs, let previousVariation = variationMs {
            let deviation = abs(previous - rttMs)
            variationMs = (1 - Self.variationBeta) * previousVariation + Self.variationBeta * deviation
            smoothedMs = (1 - Self.smoothingAlpha) * previous + Self.smoothingAlpha * rttMs
        } else {
            // RFC 6298 first-sample seeding.
            smoothedMs = rttMs
            variationMs = rttMs / 2
        }

        // Drop candidates this sample undercuts: they can never be the minimum again.
        while let last = minimumCandidates.last, last.rttMs >= rttMs {
            minimumCandidates.removeLast()
        }
        minimumCandidates.append(MinimumSample(rttMs: rttMs, atNs: nowNs))
        expireMinimumCandidates(nowNs: nowNs)
    }

    /// Ages out floor candidates. Called on record, and separately on window boundaries so a
    /// silent stretch (no acks at all, which is exactly what a freeze looks like) still lets
    /// a stale floor expire instead of pinning the ratio to an ancient value.
    mutating func expireMinimumCandidates(nowNs: UInt64) {
        while let first = minimumCandidates.first,
              nowNs >= first.atNs,
              nowNs - first.atNs > minimumWindowNs {
            minimumCandidates.removeFirst()
        }
    }
}
