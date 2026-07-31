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

@Test func floorTracksTheLowestNotTheMostRecent() {
    // Guards the monotonic-candidate stack: a dip followed by a rise must leave the dip as
    // the floor while it is still in window.
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
