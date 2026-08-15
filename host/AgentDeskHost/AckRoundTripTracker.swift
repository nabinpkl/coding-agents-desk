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
/// The standard test is smoothed RTT against the path's floor. Smoothed rises with queueing;
/// the floor is where the path sits when its buffers are empty. Their ratio is queue depth.
///
/// Smoothing follows RFC 6298's constants (1/8 for the mean, 1/4 for the variation), which
/// is what every congestion controller uses and is well behaved on the bursty, 2Hz-ish
/// sample rate the ack loop produces.
///
/// The floor decays deliberately. A permanent floor would latch onto one lucky early sample
/// and then claim every later measurement is inflated; a floor that only ever tracks the
/// recent past would follow the queue up and report no inflation at all. So it is drawn from
/// samples inside a sliding window, and is allowed to rise once that window ages out, which
/// is also what makes it survive a genuine path change to a slower link.
///
/// **The floor is a low percentile, not the minimum, and that is a correction.** The window
/// minimum is a single sample, so it is exactly the one most distorted by luck: on Wi-Fi a
/// frame occasionally lands in 6ms while the path's honest resting level is nearer 20ms, and
/// dividing by that outlier reports a queue that is not there. Measured on a real session --
/// 3466 samples, `rttMinMs` 6-8ms against a smoothed 25ms -- the median window read an
/// inflation of 2.7 and 57% of windows sat above the 2.5 "bloated" threshold, on a link with
/// zero loss and no visible queue. That verdict is fed to `resetRecovery()`, which zeroes a
/// 30-SECOND clean-time requirement, so a floor set by an outlier made the resolution ladder
/// unable to climb at all: 30 consecutive clean windows at a 57% per-window reset rate is
/// about 10^-11. The picture stayed pinned at the emergency floor for twenty unbroken minutes.
///
/// A low percentile keeps everything the minimum was for -- it still sits at the bottom of the
/// distribution, still decays with the window, still catches a genuine standing queue, and the
/// freeze case that motivated ADR-0088 measured 5.0, far above any threshold this moves. What
/// it stops doing is treating the single luckiest packet in thirty seconds as the truth about
/// the path.
struct AckRoundTripTracker: Equatable, Sendable {
    /// RFC 6298 SRTT gain.
    private static let smoothingAlpha = 0.125
    /// RFC 6298 RTTVAR gain.
    private static let variationBeta = 0.25

    private struct Sample: Equatable, Sendable {
        let rttMs: Double
        let atNs: UInt64
    }

    /// How long a sample stays eligible to shape the floor.
    let minimumWindowNs: UInt64
    /// Which percentile of the window stands in for the path's floor. 0 reproduces the old
    /// minimum-based behaviour exactly, which is what makes this reviewable against it.
    let floorPercentile: Double

    private(set) var smoothedMs: Double?
    private(set) var variationMs: Double?
    private(set) var sampleCount: Int = 0
    private(set) var latestMs: Double?

    /// Every sample still inside the window, in arrival order. The previous implementation kept
    /// a monotonic deque, which is O(1) but can only ever answer "minimum" -- a percentile needs
    /// the distribution. The window holds seconds of a ~2Hz ack stream, so this is tens of
    /// entries, and arrival order means expiry is a prefix drop rather than a scan.
    private var samples: [Sample] = []

    init(minimumWindowMs: Int, floorPercentile: Double = Config.ownedMediaRoundTripFloorPercentile) {
        self.minimumWindowNs = UInt64(max(1, minimumWindowMs)) * 1_000_000
        self.floorPercentile = min(max(0, floorPercentile), 100)
    }

    /// The lowest RTT still inside the window.
    ///
    /// Reported for telemetry, deliberately NOT the divisor any more -- see `floorMs`. Keeping
    /// both visible is what lets a log line show that a path's luckiest sample and its resting
    /// level have diverged, which is the condition this type got wrong.
    var minimumMs: Double? { samples.map(\.rttMs).min() }

    /// The path's floor: a low percentile of the window, and the divisor for `inflationRatio`.
    /// Truncated, never rounded, and that is load-bearing rather than a detail. The index is how
    /// many low samples the floor is allowed to discard, so rounding up discards one MORE than
    /// the percentile asked for -- and on a short window that one sample is the whole evidence
    /// of the pre-queue floor. A queue that has just started looks exactly like a lone low
    /// sample among high ones; truncation keeps it, so detection is not delayed at the moment
    /// it matters most, when the window still holds only a few samples.
    var floorMs: Double? {
        guard !samples.isEmpty else { return nil }
        let sorted = samples.map(\.rttMs).sorted()
        let position = floorPercentile / 100.0 * Double(sorted.count - 1)
        let index = min(max(0, Int(position)), sorted.count - 1)
        return sorted[index]
    }

    /// How many times the smoothed RTT exceeds the floor. 1.0 is an empty queue.
    ///
    /// nil until there is a floor to divide by. Guards against a zero floor, which a
    /// same-host or loopback path can genuinely produce.
    var inflationRatio: Double? {
        guard let smoothedMs, let floorMs, floorMs > 0.0001 else { return nil }
        return smoothedMs / floorMs
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

        samples.append(Sample(rttMs: rttMs, atNs: nowNs))
        expireMinimumCandidates(nowNs: nowNs)
    }

    /// Ages out floor samples. Called on record, and separately on window boundaries so a
    /// silent stretch (no acks at all, which is exactly what a freeze looks like) still lets
    /// a stale floor expire instead of pinning the ratio to an ancient value.
    mutating func expireMinimumCandidates(nowNs: UInt64) {
        var expired = 0
        while expired < samples.count {
            let sample = samples[expired]
            guard nowNs >= sample.atNs, nowNs - sample.atNs > minimumWindowNs else { break }
            expired += 1
        }
        if expired > 0 {
            samples.removeFirst(expired)
        }
    }
}
