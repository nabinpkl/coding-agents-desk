import Foundation

/// ADR-0088: the signal no platform API can give us.
///
/// During the measured 12.79s freeze every client counter was zero, *including*
/// `maxPendingFrameDepth` -- so the client was not slowly reassembling, it was receiving
/// nothing at all. Two very different causes produce that: the network delivered nothing, or
/// our receive `Task` was not scheduled. Path metadata describes the network and cannot tell
/// them apart.
///
/// This does. The receive loop bumps `noteLoopIteration` every time it comes around and
/// `noteArrival` for every datagram it actually pulls off the connection:
///
/// - iterations climbing, arrivals zero -> our loop is alive, the network is silent
/// - both stalled                       -> our task is not running
/// - arrivals steady, huge arrival gap  -> delivery is bursty (the bufferbloat signature)
///
/// Deliberately a plain value type with an injected clock so it is testable without a live
/// connection; the transport wraps it in its existing lock.
public struct DatagramArrivalTracker: Equatable, Sendable {
    public private(set) var arrivals: Int = 0
    public private(set) var loopIterations: Int = 0
    private var maxGapNs: UInt64 = 0
    private var lastArrivalNs: UInt64?

    public init() {}

    public mutating func noteLoopIteration() {
        loopIterations &+= 1
    }

    public mutating func noteArrival(atNs: UInt64) {
        arrivals &+= 1
        if let last = lastArrivalNs, atNs > last {
            maxGapNs = max(maxGapNs, atNs - last)
        }
        lastArrivalNs = atNs
    }

    /// Window counts, resetting them. `nowNs` closes the window against the wall clock rather
    /// than the last arrival, so a window that ENDS in silence reports that silence as the gap
    /// instead of reporting the gap between the last two datagrams before the stall. Without
    /// this, the first window of a freeze looks perfectly healthy.
    public mutating func drain(nowNs: UInt64) -> (arrivals: Int, maxGapMs: Double, loopIterations: Int) {
        if let last = lastArrivalNs, nowNs > last {
            maxGapNs = max(maxGapNs, nowNs - last)
        }
        let result = (
            arrivals: arrivals,
            maxGapMs: Double(maxGapNs) / 1_000_000.0,
            loopIterations: loopIterations
        )
        arrivals = 0
        loopIterations = 0
        maxGapNs = 0
        // lastArrivalNs deliberately survives the drain: the gap across a window boundary is
        // real, and resetting it would hide a stall that straddles two windows.
        return result
    }
}
