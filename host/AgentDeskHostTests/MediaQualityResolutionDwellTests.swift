import Foundation
import Testing
import AgentDeskWire

@testable import AgentDeskHost

/// R231. The quality ladder is one ordinal emitting three coupled values, but the three are
/// not the same kind of instruction. Bitrate and fps are live properties of the compression
/// session and cost nothing to change. Resolution is fixed at session creation, so changing it
/// recreates the session, emits an IDR, and destroys every long-term reference inside it.
///
/// Measured on the handover run: `scale=0.75` keyframe 86,644B, `scale=0.50` 68,598B, back to
/// `scale=0.75` 122,041B, all inside seventeen seconds, on cellular. The host log shows the
/// shape it came from -- a limit cycle roughly 26s long, where the ladder climbs bitrate until
/// one frame goes stale, collapses to a fixed rung, and climbs again. Every collapse spent a
/// keyframe on an excursion that reversed within ten seconds.
///
/// So resolution is gated: the rung's scale is a request, and it has to persist to be granted.
struct MediaQualityResolutionDwellTests {
    private func config() -> MediaQualityControllerConfig { .fromConfig() }

    /// One window of the shape the ladder actually sees. `windowMs` is what the dwell accrues,
    /// so it is the knob these tests turn to advance time.
    private func window(
        completed: Int = 10,
        expired: Int = 0,
        stale: Int = 0,
        windowMs: Int = 1_000
    ) -> MediaQualityControllerInput {
        MediaQualityControllerInput(
            sample: MediaQualitySample(completedFrames: completed, expiredFrames: expired),
            productionSummary: MediaProductionSummary(
                actualFps: 30,
                targetFps: 30,
                fpsDeficit: 0,
                frames: completed,
                keyframes: 0,
                sentKbps: 1_000,
                targetKbps: 1_000,
                maxGapMs: 0,
                resolutionScale: 1.0,
                windowMs: windowMs
            ),
            ackCount: completed,
            staleRecoveryCount: stale
        )
    }

    /// The core split. A stale window drops the rung, and the two free axes must go with it
    /// immediately: this is the congestion response, and gating it would be the bug.
    @Test func congestionMovesBitrateAndFpsOnTheWindowThatAskedForIt() {
        var controller = MediaQualityController(config: config())
        // R231b: the downshift needs two consecutive stale windows to fire at all. This suite is
        // about what happens once it does, so drive it to that point first.
        _ = controller.observe(window(stale: 1))
        let outcome = controller.observe(window(stale: 1)).outcome
        #expect(outcome.target.rung == .capacity1)
        #expect(outcome.target.bitrateKbps == config().capacity1Kbps)
        #expect(outcome.target.fps == config().capacity1Fps)
        #expect(outcome.bitrateChanged)
        #expect(outcome.fpsChanged)
    }

    /// The same window must NOT move resolution, because that one costs a keyframe and the
    /// whole reference set, and one stale frame is not yet evidence the link changed.
    @Test func theSameWindowDoesNotMoveResolution() {
        var controller = MediaQualityController(config: config())
        _ = controller.observe(window(stale: 1))
        let outcome = controller.observe(window(stale: 1)).outcome
        #expect(outcome.target.resolutionScale == 1.0)
        #expect(!outcome.resolutionChanged)
    }

    /// The measured failure, as a test. An excursion that reverses inside the dwell must
    /// commit nothing: this is the 0.75 -> 0.50 -> 0.75 in seventeen seconds that cost three
    /// keyframes, and it should now cost zero.
    @Test func anExcursionThatReversesInsideTheDwellCostsNoKeyframe() {
        var controller = MediaQualityController(config: config())
        var sawResolutionChange = false
        // One stale window drops the rung, then the link is fine again. This is the measured
        // shape, taken from the host log: at 00:30:01 the ladder fell to rung 2, and by
        // 00:30:09 it had climbed back -- eight seconds, inside the ten second dwell. The
        // ladder is meant to keep doing this; what it must stop doing is paying a keyframe
        // each way.
        sawResolutionChange = sawResolutionChange || controller.observe(window(stale: 1)).outcome.resolutionChanged
        let outcome = controller.observe(window(stale: 1)).outcome
        sawResolutionChange = sawResolutionChange || outcome.resolutionChanged
        #expect(outcome.target.rung == .capacity1)
        for _ in 0..<8 {
            let clean = controller.observe(window()).outcome
            sawResolutionChange = sawResolutionChange || clean.resolutionChanged
        }
        #expect(!sawResolutionChange, "a rung excursion shorter than the dwell must not reach the encoder")
        #expect(controller.targetResolutionScale == 1.0)
    }

