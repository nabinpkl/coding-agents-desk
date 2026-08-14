import Testing
@testable import AgentDeskHost

// ADR-0098: what the ladder is allowed to conclude from a window where the host produced frames
// and the link delivered none of them.
//
// This is the shape of the measured freeze, and before the delivery/production split it was the
// one window shape the controller could not act on: nothing acked, so nothing "resolved", so it
// fell into the zero-frame branch whose only outcomes are climb and hold, with every descent
// branch written after it. 25 windows of it in one 45-minute log, 6 of them carrying stale
// pressure that was reset on the way past.

private func config() -> MediaQualityControllerConfig { .fromConfig() }

/// A window the link resolved nothing in, parameterised by why.
private func window(
    completed: Int = 0,
    stale: Int = 0,
    inFlight: Int = 0,
    clientLinkStalled: Bool = false,
    clientReportMissing: Bool = false,
    production: MediaProductionSummary? = nil
) -> MediaQualityControllerInput {
    MediaQualityControllerInput(
        delivery: MediaDeliveryObservation(
            sample: MediaQualitySample(completedFrames: completed, expiredFrames: 0),
            ackCount: completed,
            inFlightFrames: inFlight,
            staleRecoveryCount: stale,
            clientReportMissing: clientReportMissing,
            clientLinkStalled: clientLinkStalled
        ),
        production: production
    )
}

/// The host meeting its cadence exactly, which is what it was doing all through the freeze:
/// `actualFps=6 targetFps=6 fpsDeficit=0`. Production is not evidence about the link.
private func healthyProduction() -> MediaProductionSummary {
    MediaProductionSummary(
        actualFps: 6,
        targetFps: 6,
        fpsDeficit: 0,
        frames: 6,
        keyframes: 0,
        sentKbps: 104,
        targetKbps: 300,
        maxGapMs: 175,
        resolutionScale: 0.33,
        windowMs: 1_000
    )
}

// The headline claim. The host produced six frames on cadence, the client received none, and the
// rung comes down -- where it previously logged `reason=idle` and held.
@Test func aStalledLinkDescendsEvenThoughTheHostProducedPerfectly() {
    var controller = MediaQualityController(config: config())
    let outcome = controller.observe(
        window(inFlight: 6, clientLinkStalled: true, production: healthyProduction())
    ).outcome
    #expect(outcome.reason == "delivery-stalled-down")
    #expect(outcome.changed)
    #expect(outcome.target.rung == .capacity1)
}

// No streak gate, unlike stale and cadence pressure. A stalled link is not the one-window noise
// R231b measured; waiting for a second window is waiting through a freeze the user can see.
@Test func aStalledLinkDoesNotWaitForASecondWindow() {
    var controller = MediaQualityController(config: config())
    let first = controller.observe(window(clientLinkStalled: true)).outcome
    #expect(first.changed)
}

// It keeps descending while the link stays stalled, and stops at the floor rather than churning.
@Test func aPersistentStallWalksToTheFloorAndStays() {
    var controller = MediaQualityController(config: config())
    var reasons: [String] = []
    for _ in 0..<8 {
        reasons.append(controller.observe(window(clientLinkStalled: true)).outcome.reason)
    }
    #expect(controller.target.rung == .emergency)
    #expect(reasons.last == "at-emergency-floor")
}

// The regression the new branch could most easily cause: a quiet Mac read as a stalled link. If
// that ever happened the ladder would walk itself to the floor with nobody at the keyboard --
// the exact failure ADR-0087 and ADR-0088 spent two rounds getting right.
@Test func aCalmScreenIsNeverMistakenForAStall() {
    var controller = MediaQualityController(config: config())
    controller.pin(to: MediaQualityTarget(
        bitrateKbps: 300, fps: 6, resolutionScale: 0.33, rung: .emergency, reason: "test"
    ))
    for _ in 0..<20 {
        let outcome = controller.observe(window()).outcome
        #expect(outcome.reason != "delivery-stalled-down")
        #expect(outcome.target.rung == .emergency)
    }
}

