import Foundation

/// ADR-0098: what the link actually delivered, from evidence the host already collected.
///
/// Every rate in the media path before this was a number the host *asked for*: the rung's
/// `bitrateKbps`, the encoder's `AverageBitRate`, the pacer's refill target. None of them is a
/// measurement. During the 2026-08-13 freeze the ladder sat at a 300kbps rung, the encoder
/// reported `sentKbps=768`, and the client received nothing for two seconds -- three numbers, no
/// agreement, and not one of them was the link.
///
/// The measurement was already there and was being thrown away. `GraphicsBackpressure.noteAck`
/// retires in-flight frames that each carry their wire size; acked bytes over elapsed time is
/// goodput, in the only unit that matters: bytes the client confirmed it holds.
///
/// Two things make this honest rather than a self-fulfilling collapse:
///
/// **App-limited samples are discarded.** A calm screen delivers almost nothing because almost
/// nothing was offered. Feeding that back as "the link is slow" would ratchet a perfectly good
/// link to the floor and keep it there, since the lower rate produces even fewer bytes to
/// measure. So a slice only counts when there was a backlog for its whole span -- when the host
/// had more to send than got through, the rate observed IS the link's rate.
///
/// **The estimate is a windowed maximum, not an average.** This is BBR's max-bandwidth filter and
/// the reason is the same: any single slice can be low for reasons that are not the link (a
/// coalesced ack, a scheduling gap), but nothing can make a slice spuriously *high* -- those
/// bytes really did arrive. The max over a few seconds is the best lower bound on capacity we
/// have. Old samples age out, so a link that genuinely got worse is followed down.
struct LinkDeliveryEstimator: Equatable, Sendable {
    private struct Sample: Equatable, Sendable {
        let bytesPerSecond: Double
        let atNs: UInt64
    }

    /// How long delivery is accumulated before it becomes one sample.
    ///
    /// Short enough that a stall shows up inside a quality window, long enough that a single
    /// coalesced ack does not become the whole slice.
    let sliceNs: UInt64
    /// How long a sample stays eligible to be the maximum.
    let windowNs: UInt64

    private var sliceStartNs: UInt64?
    private var sliceDeliveredBytes = 0
    /// Whether the host had something queued for the entire slice. False the moment the
    /// in-flight list empties: from there the rate observed is the host's, not the link's.
    private var sliceWasBacklogged = true
    /// Monotonically decreasing max candidates: each entry is strictly higher than the one
    /// after it, so the head is always the window maximum. Bounded by construction.
    private var maximumCandidates: [Sample] = []

    init(sliceMs: Int, windowMs: Int) {
        self.sliceNs = UInt64(max(1, sliceMs)) * 1_000_000
        self.windowNs = UInt64(max(1, windowMs)) * 1_000_000
    }

    /// The best lower bound on the link's capacity, in bytes per second.
    ///
    /// nil until a backlogged slice has completed. A caller must treat that as "unknown", not as
    /// zero -- the difference is a link that has not been probed versus one that is dead, and
    /// only the second is a reason to send less.
    var deliveredBytesPerSecond: Double? { maximumCandidates.first?.bytesPerSecond }

    /// Retire acked bytes.
    ///
    /// `backlogBytesAfter` is the in-flight byte count once this ack's frames are retired. Zero
    /// means the host has nothing left outstanding, which disqualifies the slice in progress:
    /// whatever rate it observed was bounded by what the host offered.
    mutating func noteDelivered(bytes: Int, backlogBytesAfter: Int, nowNs: UInt64) {
        guard bytes > 0 else {
            if backlogBytesAfter <= 0 { sliceWasBacklogged = false }
            return
        }
        guard let start = sliceStartNs else {
            // The bytes that OPEN a slice are deliberately not counted into it. A rate is bytes
            // divided by the interval they arrived over, and for the first ack that interval is
            // unknown -- crediting them to a zero-length prefix reports a rate no link achieved.
            // Only the very first ack after a start or a discard is dropped this way; once slices
            // are running back-to-back, the ack that closes one is counted in it.
            sliceStartNs = nowNs
            sliceDeliveredBytes = 0
            sliceWasBacklogged = backlogBytesAfter > 0
            return
        }
        sliceDeliveredBytes += bytes
        if backlogBytesAfter <= 0 { sliceWasBacklogged = false }

        let elapsed = nowNs >= start ? nowNs - start : 0
        guard elapsed >= sliceNs else { return }
        closeSlice(elapsedNs: elapsed, nowNs: nowNs)
    }

    /// Ages out max candidates. Called on window boundaries as well as on delivery, because a
    /// freeze delivers nothing at all -- the one stretch where an expiry that could only happen
    /// inside `noteDelivered` would keep reporting a pre-freeze capacity forever.
    mutating func expire(nowNs: UInt64) {
        while let first = maximumCandidates.first,
              nowNs >= first.atNs,
              nowNs - first.atNs > windowNs {
            maximumCandidates.removeFirst()
        }
    }

    /// Throw away the slice in progress without touching the window.
    ///
    /// For anything that empties the in-flight list without the link having delivered it -- a
    /// stall flush, a rung change. The backlog the slice was measuring against is gone, so its
    /// rate would be an app-limited sample wearing a link-limited label. The completed samples
    /// still describe this link and are kept.
    mutating func discardPendingSlice() {
        sliceStartNs = nil
        sliceDeliveredBytes = 0
        sliceWasBacklogged = true
    }

    // There is deliberately no whole-estimator reset. A reconnect's samples would indeed be
    // wrong to carry, but `QuicSessionHostMediaState` is constructed per connection, so a new
    // link already gets a new estimator. Adding one anyway would be another correct component
    // with no caller, which is the thing this ADR is about.

    private mutating func closeSlice(elapsedNs: UInt64, nowNs: UInt64) {
        defer {
            sliceStartNs = nowNs
            sliceDeliveredBytes = 0
            sliceWasBacklogged = true
        }
        guard sliceWasBacklogged, elapsedNs > 0 else { return }
        let rate = Double(sliceDeliveredBytes) * 1_000_000_000.0 / Double(elapsedNs)
        guard rate.isFinite, rate > 0 else { return }
        while let last = maximumCandidates.last, last.bytesPerSecond <= rate {
            maximumCandidates.removeLast()
        }
        maximumCandidates.append(Sample(bytesPerSecond: rate, atNs: nowNs))
        expire(nowNs: nowNs)
    }
}
