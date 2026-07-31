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
        // No quiet-period gate on this clause: a dead path is a dead path whether or not we
        // were sending on it, so this holds even when the host has never sent at all.
        #expect(MediaQualityController.clientLinkStalled(
            telemetry: telemetry,
            reportIntervalMs: 500,
            hostQuietMs: nil
        ))
    }

    @Test func aLiveFreezeIsAStall() {
        // The 12.79s freeze signature: the host is sending continuously (last send 100ms ago)
        // and the client has heard nothing for 12.79 seconds. Our silence does not explain
        // theirs, so the link ate the traffic.
        let telemetry = OwnedMediaLinkTelemetry(
            pathStatus: "satisfied",
            datagramsReceived: 0,
            maxArrivalGapMs: 12_790,
            receiveLoopIterations: 25
        )
        #expect(MediaQualityController.clientLinkStalled(
            telemetry: telemetry,
            reportIntervalMs: 500,
            hostQuietMs: 100
        ))
    }

    @Test func aFreezeOutlivingTheHostsOwnSendingIsStillAStall() {
        // Several windows into a freeze the host has stopped producing and every tracking
        // entry has cleared, so nothing on the host side says "stalled" any more. The client's
        // silence still far outruns ours, which is the only remaining evidence.
        let telemetry = OwnedMediaLinkTelemetry(
            pathStatus: "satisfied",
            datagramsReceived: 0,
            maxArrivalGapMs: 12_790,
            receiveLoopIterations: 25
        )
        #expect(MediaQualityController.clientLinkStalled(
            telemetry: telemetry,
            reportIntervalMs: 500,
            hostQuietMs: 1_500
        ))
    }

    @Test func aCalmScreenReceivingNothingIsNotAStall() {
        // The regression the first device run caught, in the shape the device actually
        // produced (host log window 26): a satisfied WiFi path, zero completions, nothing in
        // flight, `datagramsRecv=0 maxArrivalGapMs=686.6` -- a gap well over the 500ms report
        // interval. 27 windows of that session matched. Every field looks like the freeze
        // signature except the one that matters: the host was equally quiet, so there was
        // nothing to arrive.
        //
        // The earlier version of this test used `datagramsReceived: 12`, assuming a calm
        // screen still carries traffic. The device disproved that, which is why the synthetic
        // suite passed while the behaviour was wrong.
        let telemetry = OwnedMediaLinkTelemetry(
            pathStatus: "satisfied",
            datagramsReceived: 0,
            maxArrivalGapMs: 686.6,
            receiveLoopIterations: 0
        )
        #expect(!MediaQualityController.clientLinkStalled(
            telemetry: telemetry,
            reportIntervalMs: 500,
            hostQuietMs: 686
        ))
    }

    @Test func aUserAwayFromTheMacIsNotAStall() {
        // The case gap magnitude alone cannot survive: nobody has touched the screen for 30
        // seconds, so the client has legitimately heard nothing for 30 seconds. A rule keyed
        // on gap size would call this a stall and deny recovery to an entirely healthy link.
        let telemetry = OwnedMediaLinkTelemetry(
            pathStatus: "satisfied",
            datagramsReceived: 0,
            maxArrivalGapMs: 30_000,
            receiveLoopIterations: 0
        )
        #expect(!MediaQualityController.clientLinkStalled(
            telemetry: telemetry,
            reportIntervalMs: 500,
            hostQuietMs: 30_000
        ))
    }

    @Test func aCalmScreenStillCarryingTrafficIsNotAStall() {
        // The other calm shape: datagrams flowing, path fine, nothing moving on screen.
        let telemetry = OwnedMediaLinkTelemetry(
            pathStatus: "satisfied",
            datagramsReceived: 12,
            maxArrivalGapMs: 40,
            receiveLoopIterations: 12
        )
        #expect(!MediaQualityController.clientLinkStalled(
            telemetry: telemetry,
            reportIntervalMs: 500,
            hostQuietMs: 40
        ))
    }

    @Test func aBriefGapInsideOneWindowIsNotAStall() {
        // Zero arrivals but the gap is under the report interval: the window simply closed
        // during an ordinary quiet stretch.
        let telemetry = OwnedMediaLinkTelemetry(
            pathStatus: "satisfied",
            datagramsReceived: 0,
            maxArrivalGapMs: 120
        )
        #expect(!MediaQualityController.clientLinkStalled(
            telemetry: telemetry,
            reportIntervalMs: 500,
            hostQuietMs: 20
        ))
    }

    @Test func aHostThatNeverSentAnythingCannotObserveAStall() {
        // No traffic has ever left the host, so the client's silence carries no information.
        let telemetry = OwnedMediaLinkTelemetry(
            pathStatus: "satisfied",
            datagramsReceived: 0,
            maxArrivalGapMs: 12_790
        )
        #expect(!MediaQualityController.clientLinkStalled(
            telemetry: telemetry,
            reportIntervalMs: 500,
            hostQuietMs: nil
        ))
    }

    @Test func absentTelemetryIsNotTreatedAsAStall() {
        // A client build without telemetry must behave exactly as before rather than being
        // permanently denied recovery.
        #expect(!MediaQualityController.clientLinkStalled(
            telemetry: nil,
            reportIntervalMs: 500,
            hostQuietMs: 100
        ))
    }

    // MARK: - The recovery-credit regression

    @Test func aStalledClientsZeroWindowEarnsNoRecoveryCredit() {
        // The regression guard, end to end through the controller. Both windows are
        // zero-count with clientReportMissing == false, so only the telemetry and the host's
        // own send history can tell them apart.
        //
        // Both hosts send a frame; the difference is WHEN relative to the observation. The
        // calm host's last send is recent and its client heard from it just as recently. The
        // stalled host's last send is equally recent, but its client has heard nothing for
        // 12.79 seconds -- silence that our own quiet period cannot explain.
        var calm = makeState()
        var stalled = makeState()
        degrade(&calm)
        degrade(&stalled)

        // Ack each frame so nothing is left in flight: the idle branch under test is only
        // reached with an empty in-flight list, and a pending frame would block both windows
        // for an unrelated reason and prove nothing.
        let observeAtNs: UInt64 = 13_000_000_000
        let recentSendNs: UInt64 = 12_900_000_000  // 100ms before the observation
        if let id = try? sendFrame(&calm, at: recentSendNs, bytes: 1_000) {
            calm.noteAck(frameId: id, nowNs: recentSendNs + 1_000_000)
        }
        if let id = try? sendFrame(&stalled, at: recentSendNs, bytes: 1_000) {
            stalled.noteAck(frameId: id, nowNs: recentSendNs + 1_000_000)
        }

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
            nowNs: observeAtNs
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
            nowNs: observeAtNs
        )

        #expect(calmWindow.observation.recoveryStatus.cleanMs > 0)
        #expect(stalledWindow.observation.recoveryStatus.cleanMs == 0)
    }

    @Test func aCalmScreenStillEarnsRecoveryCreditWithNoTrafficAtAll() {
        // The device-caught regression, end to end. This is host log window 26 replayed: a
        // degraded ladder, a satisfied path, and both ends quiet for ~686ms. It must accrue
        // credit, or a stream that drops a rung during a cellular blip never climbs back
        // while the user is reading rather than scrolling.
        var calm = makeState()
        degrade(&calm)
        let sendNs: UInt64 = 1_000_000_000
        if let id = try? sendFrame(&calm, at: sendNs, bytes: 1_000) {
            calm.noteAck(frameId: id, nowNs: sendNs + 1_000_000)
        }

        let window = calm.observeLinkHealth(
            completedFrames: 0,
            expiredFrames: 0,
            productionSummary: nil,
            clientReportMissing: false,
            clientTelemetry: OwnedMediaLinkTelemetry(
                pathStatus: "satisfied",
                datagramsReceived: 0,
                maxArrivalGapMs: 686.6,
                receiveLoopIterations: 0
            ),
            reportIntervalMs: 500,
            nowNs: sendNs + 686_000_000
        )

        #expect(window.observation.recoveryStatus.cleanMs > 0)
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
