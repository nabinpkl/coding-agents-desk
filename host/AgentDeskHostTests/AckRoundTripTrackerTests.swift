import Testing
@testable import AgentDeskHost

// ADR-0088: the queueing detector. These tests pin the property that makes it useful --
// smoothed RTT and the minimum floor must move INDEPENDENTLY -- because a tracker where
// both follow the samples reports no inflation during exactly the freeze it exists to catch.

private let ms = 1_000_000 as UInt64

@Test func smoothedRttClimbsWhileTheFloorHolds() {
    // The signature of a queueing path: same route, buffers filling. Loss counters stay
    // clean, so this is the only thing that moves.
    var tracker = AckRoundTripTracker(minimumWindowMs: 30_000)
    var now: UInt64 = 0
    for _ in 0..<20 {
        tracker.record(rttMs: 40, nowNs: now)
        now += 500 * ms
    }
    #expect(tracker.minimumMs == 40)
    #expect((tracker.inflationRatio ?? 0) < 1.05)

    for _ in 0..<40 {
        tracker.record(rttMs: 2_000, nowNs: now)
        now += 500 * ms
    }

    // Floor unmoved: those 40ms samples are still inside the 30s window.
    #expect(tracker.minimumMs == 40)
    #expect((tracker.smoothedMs ?? 0) > 1_000)
    // Inflation is the whole point: ~50x queue depth.
    #expect((tracker.inflationRatio ?? 0) > 20)
}

@Test func floorRisesOnceTheOldWindowAgesOut() {
    // A genuine move to a slower link must NOT be reported as permanent inflation. Once the
    // fast samples age out, the floor rises to meet the new normal and the ratio settles.
    var tracker = AckRoundTripTracker(minimumWindowMs: 5_000)
    var now: UInt64 = 0
    tracker.record(rttMs: 10, nowNs: now)
    #expect(tracker.minimumMs == 10)

    now += 6_000 * ms
    for _ in 0..<40 {
        tracker.record(rttMs: 300, nowNs: now)
        now += 100 * ms
    }

    #expect(tracker.minimumMs == 300)
    #expect((tracker.inflationRatio ?? 0) < 1.2)
}

@Test func aSilentStretchStillExpiresTheFloor() {
    // A freeze produces NO acks. If the floor could only expire on record(), the ratio would
    // stay pinned to a pre-freeze value for the whole stall, which is when we most need it
    // to be honest.
    var tracker = AckRoundTripTracker(minimumWindowMs: 1_000)
    tracker.record(rttMs: 25, nowNs: 0)
    #expect(tracker.minimumMs == 25)

    tracker.expireMinimumCandidates(nowNs: 5_000 * ms)
    #expect(tracker.minimumMs == nil)
    #expect(tracker.inflationRatio == nil)
    // The smoothed value survives: it is the last thing we knew, not a claim about now.
    #expect(tracker.smoothedMs == 25)
}

@Test func firstSampleSeedsRatherThanSmoothsFromZero() {
    // Seeding from zero would make the first several windows read as a huge climb.
    var tracker = AckRoundTripTracker(minimumWindowMs: 30_000)
    tracker.record(rttMs: 80, nowNs: 0)
    #expect(tracker.smoothedMs == 80)
    #expect(tracker.variationMs == 40)
    #expect(tracker.inflationRatio == 1)
}

@Test func oneLuckyPacketDoesNotReadAsAQueue() {
    // The measured defect, and the reason the divisor is a percentile rather than the minimum.
    //
    // A Wi-Fi path resting near 20ms occasionally lands one frame in 6ms. Dividing by that
    // single sample reported an inflation past the 2.5 "bloated" threshold on a link with zero
    // loss and no queue -- and because that verdict calls `resetRecovery()`, which zeroes a
    // 30-second clean-time requirement, the resolution ladder could never leave its floor.
    var tracker = AckRoundTripTracker(minimumWindowMs: 30_000)
    var now: UInt64 = 0
    tracker.record(rttMs: 6, nowNs: now)
    now += 500 * ms
    for _ in 0..<40 {
        tracker.record(rttMs: 20, nowNs: now)
        now += 500 * ms
    }

    // The minimum still reports what it saw. It is simply no longer the divisor.
    #expect(tracker.minimumMs == 6)
    #expect(tracker.floorMs == 20)
    #expect((tracker.inflationRatio ?? 0) < 1.2)
    // What the old divisor would have claimed about this same calm link.
    #expect(20.0 / (tracker.minimumMs ?? 1) > 2.5)
}

@Test func aZeroPercentileReproducesTheOldMinimumFloor() {
    // The escape hatch documented on the config knob has to actually work, or "set it to 0 to
    // get the previous behaviour" is a claim nobody can fall back on.
    var tracker = AckRoundTripTracker(minimumWindowMs: 30_000, floorPercentile: 0)
    var now: UInt64 = 0
    tracker.record(rttMs: 6, nowNs: now)
    now += 500 * ms
    // Enough samples for the smoothed value to actually reach the resting level. With only a
    // handful it is still climbing out of its 6ms seed, and the ratio measures the seeding
    // rather than the floor -- which is what this assertion is about.
    for _ in 0..<40 {
        tracker.record(rttMs: 20, nowNs: now)
        now += 500 * ms
    }
    #expect(tracker.floorMs == 6)
    #expect(tracker.floorMs == tracker.minimumMs)
    #expect((tracker.inflationRatio ?? 0) > 2.5)
}

@Test func floorTracksTheLowestNotTheMostRecent() {
    // A dip followed by a rise must leave the dip inside the window rather than being
    // forgotten: `minimumMs` reports the distribution's bottom, not the latest sample.
    var tracker = AckRoundTripTracker(minimumWindowMs: 30_000)
    var now: UInt64 = 0
    for rtt in [100.0, 30.0, 250.0, 400.0] {
        tracker.record(rttMs: rtt, nowNs: now)
        now += 200 * ms
    }
    #expect(tracker.minimumMs == 30)
    #expect(tracker.sampleCount == 4)
    #expect(tracker.latestMs == 400)
}

@Test func rejectsNonFiniteAndNegativeSamples() {
    // A clock that goes backwards must not poison the floor at 0 and make every later
    // measurement look infinitely inflated.
    var tracker = AckRoundTripTracker(minimumWindowMs: 30_000)
    tracker.record(rttMs: 50, nowNs: 0)
    tracker.record(rttMs: -10, nowNs: ms)
    tracker.record(rttMs: .nan, nowNs: 2 * ms)
    tracker.record(rttMs: .infinity, nowNs: 3 * ms)
    #expect(tracker.sampleCount == 1)
    #expect(tracker.minimumMs == 50)
}

@Test func aZeroFloorDoesNotProduceAnInfiniteRatio() {
    // Loopback and same-host paths genuinely measure 0. Dividing by it would emit inf into
    // the log line and make the whole record unreadable.
    var tracker = AckRoundTripTracker(minimumWindowMs: 30_000)
    tracker.record(rttMs: 0, nowNs: 0)
    tracker.record(rttMs: 5, nowNs: ms)
    #expect(tracker.minimumMs == 0)
    #expect(tracker.inflationRatio == nil)
}
