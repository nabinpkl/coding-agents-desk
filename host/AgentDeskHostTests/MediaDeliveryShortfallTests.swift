import Testing
@testable import AgentDeskHost

// ADR-0098: descending on the measured shortfall itself rather than on a symptom of it.
//
// Every other descent branch reads an effect -- acks aging, frames expiring, the client
// reporting a dead path -- and each lags, because it needs the queue to have grown enough to
// show. This one compares what the link carried against what the rung asked for.
//
// The failure mode being guarded against here is not missing a real shortfall. It is inventing
// one: a controller that descends whenever it sees less than it asked for will walk a healthy
// link to the floor, because a calm screen and a mid-descent window both look short.

private func config() -> MediaQualityControllerConfig { .fromConfig() }

private func bytesPerSecond(kbps: Double) -> Double { kbps * 1_000.0 / 8.0 }

/// A window that resolved frames normally, carrying a measured delivery rate.
private func window(
    deliveredKbps: Double?,
    inflation: Double? = nil,
    completed: Int = 6,
    // Bloat needs an absolute delay as well as a ratio, so these windows carry one. 1200ms
    // matches what the bloat tests below already describe in prose -- a picture SECONDS behind
    // the Mac -- rather than being a number picked to make the assertion pass.
    smoothedMs: Double? = 1_200
) -> MediaQualityControllerInput {
    MediaQualityControllerInput(
        delivery: MediaDeliveryObservation(
            sample: MediaQualitySample(completedFrames: completed, expiredFrames: 0),
            ackCount: completed,
            ackAgeMaxMs: 40,
            deliveredBytesPerSecond: deliveredKbps.map { bytesPerSecond(kbps: $0) },
            roundTripInflationRatio: inflation,
            roundTripSmoothedMs: smoothedMs
        ),
        production: MediaProductionSummary(
            actualFps: 30,
            targetFps: 30,
            fpsDeficit: 0,
            frames: 30,
            keyframes: 0,
            sentKbps: 2_400,
            targetKbps: 2_500,
            maxGapMs: 40,
            resolutionScale: 1.0,
            windowMs: 1_000
        )
    )
}

// The headline claim. The ladder is asking the link for 2500kbps and the link is carrying 300.
// Nothing has expired, nothing is stale, the acks are quick -- none of the existing signals has
// anything to say, and the rung still comes down.
@Test func aLinkCarryingAFractionOfTheRungDescends() {
    var controller = MediaQualityController(config: config())
    let first = controller.observe(window(deliveredKbps: 300)).outcome
    #expect(!first.changed)
    #expect(first.reason == "delivery-shortfall-hold")

    let second = controller.observe(window(deliveredKbps: 300)).outcome
    #expect(second.reason == "delivery-shortfall-down")
    #expect(second.target.rung == .capacity1)
}

// One short window is a burst, two is a link. Same rule as stale and cadence pressure, and the
// same reason: reacting to every single window is what turns a ladder into an oscillator.
@Test func oneShortWindowIsNotEnough() {
    var controller = MediaQualityController(config: config())
    let first = controller.observe(window(deliveredKbps: 300)).outcome
    #expect(!first.changed)
}

// A window that measures fine breaks the run, so two short windows minutes apart never combine.
@Test func aHealthyWindowBetweenShortOnesBreaksTheRun() {
    var controller = MediaQualityController(config: config())
    _ = controller.observe(window(deliveredKbps: 300))
    _ = controller.observe(window(deliveredKbps: 2_400))
    let third = controller.observe(window(deliveredKbps: 300)).outcome
    #expect(!third.changed)
}

// Unknown is not shortfall. No backlogged slice has completed, which is the state of every
// connection at its start and of any calm screen; descending on it punishes a link for being
// asked to carry nothing.
@Test func anUnmeasuredLinkIsNeverJudgedShort() {
    var controller = MediaQualityController(config: config())
    for _ in 0..<8 {
        let outcome = controller.observe(window(deliveredKbps: nil)).outcome
        #expect(outcome.reason != "delivery-shortfall-down")
        #expect(outcome.reason != "delivery-shortfall-hold")
    }
    #expect(controller.target.rung == .native)
}

// A link delivering slightly under its rung is a link doing its job. The encoder undershoots its
// own average constantly, so the measured rate reads a little short on a perfectly good path,
// and a threshold set too close to 1.0 would descend on that noise forever.
@Test func aLinkDeliveringMostOfTheRungIsLeftAlone() {
    var controller = MediaQualityController(config: config())
    let justUnder = Double(config().ceilingKbps) * (config().deliveryShortfallRatio + 0.1)
    for _ in 0..<10 {
        _ = controller.observe(window(deliveredKbps: justUnder))
    }
    #expect(controller.target.rung == .native)
}

// The runaway guard, and the reason the estimate is a windowed maximum. After a descent the
// window still holds the capacity measured before it, so the next window compares the new,
// smaller ask against the old, larger measurement -- and the streak breaks. One step per genuine
// stretch of shortfall, not one per window.
@Test func aDescentDoesNotCascadeWhileTheMeasurementStands() {
    var controller = MediaQualityController(config: config())
    _ = controller.observe(window(deliveredKbps: 300))
    let stepped = controller.observe(window(deliveredKbps: 300)).outcome
    #expect(stepped.target.rung == .capacity1)

    // The same 300kbps measurement, now compared against capacity1 rather than the ceiling.
    let after = controller.observe(window(deliveredKbps: 300)).outcome
    #expect(after.reason != "delivery-shortfall-down")
    #expect(controller.target.rung == .capacity1)
}

