import Foundation
import Testing
import AgentDeskWire

@testable import AgentDeskHost

/// The two fps ceilings are different numbers on purpose, and this pins the difference.
///
/// `expectedFrameRate` is what the PIPELINE can do: ScreenCaptureKit is configured at
/// `minimumFrameInterval = 1/60`, so 60. `fpsCeiling` is what the ADAPTIVE controller is
/// allowed to derive, which stays at 30 because doubling the frame count on a link that is
/// already descending is the opposite of what the descent is for.
///
/// Collapsing them (the prior shape, both 30) had a second, quieter cost: the cadence gate
/// treats `targetFps >= expectedFrameRate` as "no gate at all", so a manual pin of 30 ran
/// ungated at whatever capture produced -- measured on device at 54-56fps against a stated
/// target of 30. The slider did not mean what it said, and nothing in the logs said so.
struct MediaManualCadenceCeilingTests {
    @Test func manualPinReachesTheCaptureCeilingNotTheAdaptiveOne() {
        var state = makeState()

        pin(&state, fps: 60)

        // 60 is above the adaptive controller's own ceiling. A human asking by hand is a
        // different act from the controller deriving it, so only the capability bounds it.
        #expect(state.targetFps == 60)
    }

    @Test func manualPinClampsToTheCaptureCeiling() {
        var state = makeState()

        pin(&state, fps: 240)

        #expect(state.targetFps == captureCeiling)
    }

    @Test func adaptiveCadenceStaysAtThePolicyCeiling() {
        let state = makeState()

        // Untouched by any manual pin, the adaptive path starts at ITS ceiling, which must be
        // the policy number and not the capability one.
        #expect(state.targetFps == adaptiveCeiling)
        #expect(adaptiveCeiling < captureCeiling)
    }

    @Test func cadenceGateHoldsBelowTheCaptureCeiling() throws {
        var state = makeState()
        pin(&state, fps: 30)

        try send(&state, at: 0)
        // 30fps is a 33ms interval, so a frame offered 1ms later has to wait. Before the split
        // this refusal never happened at 30: the gate saw 30 >= 30 and disabled itself.
        guard case .retry = state.reserveUpdateId(nowNs: 1_000_000) else {
            Issue.record("cadence gate admitted a frame 1ms into a 33ms interval")
            return
        }
    }

    @Test func cadenceGateStandsDownAtTheCaptureCeiling() throws {
        var state = makeState()
        pin(&state, fps: captureCeiling)

        try send(&state, at: 0)
        // At the capability bound there is nothing left to pace against: capture itself is the
        // limit, so the gate yields rather than adding a second, redundant one.
        guard case .ready = state.reserveUpdateId(nowNs: 1_000_000) else {
            Issue.record("cadence gate paced a frame at the capture ceiling")
            return
        }
    }

    // MARK: - Helpers

    private var captureCeiling: Int { 60 }
    private var adaptiveCeiling: Int { 30 }

    private func pin(_ state: inout QuicSessionHostMediaState, fps: Int) {
        _ = state.applyClientMediaQuality(
            ClientMediaQualityConfig(
                adaptiveEnabled: false,
                fixedTarget: ClientMediaQualityTarget(
                    bitrateKbps: 2_000,
                    fps: fps,
                    resolutionScale: 0.5
                )
            )
        )
    }

    private func send(_ state: inout QuicSessionHostMediaState, at nowNs: UInt64) throws {
        guard case .ready(let updateId, _) = state.reserveUpdateId(nowNs: nowNs) else {
            throw CeilingTestError.admissionRefused
        }
        state.noteSent(
            frameId: updateId.frameId,
            encodedBytes: 1_000,
            packets: [Data([0])],
            sentAtUptimeNs: nowNs
        )
    }

    private enum CeilingTestError: Error {
        case admissionRefused
    }

    private func makeState() -> QuicSessionHostMediaState {
        QuicSessionHostMediaState(
            // Generous in-flight room so a refusal can only be the cadence gate.
            maxInflightFrames: 16,
            maxInflightBytes: 1_000_000,
            expectedFrameRate: captureCeiling,
            qualityController: MediaQualityController(config: controllerConfig()),
            resendRingFrames: 4,
            stallRecoveryMinIntervalMs: 5_000
        )
    }

    private func controllerConfig() -> MediaQualityControllerConfig {
        MediaQualityControllerConfig(
            ceilingKbps: 2_500,
            floorKbps: 60,
            downStep: 0.7,
            upStep: 1.15,
            lossDownPermille: 50,
            raiseCleanWindows: 4,
            cadenceDownWindows: 2,
            fpsCeiling: adaptiveCeiling,
            ackHoldP95Ms: 180,
            ackDownP95Ms: 350,
            cadenceGapMs: 500,
            freezeGapMs: 1_000,
            freezeFpsCeiling: 3,
            resolutionScale: 0.5,
            seedFrameBytes: 10_000,
            frameBytesHeadroom: 1.3,
            deliverySnapRatio: 0.85
        )
    }
}