// And the other half: a calm screen still earns its way back up. Pinned below the rung's own
// canonical bitrate, which is where a loss downshift leaves it, so the climb is the bitrate axis
// -- the one that moves in seconds rather than waiting out the 30s resolution dwell.
@Test func aCalmScreenStillEarnsItsClimb() {
    var controller = MediaQualityController(config: config())
    controller.pin(to: MediaQualityTarget(
        bitrateKbps: config().emergencyKbps / 2,
        fps: config().emergencyFps,
        resolutionScale: config().emergencyScale,
        rung: .emergency,
        reason: "test"
    ))
    for _ in 0..<config().raiseCleanWindows {
        _ = controller.observe(window())
    }
    #expect(controller.target.bitrateKbps > config().emergencyKbps / 2)
}

// A client that has gone quiet is not evidence of failure, only absence of evidence. It must
// block the climb without driving a descent, or a slow reporter walks the ladder to the floor.
@Test func aSilentClientBlocksTheClimbWithoutDescending() {
    var controller = MediaQualityController(config: config())
    controller.pin(to: MediaQualityTarget(
        bitrateKbps: 300, fps: 6, resolutionScale: 0.33, rung: .emergency, reason: "test"
    ))
    for _ in 0..<8 {
        let outcome = controller.observe(window(clientReportMissing: true)).outcome
        #expect(outcome.reason == "idle")
        #expect(!outcome.changed)
    }
    #expect(controller.target.rung == .emergency)
}

// Stale pressure is judged before the frame count. The premise the old order rested on -- that a
// window with no frames cannot have produced a stale one -- is false: `staleRecoveryCount` is
// incremented at PRODUCE time by `abandonUntilCanProduce`, with no reference to acks at all.
@Test func aWindowThatAbandonedFramesIsNotIdle() {
    var controller = MediaQualityController(config: config())
    let outcome = controller.observe(window(stale: 5)).outcome
    #expect(outcome.reason == "stale-hold")
}

// And the consequence that mattered. These two windows acked nothing, so under the old order
// both were classified idle and each one reset the streak on the way past -- which is why 12
// stale windows produced exactly one `stale-capacity-down` in 45 minutes. Judged before the
// frame count, they are consecutive and the second one answers.
@Test func staleWindowsThatAckedNothingStillAccumulate() {
    var controller = MediaQualityController(config: config())
    let first = controller.observe(window(completed: 0, stale: 5)).outcome
    #expect(first.reason == "stale-hold")
    let second = controller.observe(window(completed: 0, stale: 5)).outcome
    #expect(second.reason == "stale-capacity-down")
    #expect(second.changed)
}

// R231b's rule survives the reorder, and is now relied on rather than bypassed: a genuinely
// clean window breaks the run, so two stale windows minutes apart are not sustained pressure.
// Measured at 47 of 51 stale bursts lasting exactly one window.
@Test func aCleanWindowBetweenStaleOnesStillBreaksTheRun() {
    var controller = MediaQualityController(config: config())
    _ = controller.observe(window(completed: 10, stale: 1))
    _ = controller.observe(window(completed: 10))
    let outcome = controller.observe(window(completed: 10, stale: 1)).outcome
    #expect(outcome.reason == "stale-hold")
    #expect(!outcome.changed)
}

// The climb reports where it actually is. `at-native` was emitted 27 times from the EMERGENCY
// floor in one log, which reads as full quality at the opposite end of the ladder.
@Test func aRungAtItsOwnCeilingDoesNotClaimToBeAtNative() {
    var controller = MediaQualityController(config: config())
    controller.pin(to: MediaQualityTarget(
        bitrateKbps: config().emergencyKbps,
        fps: config().emergencyFps,
        resolutionScale: config().emergencyScale,
        rung: .emergency,
        reason: "test"
    ))
    var reasons: Set<String> = []
    for _ in 0..<12 {
        reasons.insert(controller.observe(window()).outcome.reason)
    }
    #expect(!reasons.contains("at-native"))
}
