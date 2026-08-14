import Foundation
import Testing
import AgentDeskWire

@testable import AgentDeskHost

/// R231b. The stale signal is `staleRecoveryCount > 0` -- one abandoned frame, no magnitude --
/// and it was answered by jumping straight to a fixed rung, skipping the proportional bitrate
/// phase that the loss signal goes through. That asymmetry made the ladder a probe-to-failure
/// oscillator: climb bitrate geometrically, trip over a single frame, collapse several rungs,
/// climb again. The host log recorded the cycle at roughly 26 seconds, indefinitely.
///
/// Measured over a 25 minute run: stale pressure fired in 59 of 2,664 windows, in 51 bursts of
/// which 47 (92%) lasted exactly ONE window. Requiring two consecutive windows would have fired
/// 4 times instead of 51, a far stronger filter than any magnitude test -- >=2 stale frames
/// still leaves 42% of firings and a 250-permille rate leaves 39%, because the median firing
/// window produced only 7 frames and 58% of firings were a single stale frame, so a rate
/// threshold mostly measures how much the screen happened to be changing.
struct MediaQualityStalePressureTests {
    private func config() -> MediaQualityControllerConfig { .fromConfig() }

    private func window(
        completed: Int = 10,
        stale: Int = 0,
        windowMs: Int = 1_000
    ) -> MediaQualityControllerInput {
        MediaQualityControllerInput(
            delivery: MediaDeliveryObservation(
                sample: MediaQualitySample(completedFrames: completed, expiredFrames: 0),
                ackCount: completed,
                staleRecoveryCount: stale
            ),
            production: MediaProductionSummary(
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
            )
        )
    }

    /// The measured case: a lone stale window. Forty-seven of fifty-one bursts looked exactly
    /// like this, and each one used to cost a multi-rung collapse.
    @Test func aSingleStaleWindowHoldsInsteadOfCollapsingTheLadder() {
        var controller = MediaQualityController(config: config())
        let outcome = controller.observe(window(stale: 1)).outcome
        #expect(outcome.reason == "stale-hold")
        #expect(!outcome.changed)
        #expect(outcome.target.rung == .native)
    }

    /// Held, not ignored. Sustained pressure is still answered, one window later.
    @Test func twoConsecutiveStaleWindowsDownshift() {
        var controller = MediaQualityController(config: config())
        _ = controller.observe(window(stale: 1))
        let outcome = controller.observe(window(stale: 1)).outcome
        #expect(outcome.reason == "stale-capacity-down")
        #expect(outcome.target.rung == .capacity1)
        #expect(outcome.bitrateChanged)
    }

    /// The property that does the work. A clean window between two stale ones means they were
    /// two unrelated blips, not a link under sustained stress, so the run restarts.
    @Test func aCleanWindowBetweenStaleWindowsBreaksTheRun() {
        var controller = MediaQualityController(config: config())
        _ = controller.observe(window(stale: 1))
        _ = controller.observe(window())
        let outcome = controller.observe(window(stale: 1)).outcome
        #expect(outcome.reason == "stale-hold", "a broken run must start counting again")
        #expect(outcome.target.rung == .native)
    }

    /// A window with no frames at all cannot have produced a stale one, so it breaks the run
    /// too. Without this an idle stretch would be invisible to the streak and could pair up two
    /// blips separated by a silent gap.
    @Test func anIdleWindowAlsoBreaksTheRun() {
        var controller = MediaQualityController(config: config())
        _ = controller.observe(window(stale: 1))
        _ = controller.observe(window(completed: 0))
        let outcome = controller.observe(window(stale: 1)).outcome
        #expect(outcome.reason == "stale-hold")
    }

    /// The streak must not be reset by the branch that owns it. `resetPressureStreaks()` is
    /// called on the way into the stale branch to clear the cadence streak, and folding the
    /// stale counter into it would have the signal wipe the counter it is accumulating -- the
    /// bug this test exists to prevent regressing.
    @Test func theStaleStreakSurvivesItsOwnBranchesResetOfTheCadenceStreak() {
        var controller = MediaQualityController(config: config())
        for _ in 0..<(config().staleDownWindows - 1) {
            #expect(controller.observe(window(stale: 1)).outcome.reason == "stale-hold")
        }
        #expect(controller.observe(window(stale: 1)).outcome.reason == "stale-capacity-down")
    }
}
