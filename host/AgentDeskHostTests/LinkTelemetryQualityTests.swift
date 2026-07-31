import Foundation
import Testing
import AgentDeskWire

@testable import AgentDeskHost

/// ADR-0088. Two things are pinned here.
///
/// The first is a regression that the diagnostics work itself introduced. Recovery credit
/// used to be withheld from a stalled client purely because a stalled client sent nothing,
/// and silence set `clientReportMissing`. Once the client reports unconditionally, that
/// protection evaporates unless the host reads what the report SAYS -- a zero-count window
/// from a frozen client would otherwise arrive looking exactly like a calm screen and climb
/// the ladder mid-freeze.
///
/// The second is that the fix stays narrow: a genuinely calm screen must still recover, or
/// this trades a freeze for a stream that never climbs back after any quiet moment.
struct LinkTelemetryQualityTests {

    // MARK: - What counts as a stalled client

    @Test func anUnsatisfiedPathIsAStall() {
        let telemetry = OwnedMediaLinkTelemetry(
            pathStatus: "unsatisfied",
            unsatisfiedReason: "notAvailable"
        )
        #expect(MediaQualityController.clientLinkStalled(telemetry: telemetry, reportIntervalMs: 500))
    }

    @Test func aReceiveLoopThatCollectedNothingForAFullIntervalIsAStall() {
        // The 12.79s freeze signature: nothing arrived, and the gap proves it was not merely
        // a short quiet moment inside the window.
        let telemetry = OwnedMediaLinkTelemetry(
            pathStatus: "satisfied",
            datagramsReceived: 0,
            maxArrivalGapMs: 12_790,
            receiveLoopIterations: 25
        )
        #expect(MediaQualityController.clientLinkStalled(telemetry: telemetry, reportIntervalMs: 500))
    }

    @Test func aCalmScreenIsNotAStall() {
        // No frames completed because nothing moved on screen, but datagrams are flowing and
        // the path is fine. Treating this as a stall would block idle recovery entirely.
        let telemetry = OwnedMediaLinkTelemetry(
            pathStatus: "satisfied",
            datagramsReceived: 12,
            maxArrivalGapMs: 40,
            receiveLoopIterations: 12
        )
        #expect(!MediaQualityController.clientLinkStalled(telemetry: telemetry, reportIntervalMs: 500))
    }

    @Test func aBriefGapInsideOneWindowIsNotAStall() {
        // Zero arrivals but the gap is under the report interval: the window simply closed
        // during an ordinary quiet stretch.
        let telemetry = OwnedMediaLinkTelemetry(
            pathStatus: "satisfied",
            datagramsReceived: 0,
            maxArrivalGapMs: 120
        )
        #expect(!MediaQualityController.clientLinkStalled(telemetry: telemetry, reportIntervalMs: 500))
    }

    @Test func absentTelemetryIsNotTreatedAsAStall() {
        // A client build without telemetry must behave exactly as before rather than being
        // permanently denied recovery.
        #expect(!MediaQualityController.clientLinkStalled(telemetry: nil, reportIntervalMs: 500))
    }

    // MARK: - The recovery-credit regression

    @Test func aStalledClientsZeroWindowEarnsNoRecoveryCredit() {
        // The regression guard. Both windows are zero-count and both have
        // clientReportMissing == false, so ONLY the telemetry can tell them apart.
        var calm = makeState()
        var stalled = makeState()
        degrade(&calm)
        degrade(&stalled)

        let calmWindow = calm.observeLinkHealth(
            completedFrames: 0,
            expiredFrames: 0,
            productionSummary: nil,
            clientReportMissing: false,
            clientTelemetry: OwnedMediaLinkTelemetry(
                pathStatus: "satisfied",
                datagramsReceived: 8,
                maxArrivalGapMs: 60
            ),
            reportIntervalMs: 500,
            nowNs: 1_000_000_000
        )
        let stalledWindow = stalled.observeLinkHealth(
            completedFrames: 0,
            expiredFrames: 0,
            productionSummary: nil,
            clientReportMissing: false,
            clientTelemetry: OwnedMediaLinkTelemetry(
                pathStatus: "satisfied",
                datagramsReceived: 0,
                maxArrivalGapMs: 12_790,
                receiveLoopIterations: 25
            ),
            reportIntervalMs: 500,
            nowNs: 1_000_000_000
        )

        #expect(calmWindow.observation.recoveryStatus.cleanMs > 0)
        #expect(stalledWindow.observation.recoveryStatus.cleanMs == 0)
    }

    // MARK: - Round-trip inflation reaches the observation

    @Test func slowAcksInflateTheRoundTripRatio() {
        // A path that queues: same route, acks arriving far later than the floor.
        var state = makeState(maxInflightFrames: 8)
        try? sendFrame(&state, at: 0, bytes: 1_000)
        state.noteAck(frameId: 1, nowNs: 20_000_000)

        #expect(state.roundTrip.minimumMs == 20)
        #expect(state.roundTrip.inflationRatio == 1)

        for index in 2...6 {
            try? sendFrame(&state, at: UInt64(index) * 100_000_000, bytes: 1_000)
            state.noteAck(frameId: UInt64(index), nowNs: UInt64(index) * 100_000_000 + 2_000_000_000)
        }

        // Floor unmoved at 20ms, smoothed dragged up by the 2s samples.
        #expect(state.roundTrip.minimumMs == 20)
        #expect((state.roundTrip.inflationRatio ?? 0) > 10)
    }

    @Test func aSilentWindowAgesTheRoundTripFloor() {
        // No acks at all -- a freeze. The floor must be allowed to expire on the window
        // boundary, or the ratio reports against a baseline from before the stall forever.
        var state = makeState(roundTripMinimumWindowMs: 1_000)
        try? sendFrame(&state, at: 0, bytes: 1_000)
        state.noteAck(frameId: 1, nowNs: 10_000_000)
        #expect(state.roundTrip.minimumMs == 10)

        _ = state.observeLinkHealth(
            completedFrames: 0,
            expiredFrames: 0,
            productionSummary: nil,
            nowNs: 5_000_000_000
        )
        #expect(state.roundTrip.minimumMs == nil)
    }

    // MARK: - Helpers

    private func degrade(_ state: inout QuicSessionHostMediaState) {
        _ = state.observeLinkHealth(
            completedFrames: 80,
            expiredFrames: 20,
            productionSummary: nil,
            nowNs: 0
        )
    }

    @discardableResult
    private func sendFrame(
        _ state: inout QuicSessionHostMediaState,
        at nowNs: UInt64,
        bytes: Int
    ) throws -> UInt64 {
        guard case .ready(let updateId, _) = state.reserveUpdateId(nowNs: nowNs) else {
            throw LinkTelemetryTestError.admissionRefused
        }
        state.noteSent(
            frameId: updateId.frameId,
            encodedBytes: bytes,
            packets: [Data([0])],
            sentAtUptimeNs: nowNs
        )
        return updateId.frameId
    }

    private func makeState(
        maxInflightFrames: Int = 2,
        roundTripMinimumWindowMs: Int = 30_000
    ) -> QuicSessionHostMediaState {
        QuicSessionHostMediaState(
            maxInflightFrames: maxInflightFrames,
            maxInflightBytes: 300_000,
            expectedFrameRate: 30,
            qualityController: MediaQualityController(config: controllerConfig()),
            resendRingFrames: 4,
            stallRecoveryMinIntervalMs: 5_000,
            roundTripMinimumWindowMs: roundTripMinimumWindowMs
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

private enum LinkTelemetryTestError: Error {
    case admissionRefused
}