// A descent spends the evidence whichever signal triggered it. Without this a single stale-down
// and a single short window would combine into a second step the link never asked for.
@Test func aDescentFromAnotherSignalClearsTheShortfallRun() {
    var controller = MediaQualityController(config: config())
    _ = controller.observe(window(deliveredKbps: 300))

    var stalled = window(deliveredKbps: 300)
    stalled = MediaQualityControllerInput(
        delivery: MediaDeliveryObservation(
            sample: stalled.delivery.sample,
            ackCount: 0,
            clientLinkStalled: true,
            deliveredBytesPerSecond: stalled.delivery.deliveredBytesPerSecond
        ),
        production: stalled.production
    )
    let byStall = controller.observe(stalled).outcome
    #expect(byStall.reason == "delivery-stalled-down")
    #expect(byStall.target.rung == .capacity1)

    let next = controller.observe(window(deliveredKbps: 300)).outcome
    #expect(next.reason != "delivery-shortfall-down")
}

// --- the delay half ---

// The failure goodput cannot see. Every byte arrives, at the full rate we asked for, and the
// round-trip sits five times its own floor -- the reading taken through the measured freeze while
// the ladder held. Throughput is healthy, nothing expires, nothing goes stale, and the picture on
// the phone is seconds behind the Mac.
@Test func aBloatedQueueDescendsOnAFullyDeliveringLink() {
    var controller = MediaQualityController(config: config())
    let plenty = Double(config().ceilingKbps)
    let first = controller.observe(window(deliveredKbps: plenty, inflation: 5.0)).outcome
    #expect(first.reason == "queue-bloat-hold")

    let second = controller.observe(window(deliveredKbps: plenty, inflation: 5.0)).outcome
    #expect(second.reason == "queue-bloat-down")
    #expect(second.target.rung == .capacity1)
}

// A path with ordinary latency is not a bloated one. The ratio is the round-trip against its own
// floor, so a slow link with a stable queue reads near 1.0 exactly like a fast one -- which is
// the property that lets this run on cellular at all.
@Test func anOrdinaryPathIsNotMistakenForABloatedOne() {
    var controller = MediaQualityController(config: config())
    let plenty = Double(config().ceilingKbps)
    for _ in 0..<10 {
        _ = controller.observe(window(deliveredKbps: plenty, inflation: 1.3))
    }
    #expect(controller.target.rung == .native)
}

// The measured defect. Wi-Fi is fast and jittery: its floor is a lucky aggregated frame and its
// smoothed value includes retries, so it sits 3-4x its own floor permanently. Over one session
// that crossed the 2.5 ratio in 75% of windows at 46.9ms smoothed -- 47 thousandths of a second
// behind, which nobody can see -- while cellular at 158.7ms crossed it in 17%. The detector was
// calling the four-times-faster path the queued one, and each verdict zeroed a thirty-second
// climb requirement, so the ladder never left its emergency floor.
@Test func aFastButJitteryPathIsNotQueued() {
    var controller = MediaQualityController(config: config())
    let plenty = Double(config().ceilingKbps)
    for _ in 0..<10 {
        let outcome = controller.observe(
            window(deliveredKbps: plenty, inflation: 3.7, smoothedMs: 46.9)
        ).outcome
        #expect(outcome.reason != "queue-bloat-down")
        #expect(outcome.reason != "queue-bloat-hold")
    }
    #expect(controller.target.rung == .native)
}

// The other direction, so the gate cannot be satisfied by lateness alone. A path that is simply
// far away sits at a steady high round-trip with no inflation, and sending it less recovers not
// one millisecond of that distance.
@Test func aDistantButSteadyPathIsNotQueued() {
    var controller = MediaQualityController(config: config())
    let plenty = Double(config().ceilingKbps)
    for _ in 0..<10 {
        let outcome = controller.observe(
            window(deliveredKbps: plenty, inflation: 1.2, smoothedMs: 800)
        ).outcome
        #expect(outcome.reason != "queue-bloat-down")
    }
    #expect(controller.target.rung == .native)
}

// No ratio yet means no floor to divide by -- the start of every connection. Unknown is not
// bloat, the same asymmetry the shortfall trigger is built on.
@Test func anUnmeasuredRoundTripIsNeverJudgedBloated() {
    var controller = MediaQualityController(config: config())
    let plenty = Double(config().ceilingKbps)
    for _ in 0..<10 {
        let outcome = controller.observe(window(deliveredKbps: plenty, inflation: nil)).outcome
        #expect(outcome.reason != "queue-bloat-down")
    }
    #expect(controller.target.rung == .native)
}

// The two signals count separately. One short window and one bloated window are two different
// complaints about two different failures, and neither is two windows of anything.
@Test func shortfallAndBloatDoNotSpendEachOthersEvidence() {
    var controller = MediaQualityController(config: config())
    let plenty = Double(config().ceilingKbps)
    _ = controller.observe(window(deliveredKbps: 300, inflation: 1.1))
    let mixed = controller.observe(window(deliveredKbps: plenty, inflation: 5.0)).outcome
    #expect(mixed.reason == "queue-bloat-hold")
    #expect(!mixed.changed)
}
