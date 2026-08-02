import Foundation
import Testing
import AgentDeskWire

@testable import AgentDeskHost

/// ADR-0087. These pin the three ways a stalled link used to go unhandled on a manually
/// pinned stream, each of which was measured on device before it was fixed:
///
/// - the host could not SEE the stall (four of six pressure classes were hardcoded false
///   in the manual branch, so a 12.79s freeze logged `queuePressure=false`),
/// - it could not RESPOND to one (the flush and the recovery keyframe were reachable only
///   as a side effect of a rung change, which a pinned target never makes),
/// - and it was not LOOKING during one (windows are raised by inbound client reports, so a
///   silent client also silenced the evaluation that would have noticed).
struct MediaStallRecoveryTests {
    // MARK: - Seeing the stall

    @Test func manualPinDerivesRealSignalsWithoutMovingTheTarget() {
        var state = makeState()
        pinManual(&state)

        // Loss and slow ACKs together: both classes the manual branch used to report as
        // false unconditionally.
        let decision = state.observeLinkHealth(
            completedFrames: 80,
            expiredFrames: 20,
            productionSummary: nil,
            nowNs: 0
        )

        #expect(decision.observation.signals.lossPressure)
        #expect(decision.observation.signals.lossPermille == 200)
        // The whole point of a manual pin: honest diagnostics, unmoved target.
        #expect(!decision.outcome.changed)
        #expect(decision.outcome.reason == "manual-quality-fixed")
        #expect(state.targetKbps == 900)
        #expect(state.targetFps == 10)
    }

    @Test func manualPinReportsQueuePressureFromAckAge() throws {
        var state = makeState(maxInflightFrames: 4)
        pinManual(&state)
        // One frame acked slowly: p95 lands above the 350ms downshift threshold.
        try sendFrame(&state, at: 0, bytes: 1_200)
        state.noteAck(frameId: 1, nowNs: 600_000_000)

        let decision = state.observeLinkHealth(
            completedFrames: 1,
            expiredFrames: 0,
            productionSummary: nil,
            nowNs: 600_000_000
        )

        #expect(decision.observation.signals.queuePressure)
        #expect(!decision.outcome.changed)
    }

    // MARK: - Responding to the stall

    @Test func manualPinFlushesJammedInFlightAndForcesOneKeyframe() throws {
        var state = makeState(maxInflightFrames: 2)
        pinManual(&state)
        // Fill the cap and never ACK: the shape of a client that went silent. It reports
        // no loss and no expiry, so only the in-flight list says anything is wrong.
        try sendFrame(&state, at: 0, bytes: 1_000)
        try sendFrame(&state, at: 100_000_000, bytes: 1_000)
        #expect(state.inFlightFrames == 2)

        let decision = state.observeLinkHealth(
            completedFrames: 0,
            expiredFrames: 0,
            productionSummary: nil,
            nowNs: 1_000_000_000
        )

        let recovery = try #require(decision.stallRecovery)
        #expect(recovery.reason == "no-ack-at-cap")
        #expect(recovery.forcedKeyframe)
        #expect(recovery.flushedFrames == 2)
        #expect(recovery.flushedBytes == 2_000)
        // The observation is built before the flush, so the evidence that this window was
        // the jammed one survives into the log.
        #expect(decision.observation.inFlightFrames == 2)
        // ...and admission is reopened for real.
        #expect(state.inFlightFrames == 0)
    }

    @Test func stallRecoveryKeyframeIsRateLimitedButTheFlushIsNot() throws {
        var state = makeState(maxInflightFrames: 1, stallRecoveryMinIntervalMs: 5_000)
        pinManual(&state)

        try sendFrame(&state, at: 0, bytes: 1_000)
        let first = try #require(
            state.observeLinkHealth(
                completedFrames: 0, expiredFrames: 0, productionSummary: nil, nowNs: 1_000_000_000
            ).stallRecovery
        )
        #expect(first.forcedKeyframe)