    /// Carried, not frozen: the dwell delays the resolution response, it does not withhold it.
    ///
    /// This also pins the bug the first draft of the gate had, because it is precisely the
    /// failure a dwell must not introduce. A collapsing link produces repeated stale windows,
    /// and each one walks the rung down another step, so the REQUESTED scale keeps changing:
    /// 0.75, then 0.50, then 0.33. A gate keyed on the requested value restarts its clock on
    /// every one of those and never commits, which would leave a genuinely dead link pinned at
    /// full resolution forever. Keyed on direction, the steps accumulate, because they are all
    /// the same evidence pointing the same way.
    @Test func aLinkThatKeepsDegradingStillEarnsItsRescale() {
        var controller = MediaQualityController(config: config())
        let windows = (config().resolutionDownDwellMs / 1_000) + 2
        var lastRung: MediaQualityRung = .native
        for _ in 0..<windows {
            lastRung = controller.observe(window(stale: 1)).outcome.target.rung
        }
        #expect(lastRung.rawValue > MediaQualityRung.capacity1.rawValue, "repeated stale windows walk the rung down past its first step")
        #expect(controller.targetResolutionScale < 1.0, "a link that keeps degrading must still get its rescale")
    }

    /// The shape the host log actually recorded, which is not a run of consecutive stale
    /// windows. Stale pressure fired in only 59 of 2,664 windows across 25 minutes, in bursts
    /// that were 92% of the time a single window, with clean windows in between. What holds
    /// during those gaps is the RUNG -- the ladder stays down even on a window that reports
    /// nothing new -- so the dwell has to measure how long the rung has been low, not how many
    /// windows in a row actively pushed it lower. Reading the request from the already-gated
    /// target instead of the rung made this unreachable, and a link that stayed bad would never
    /// have rescaled.
    @Test func aRungThatStaysDownAccruesAcrossQuietWindowsToo() {
        var controller = MediaQualityController(config: config())
        _ = controller.observe(window(stale: 1))
        _ = controller.observe(window(stale: 1))
        #expect(controller.targetResolutionScale == 1.0, "the drop is not immediate")
        // No further stale windows: nothing new is reported, the rung simply has not climbed
        // back yet. That is still the link being worse, and it must count.
        for _ in 0..<((config().resolutionDownDwellMs / 1_000) + 2) {
            _ = controller.observe(window(completed: 1))
        }
        #expect(controller.targetResolutionScale < 1.0, "a rung that stays low must eventually be believed")
    }

    // The gate is deliberately one-directional: the climb back passes through untouched,
    // because `recover()` already raises resolution through a probe phase with a clean-streak
    // requirement, a warmup and a rollback. A second dwell stacked on top models the same
    // thing twice, and the first version of this gate broke the probe outright by clamping it.
    // That path is covered by `testMediaQualityControllerRecoversBitrateThenProbesResolutionThenFps`,
    // which walks the full bitrate-then-resolution-then-fps recovery; a synthetic test here
    // would only restate it less well. If the up-move is still too eager -- and the 122,041B
    // frame says it is -- the lever is that probe's threshold, not another clock.

    /// A resume pins the rung it left off on (ADR-0090), and the encoder is about to run at
    /// exactly that scale. Adopting it as committed is what stops the resume reading as
    /// pressure and spending a keyframe undoing itself.
    @Test func aPinnedResumeAdoptsItsScaleRatherThanGatingAgainstIt() {
        var controller = MediaQualityController(config: config())
        let resumed = MediaQualityTarget(
            bitrateKbps: config().capacity2Kbps,
            fps: config().capacity2Fps,
            resolutionScale: config().capacity2Scale,
            rung: .capacity2,
            reason: "test-resume"
        )
        controller.pin(to: resumed)
        #expect(controller.targetResolutionScale == config().capacity2Scale)
        // And it stays there: a clean window after the pin must not be read as up-pressure
        // that has already been accruing.
        let outcome = controller.observe(window()).outcome
        #expect(outcome.target.resolutionScale == config().capacity2Scale)
        #expect(!outcome.resolutionChanged)
    }
}
