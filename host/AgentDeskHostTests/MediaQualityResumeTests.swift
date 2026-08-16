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

    private func carriedTarget() -> MediaQualityTarget {
        MediaQualityTarget(
            bitrateKbps: 400,
            fps: 15,
            resolutionScale: config().resolutionScale,
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
        let target = carriedTarget()
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
        let state = makeState(resuming: carriedTarget())
        #expect(state.targetResolutionScale == preDropScale)
        #expect(state.targetResolutionScale != 1.0, "a resume that opens at native scale forces the rescale this exists to avoid")
    }

    /// The hole ADR-0090 left, and the one the daily driver actually fell into: only ladder
    /// decisions were reported as this session's target, so a manually-pinned session carried
    /// nothing. The next connection opened at the config default, the client's pin arrived a few
    /// dozen milliseconds later, and that resolution delta recreated the compression session --
    /// the exact rescale-in-the-path-of-a-resume this file exists to prevent, reached by a
    /// different route. Measured on device: 3,018 acknowledged references destroyed ~70ms after
    /// a resume that had correctly reused the encoder.
    ///
    /// The invariant is that re-applying the client's own config to a resumed session is a no-op
    /// on resolution. Anything else means the pin did not carry.
    @Test func aManualPinCarriesSoTheClientConfigDoesNotRescaleTheResumedSession() {
        let manual = ClientMediaQualityConfig(
            adaptiveEnabled: false,
            fixedTarget: ClientMediaQualityTarget(bitrateKbps: 8_000, fps: 60, resolutionScale: 0.25)
        )

        var pinned = makeState()
        let carried = pinned.applyClientMediaQuality(manual)?.target
        #expect(carried?.resolutionScale == 0.25, "the manual pin must produce a target to carry")
        guard let carried else { return }

        var resumed = makeState(resuming: carried)
        #expect(resumed.targetResolutionScale == carried.resolutionScale)

        let reapplied = resumed.applyClientMediaQuality(manual)
        #expect(
            reapplied?.resolutionChanged != true,
            "the client's own config re-arriving on a resumed session must not rescale it"
        )
        #expect(resumed.targetResolutionScale == carried.resolutionScale)
    }

    /// Carried, not frozen. The link may genuinely have changed -- that is usually why the drop
    /// happened -- so the carried target is an opening bid the controller has to re-earn its
    /// way up from. Pinning clears the recovery credit rather than leaving it banked from
    /// before the drop.
    @Test func aCarriedTargetIsAStartingPointNotAFreeze() {
        var controller = MediaQualityController(config: config())
        controller.pin(to: carriedTarget())
        let recovery = controller.currentRecoveryStatus
        #expect(recovery.cleanMs == 0, "recovery credit earned before the drop must not count toward climbing after it")
        #expect(controller.target == carriedTarget())
    }
}
