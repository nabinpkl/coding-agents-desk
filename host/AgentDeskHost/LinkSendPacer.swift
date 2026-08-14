import Foundation

/// ADR-0098: the media path's rate governor, and the only thing in it that decides *when*
/// bytes may leave.
///
/// That authority did not exist before. The encoder's `DataRateLimits` bounds an average over a
/// sliding window, which VideoToolbox honours by starving the frames after a keyframe rather than
/// by shrinking it; the datagram burst pacer it replaces bounded the host's own QUIC send buffer.
/// Neither bounds the instantaneous wire rate, so a 96,408-byte keyframe left in about 2ms against
/// a link draining at 37KB/s. The cellular queue it filled took two seconds to clear, and the host
/// read that as a stall and forced another keyframe into it.
///
/// Two dials doing different jobs:
///
/// - `bytesPerSecond` is the sustained budget, retargeted as the ladder moves.
/// - `burstBytes` is how much may leave back-to-back, and it is the anti-burst control. The
///   keyframe is not made smaller here, it is spread. Making it smaller is the encoder's job.
///
/// Previously `GraphicsSendPacer`, written for the reliable graphics channel that ADR-0026 retired.
/// Its reasoning was already right for this path -- its own comment names "100KB+ frames that,
/// ungated, sum to ~4x the link and saturate the send buffer" as the freeze cascade -- it simply
/// lost its caller and kept its tests. Only the rate had to become movable, because unlike that
/// channel's fixed link budget, this one is chosen by the quality ladder several times a second.
struct LinkSendPacer {
    /// The sustained budget. `private(set)` because it moves only through `retarget`, which has
    /// to settle the balance before adopting a new rate.
    private(set) var bytesPerSecond: Double
    let burstBytes: Double
    private var tokens: Double
    private var lastAdvanceNs: UInt64?

    init(bytesPerSecond: Double, burstBytes: Double) {
        self.bytesPerSecond = max(1, bytesPerSecond)
        self.burstBytes = max(1, burstBytes)
        self.tokens = self.burstBytes
    }

    /// The wire budget for a quality rung's bitrate.
    ///
    /// `headroom` is deliberately the encoder's own `DataRateLimits` ratio rather than a second
    /// independent number. The encoder is permitted to emit that multiple of the average in a
    /// one-second window; if the wire were paced tighter than what the encoder is allowed to
    /// produce, this would become the binding constraint and back up a queue on the host instead
    /// of on the link -- the same failure moved one hop upstream.
    static func bytesPerSecond(forKbps kbps: Int, headroom: Double) -> Double {
        Double(max(1, kbps)) * 1_000.0 / 8.0 * max(1.0, headroom)
    }

    /// ADR-0098: the budget once the link has been measured, closing the loop.
    ///
    /// The rung is what the host DECIDED to ask for; `deliveredBytesPerSecond` is what the link
    /// was observed to carry (`LinkDeliveryEstimator`). Pacing to the rung alone leaves the
    /// original defect intact one layer down: the ladder can be a full step behind the link, and
    /// for that step the wire happily emits bytes at a rate nothing is draining.
    ///
    /// Three properties this has to have, and each is a way it could go wrong:
    ///
    /// - It only ever paces DOWN from the rung. The measurement is a lower bound on capacity, not
    ///   a licence to exceed the quality decision, and the encoder is not producing more than the
    ///   rung anyway.
    /// - A nil measurement means unknown, and unknown must read as the rung. Treating it as zero
    ///   would stop the very sends that produce the acks the estimate is built from.
    /// - It never floors below `floorKbps`. A max filter falls by expiry, so a hard enough stall
    ///   walks it to nothing; without a floor the pacer would stop sending, the acks would stop,
    ///   and the estimate could never recover. The floor is what makes the loop reversible.
    static func bytesPerSecond(
        forKbps kbps: Int,
        headroom: Double,
        deliveredBytesPerSecond: Double?,
        floorKbps: Int,
        deliveryHeadroom: Double
    ) -> Double {
        let requested = bytesPerSecond(forKbps: kbps, headroom: headroom)
        guard let deliveredBytesPerSecond, deliveredBytesPerSecond > 0 else { return requested }
        let floor = bytesPerSecond(forKbps: floorKbps, headroom: 1.0)
        let measured = deliveredBytesPerSecond * max(1.0, deliveryHeadroom)
        return min(requested, max(floor, measured))
    }

    /// Non-mutating peek of the balance at `nowNs`: the stored balance plus the budget accrued
    /// since the last consume. It does not advance the clock, so it is safe to call repeatedly
    /// (and from a Testing `#expect` autoclosure) without changing state.
    func availableTokens(nowNs: UInt64) -> Double {
        guard let last = lastAdvanceNs, nowNs > last else { return tokens }
        let secs = Double(nowNs - last) / 1_000_000_000
        return min(burstBytes, tokens + secs * bytesPerSecond)
    }

    /// How long until `bytes` can go out inside the budget.
    ///
    /// Exact rather than a fixed pause, because the caller knows each packet's size before it
    /// sends it. The fixed 1ms pause this replaces had to be wrong in one direction or the
    /// other: too coarse for a small packet, far too generous for a whole keyframe.
    ///
    /// Clamped to `burstBytes` so a packet larger than the bucket is merely delayed by a full
    /// bucket rather than waiting for a balance it can never reach. The pump must not be able to
    /// deadlock on its own arithmetic.
    func waitNanos(forBytes bytes: Int, nowNs: UInt64) -> UInt64 {
        let wanted = min(Double(max(0, bytes)), burstBytes)
        let deficit = wanted - availableTokens(nowNs: nowNs)
        guard deficit > 0 else { return 0 }
        return UInt64((deficit / bytesPerSecond * 1_000_000_000).rounded(.up))
    }

    mutating func consume(bytes: Int, nowNs: UInt64) {
        tokens = availableTokens(nowNs: nowNs)
        lastAdvanceNs = nowNs
        tokens -= Double(max(0, bytes))
        // Bound the debt so one oversized packet cannot stall the pump for many seconds;
        // recovery after any packet is at most burstBytes / bytesPerSecond. Callers that gate
        // on `waitNanos` first never reach it, but `consume` is the primitive and must be safe
        // for one that does not.
        if tokens < -burstBytes { tokens = -burstBytes }
    }

    /// Adopt a new budget without discarding the balance.
    ///
    /// Settles at the OLD rate first, so elapsed time is credited at the rate that was actually
    /// in force for it. Rebuilding the bucket instead would hand back a full one on every step,
    /// and the ladder steps several times a second during a descent -- which is exactly the
    /// stretch where the pacing is load-bearing.
    mutating func retarget(bytesPerSecond: Double, nowNs: UInt64) {
        tokens = availableTokens(nowNs: nowNs)
        lastAdvanceNs = nowNs
        self.bytesPerSecond = max(1, bytesPerSecond)
    }
}