        // Still stalled one second later, well inside the 5s floor. A keyframe is 47-165KB
        // against a link measured at 300-650kbps, so repeating it every window would spend
        // the link on recovery for a link that is already starved.
        try sendFrame(&state, at: 1_100_000_000, bytes: 1_000)
        let second = try #require(
            state.observeLinkHealth(
                completedFrames: 0, expiredFrames: 0, productionSummary: nil, nowNs: 2_000_000_000
            ).stallRecovery
        )
        #expect(!second.forcedKeyframe)
        // The free half still ran: admission must not stay jammed for the rate limit's sake.
        #expect(second.flushedFrames == 1)
        #expect(state.inFlightFrames == 0)

        // Past the floor, a keyframe is allowed again.
        try sendFrame(&state, at: 6_100_000_000, bytes: 1_000)
        let third = try #require(
            state.observeLinkHealth(
                completedFrames: 0, expiredFrames: 0, productionSummary: nil, nowNs: 6_200_000_000
            ).stallRecovery
        )
        #expect(third.forcedKeyframe)
    }

    @Test func healthyManualWindowRecoversNothing() throws {
        var state = makeState(maxInflightFrames: 4)
        pinManual(&state)
        try sendFrame(&state, at: 0, bytes: 1_000)
        state.noteAck(frameId: 1, nowNs: 20_000_000)

        let decision = state.observeLinkHealth(
            completedFrames: 5,
            expiredFrames: 0,
            productionSummary: nil,
            nowNs: 30_000_000
        )

        // Fast ACK, no loss, nothing abandoned: recovery must not fire, or every calm
        // window would spend a keyframe.
        #expect(decision.stallRecovery == nil)
    }

    @Test func adaptiveGetsTheSameRecoveryWithoutNeedingARungChange() throws {
        var state = makeState(maxInflightFrames: 2)
        // No manual pin: adaptive. Recovery used to arrive here only as a side effect of
        // `outcome.resolutionChanged`, so a rung that held still could not recover.
        try sendFrame(&state, at: 0, bytes: 1_000)
        try sendFrame(&state, at: 100_000_000, bytes: 1_000)

        let decision = state.observeLinkHealth(
            completedFrames: 0,
            expiredFrames: 0,
            productionSummary: nil,
            nowNs: 1_000_000_000
        )

        let recovery = try #require(decision.stallRecovery)
        #expect(recovery.flushedFrames == 2)
        #expect(state.inFlightFrames == 0)
    }

    // MARK: - Looking during the stall

    @Test func hostRaisedWindowWithASilentClientDoesNotReadAsACalmScreen() {
        var state = makeState()

        // A zero-frame window with an empty in-flight list is ambiguous: it is what a calm
        // screen produces AND what a client that stopped reporting produces. Only the first
        // is a reason to climb.
        let synthetic = state.observeLinkHealth(
            completedFrames: 0,
            expiredFrames: 0,
            productionSummary: nil,
            clientReportMissing: true,
            nowNs: 1_000_000_000
        )
        #expect(synthetic.outcome.reason == "idle")
        #expect(!synthetic.outcome.changed)
    }

    @Test func clientReportedIdleWindowStillAccruesRecoveryCredit() {
        // The two windows are byte-identical in shape — zero frames, nothing in flight,
        // clean link — and differ only in who raised them. Below the native rung, that
        // difference has to decide whether the ladder earns credit toward climbing back.
        var reported = makeState()
        var hostRaised = makeState()
        degrade(&reported)
        degrade(&hostRaised)

        let reportedIdle = reported.observeLinkHealth(
            completedFrames: 0,
            expiredFrames: 0,
            productionSummary: nil,
            clientReportMissing: false,
            nowNs: 1_000_000_000
        )
        let syntheticIdle = hostRaised.observeLinkHealth(
            completedFrames: 0,
            expiredFrames: 0,
            productionSummary: nil,
            clientReportMissing: true,
            nowNs: 1_000_000_000
        )

        // A calm screen with a clean link is a recovery opportunity, and must stay one.
        #expect(reportedIdle.observation.recoveryStatus.cleanMs > 0)
        // A client that stopped reporting is not evidence of a healthy link, so it earns
        // nothing. Without the distinction the host would climb into a stall.
        #expect(syntheticIdle.observation.recoveryStatus.cleanMs == 0)
        #expect(syntheticIdle.outcome.reason == "idle")
    }

    /// Drives one loss window so the ladder leaves the native rung, which is the only
    /// state in which idle recovery credit is meaningful.
    private func degrade(_ state: inout QuicSessionHostMediaState) {
        _ = state.observeLinkHealth(
            completedFrames: 80,
            expiredFrames: 20,
            productionSummary: nil,
            nowNs: 0
        )
    }

    // MARK: - The keyframe interval ceiling

    @Test func periodicKeyframeStillGovernedByFrameCountAtNormalCadence() {
        let config = encodingConfig(intervalFrames: 120, maxIntervalMs: 15_000)
        // 30fps: 120 frames is 4s, well inside the ceiling, so the count decides.
        #expect(config.isPeriodicKeyframe(frameId: 120, lastKeyframeUptimeNs: 0, nowNs: 4_000_000_000))
        #expect(!config.isPeriodicKeyframe(frameId: 119, lastKeyframeUptimeNs: 0, nowNs: 3_966_000_000))
    }

    @Test func periodicKeyframeFallsBackToWallClockOnASlowStream() {
        let config = encodingConfig(intervalFrames: 120, maxIntervalMs: 15_000)
        // ADR-0073's own validation profile is 1fps, where a 120-frame GOP is TWO MINUTES.
        // The client is told to hold its last image and wait for one coalesced keyframe;
        // that wait needs a bound.
        #expect(!config.isPeriodicKeyframe(frameId: 14, lastKeyframeUptimeNs: 0, nowNs: 14_000_000_000))
        #expect(config.isPeriodicKeyframe(frameId: 15, lastKeyframeUptimeNs: 0, nowNs: 15_000_000_000))
    }

    @Test func wallClockCeilingNeverFiresBeforeTheFirstKeyframe() {
        let config = encodingConfig(intervalFrames: 120, maxIntervalMs: 15_000)
        // No baseline yet. Frame 1 is unconditionally a keyframe in the encoder, so this
        // only guards the window before it.
        #expect(!config.isPeriodicKeyframe(frameId: 5, lastKeyframeUptimeNs: nil, nowNs: 99_000_000_000))
    }

    @Test func wallClockCeilingIsDisableable() {
        let config = encodingConfig(intervalFrames: 120, maxIntervalMs: 0)
        #expect(!config.isPeriodicKeyframe(frameId: 5, lastKeyframeUptimeNs: 0, nowNs: 99_000_000_000))
        #expect(config.isPeriodicKeyframe(frameId: 120, lastKeyframeUptimeNs: 0, nowNs: 99_000_000_000))
    }

    // MARK: - Helpers

    private func encodingConfig(intervalFrames: Int, maxIntervalMs: Int) -> OwnedMediaEncodingConfiguration {
        OwnedMediaEncodingConfiguration(
            targetBitrateKbps: 2_500,
            expectedFrameRate: 30,
            keyframeIntervalFrames: intervalFrames,
            keyframeMaxIntervalMs: maxIntervalMs
        )
    }

    /// Pins the stream the way the phone's manual mode does. 900/10/0.5 is inside the
    /// client's exposed range (180-5000 kbps, fps 1-30, scale 0.33-1.0).
    private func pinManual(_ state: inout QuicSessionHostMediaState) {
        _ = state.applyClientMediaQuality(
            ClientMediaQualityConfig(
                adaptiveEnabled: false,
                fixedTarget: ClientMediaQualityTarget(bitrateKbps: 900, fps: 10, resolutionScale: 0.5)
            )
        )
    }

    @discardableResult
    private func sendFrame(
        _ state: inout QuicSessionHostMediaState,
        at nowNs: UInt64,
        bytes: Int
    ) throws -> UInt64 {
        guard case .ready(let updateId, _) = state.reserveUpdateId(nowNs: nowNs) else {
            throw StallTestError.admissionRefused
        }
        state.noteSent(
            frameId: updateId.frameId,
            encodedBytes: bytes,
            packets: [Data([0])],
            sentAtUptimeNs: nowNs
        )
        return updateId.frameId
    }

    private enum StallTestError: Error {
        case admissionRefused
    }

    private func makeState(
        maxInflightFrames: Int = 2,
        maxInflightBytes: Int = 300_000,
        stallRecoveryMinIntervalMs: Int = 5_000
    ) -> QuicSessionHostMediaState {
        QuicSessionHostMediaState(
            maxInflightFrames: maxInflightFrames,
            maxInflightBytes: maxInflightBytes,
            expectedFrameRate: 30,
            qualityController: MediaQualityController(config: controllerConfig()),
            resendRingFrames: 4,
            stallRecoveryMinIntervalMs: stallRecoveryMinIntervalMs
        )
    }

    private func controllerConfig() -> MediaQualityControllerConfig {
        MediaQualityControllerConfig(
            ceilingKbps: 2500,
            floorKbps: 800,
            survivalFloorKbps: 300,
            downStep: 0.7,
            upStep: 1.15,
            lossDownPermille: 50,
            raiseCleanWindows: 4,
            cadenceDownWindows: 2,
            fpsCeiling: 30,
            fpsFloor: 10,
            ackHoldP95Ms: 180,
            ackDownP95Ms: 350,
            cadenceGapMs: 500,
            freezeGapMs: 1_000,
            freezeFpsCeiling: 3,
            recoveryMaxGapMs: 300,
            recoveryMinFpsPermille: 800,
            transitionWarmupWindows: 1,
            capacity1Kbps: 650,
            capacity1Fps: 24,
            capacity1Scale: 0.75,
            capacity2Kbps: 400,
            capacity2Fps: 15,
            capacity2Scale: 0.5,
            emergencyKbps: 180, emergencyFps: 6, emergencyScale: 0.33,
            survivalScale: 0.5
        )
    }
}
