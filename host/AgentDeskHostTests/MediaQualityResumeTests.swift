import Foundation
import Testing
import AgentDeskWire

@testable import AgentDeskHost

/// ADR-0090. The quality ladder lived entirely on the media transport, so a reconnect restarted
/// it at the ceiling. That looked like a wasted probe and was actually the thing that made the
/// cheap recovery path unreachable:
///
/// - the resume opens at full scale after suspending at a lower one,
/// - the first encode at the new scale recreates the compression session,
/// - every long-term reference lives inside that session and dies with it,
/// - so the refresh the resume asks for has nothing to reference and degrades to a keyframe --
///   on a link that has just come back, which is the worst possible moment for one.
///
/// Measured: a resume ran at `resolutionScale` 1.0 immediately after suspending at 0.5, and the
/// refresh returned a 185 KB IDR where a delta in the same session cost 2,221 bytes.
struct MediaQualityResumeTests {
    private func config() -> MediaQualityControllerConfig { .fromConfig() }

    private func makeState(resuming target: MediaQualityTarget? = nil) -> QuicSessionHostMediaState {
        var state = QuicSessionHostMediaState(
            qualityController: MediaQualityController(config: config())
        )
        if let target {
            state.resumeQualityTarget(target)
        }
        return state
    }

    private func capacity2Target() -> MediaQualityTarget {
        let config = config()
        return MediaQualityTarget(
            bitrateKbps: config.capacity2Kbps,
            fps: config.capacity2Fps,
            resolutionScale: config.resolutionScale,
            rung: .capacity2,
            reason: "test-pre-drop"
        )
    }

    /// A first connection has measured nothing, so the ceiling is the correct opening bid. This
    /// is the behaviour that must survive the change: carrying a rung is for resumes only.
    ///
    /// ADR-0100: "the ceiling" is now bitrate and fps only. Resolution has no ceiling to open at
    /// -- it is one value for the whole session -- so the assertion is that opening does not
    /// move it, which is what keeps a first connection from spending an IDR before it starts.
    @Test func aFirstConnectionStillOpensAtTheCeiling() {
        let state = makeState()
        #expect(state.targetResolutionScale == Config.ownedMediaResolutionScale)
        #expect(state.targetKbps == config().ceilingKbps)
        #expect(state.targetFps == config().fpsCeiling)
    }

    /// The regression. A resumed connection must open at the rung the previous one ended on, or
    /// its first frame is a rescale, and a rescale destroys the references the resume exists to
    /// reuse.
    @Test func aResumedConnectionOpensAtTheRungItLeftOff() {
        let target = capacity2Target()
        let state = makeState(resuming: target)
        #expect(state.targetResolutionScale == target.resolutionScale)
        #expect(state.targetKbps == target.bitrateKbps)
        #expect(state.targetFps == target.fps)
    }

    /// The specific property the encoder depends on, asserted on its own because it is the one
    /// that decides whether the compression session survives: same scale in means same scaled
    /// dimensions out, so `ensureSession` does not recreate and the long-term references live.
    @Test func aResumeDoesNotRescaleAndSoDoesNotRecreateTheEncoderSession() {
        let preDropScale = config().resolutionScale
        let state = makeState(resuming: capacity2Target())
        #expect(state.targetResolutionScale == preDropScale)
        #expect(state.targetResolutionScale != 1.0, "a resume that opens at native scale forces the rescale this exists to avoid")
    }

    /// Carried, not frozen. The link may genuinely have changed -- that is usually why the drop
    /// happened -- so the rung is an opening bid the ladder has to re-earn its way up from.
    /// Pinning clears the recovery credit rather than leaving it banked from before the drop.
    @Test func aCarriedRungIsAStartingPointNotAFreeze() {
        var controller = MediaQualityController(config: config())
        controller.pin(to: capacity2Target())
        let recovery = controller.currentRecoveryStatus
        #expect(recovery.cleanMs == 0, "recovery credit earned before the drop must not count toward climbing after it")
        #expect(recovery.stableTarget == capacity2Target())
        #expect(recovery.probeWindowsRemaining == 0)
    }
}
