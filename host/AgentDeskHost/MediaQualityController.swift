import Foundation
import AgentDeskWire

// ADR-0033: one host-owned media-quality controller chooses bitrate, fps, and
// capture resolution together from link-health and production smoothness.
enum MediaQualityRung: Int, Equatable, Comparable {
    case native = 0
    case lossControl = 1
    case capacity1 = 2
    case capacity2 = 3
    case survival = 4
    case emergency = 5

    static func < (lhs: MediaQualityRung, rhs: MediaQualityRung) -> Bool {
        lhs.rawValue < rhs.rawValue
    }
}

struct MediaQualityTarget: Equatable {
    let bitrateKbps: Int
    let fps: Int
    let resolutionScale: Double
    let rung: MediaQualityRung
    let reason: String

    func with(
        bitrateKbps: Int? = nil,
        fps: Int? = nil,
        resolutionScale: Double? = nil,
        rung: MediaQualityRung? = nil,
        reason: String
    ) -> MediaQualityTarget {
        MediaQualityTarget(
            bitrateKbps: bitrateKbps ?? self.bitrateKbps,
            fps: fps ?? self.fps,
            resolutionScale: resolutionScale ?? self.resolutionScale,
            rung: rung ?? self.rung,
            reason: reason
        )
    }
}

struct MediaQualitySample: Equatable {
    let completedFrames: Int
    let expiredFrames: Int
    let resendRequests: Int
    let keyframeRequests: Int
    let ackAgeP50Ms: Double?
    let ackAgeP95Ms: Double?

    init(
        completedFrames: Int,
        expiredFrames: Int,
        resendRequests: Int = 0,
        keyframeRequests: Int = 0,
        ackAgeP50Ms: Double? = nil,
        ackAgeP95Ms: Double? = nil
    ) {
        self.completedFrames = max(0, completedFrames)
        self.expiredFrames = max(0, expiredFrames)
        self.resendRequests = max(0, resendRequests)
        self.keyframeRequests = max(0, keyframeRequests)
        self.ackAgeP50Ms = ackAgeP50Ms
        self.ackAgeP95Ms = ackAgeP95Ms
    }
}

struct MediaQualityControllerInput: Equatable {
    let sample: MediaQualitySample
    let productionSummary: MediaProductionSummary?
    let ackCount: Int
    let ackAgeMaxMs: Double?
    let inFlightFrames: Int
    let inFlightBytes: Int
    let oldestInflightMs: Double?
    let staleRecoveryCount: Int
    /// ADR-0087: this window was raised by the host's own clock because no client
    /// link-health report arrived, not by a report. Load-bearing for the idle branch: a
    /// silent client and a calm screen both produce a zero-frame window, and only one of
    /// them is a reason to climb.
    let clientReportMissing: Bool
    // ADR-0088: the client reported, and what it reported is that its own link is stalled --
    // a non-viable path, or a receive loop that collected nothing for a full window. A window
    // like this is evidence AGAINST link health, not the absence of evidence that
    // `clientReportMissing` describes.
    let clientLinkStalled: Bool

    init(
        sample: MediaQualitySample,
        productionSummary: MediaProductionSummary? = nil,
        ackCount: Int = 0,
        ackAgeMaxMs: Double? = nil,
        inFlightFrames: Int = 0,
        inFlightBytes: Int = 0,
        oldestInflightMs: Double? = nil,
        staleRecoveryCount: Int = 0,
        clientReportMissing: Bool = false,
        clientLinkStalled: Bool = false
    ) {
        self.clientReportMissing = clientReportMissing
        self.clientLinkStalled = clientLinkStalled
        self.sample = sample
        self.productionSummary = productionSummary
        self.ackCount = max(0, ackCount)
        self.ackAgeMaxMs = ackAgeMaxMs
        self.inFlightFrames = max(0, inFlightFrames)
        self.inFlightBytes = max(0, inFlightBytes)
        self.oldestInflightMs = oldestInflightMs
        self.staleRecoveryCount = max(0, staleRecoveryCount)
    }
}

struct MediaQualityObservationSignals: Equatable {
    let lossPressure: Bool
    let repairPressure: Bool
    let queuePressure: Bool
    let cadencePressure: Bool
    let stalePressure: Bool
    let freezePressure: Bool
    let lossPermille: Int
}

struct MediaQualityEvaluation: Equatable {
    let signals: MediaQualityObservationSignals
    let outcome: MediaQualityOutcome
    let recoveryStatus: MediaQualityRecoveryStatus
}

struct MediaQualityOutcome: Equatable {
    let target: MediaQualityTarget
    let previousTarget: MediaQualityTarget
    let reason: String

    var changed: Bool {
        bitrateChanged || fpsChanged || resolutionChanged || target.rung != previousTarget.rung
    }
    var bitrateChanged: Bool { target.bitrateKbps != previousTarget.bitrateKbps }
    var fpsChanged: Bool { target.fps != previousTarget.fps }
    var resolutionChanged: Bool { target.resolutionScale != previousTarget.resolutionScale }
}

enum MediaQualityRecoveryPhase: String, Equatable {
    case steady
    case bitrateRecovering
    case resolutionProbe
    case transitionWarmup
    case fpsProbe
}

enum MediaQualityProbeAxis: String, Equatable {
    case none
    case resolution
    case fps
}

struct MediaQualityRecoveryStatus: Equatable {
    let cleanMs: Int
    let requiredMs: Int
    let blocker: String
    let probeWindowsRemaining: Int
    let phase: MediaQualityRecoveryPhase
    let warmupWindowsRemaining: Int
    let probeAxis: MediaQualityProbeAxis
    let stableTarget: MediaQualityTarget
}

struct MediaQualityControllerConfig: Equatable {
    let ceilingKbps: Int
    let floorKbps: Int
    let survivalFloorKbps: Int
    let downStep: Double
    let upStep: Double
    let lossDownPermille: Int
    let raiseCleanWindows: Int
    let cadenceDownWindows: Int
    let fpsCeiling: Int
    let fpsFloor: Int
    let ackHoldP95Ms: Double
    let ackDownP95Ms: Double
    let cadenceGapMs: Int
    let freezeGapMs: Int
    let freezeFpsCeiling: Int
    let recoveryMaxGapMs: Int
    let recoveryMinFpsPermille: Int
    let transitionWarmupWindows: Int
    let capacity1Kbps: Int
    let capacity1Fps: Int
    let capacity1Scale: Double
    let capacity2Kbps: Int
    let capacity2Fps: Int
    let capacity2Scale: Double
    let emergencyKbps: Int
    let emergencyFps: Int
    let emergencyScale: Double
    let survivalScale: Double

    init(
        ceilingKbps: Int,
        floorKbps: Int,
        survivalFloorKbps: Int,
        downStep: Double,
        upStep: Double,
        lossDownPermille: Int,
        raiseCleanWindows: Int,
        cadenceDownWindows: Int,
        fpsCeiling: Int,
        fpsFloor: Int,
        ackHoldP95Ms: Double,
        ackDownP95Ms: Double,
        cadenceGapMs: Int,
        freezeGapMs: Int,
        freezeFpsCeiling: Int,
        recoveryMaxGapMs: Int,
        recoveryMinFpsPermille: Int,
        transitionWarmupWindows: Int,
        capacity1Kbps: Int,
        capacity1Fps: Int,
        capacity1Scale: Double,
        capacity2Kbps: Int,
        capacity2Fps: Int,
        capacity2Scale: Double,
        emergencyKbps: Int,
        emergencyFps: Int,
        emergencyScale: Double,
        survivalScale: Double
    ) {
        self.ceilingKbps = max(1, ceilingKbps)
        self.floorKbps = min(max(1, floorKbps), self.ceilingKbps)
        self.survivalFloorKbps = min(max(1, survivalFloorKbps), self.floorKbps)
        self.downStep = min(max(downStep, 0.01), 0.99)
        self.upStep = max(upStep, 1.01)
        self.lossDownPermille = max(1, lossDownPermille)
        self.raiseCleanWindows = max(1, raiseCleanWindows)
        self.cadenceDownWindows = max(1, cadenceDownWindows)
        self.fpsCeiling = max(1, fpsCeiling)
        self.fpsFloor = min(max(1, fpsFloor), self.fpsCeiling)
        self.ackHoldP95Ms = max(1, ackHoldP95Ms)
        self.ackDownP95Ms = max(self.ackHoldP95Ms, ackDownP95Ms)
        self.cadenceGapMs = max(1, cadenceGapMs)
        self.freezeGapMs = max(self.cadenceGapMs, freezeGapMs)
        self.freezeFpsCeiling = max(0, freezeFpsCeiling)
        self.recoveryMaxGapMs = max(1, recoveryMaxGapMs)
        self.recoveryMinFpsPermille = min(max(1, recoveryMinFpsPermille), 1_000)
        self.transitionWarmupWindows = max(0, transitionWarmupWindows)
        self.capacity1Kbps = min(max(1, capacity1Kbps), self.floorKbps)
        self.capacity1Fps = min(max(1, capacity1Fps), self.fpsCeiling)
        self.capacity1Scale = Self.normalizedScale(capacity1Scale)
        self.capacity2Kbps = min(max(1, capacity2Kbps), self.capacity1Kbps)
        self.capacity2Fps = min(max(1, capacity2Fps), self.capacity1Fps)
        self.capacity2Scale = min(Self.normalizedScale(capacity2Scale), self.capacity1Scale)
        self.survivalScale = min(Self.normalizedScale(survivalScale), self.capacity2Scale)
        self.emergencyKbps = min(max(1, emergencyKbps), self.survivalFloorKbps)
        self.emergencyFps = min(max(1, emergencyFps), self.fpsFloor)
        self.emergencyScale = min(Self.normalizedScale(emergencyScale), self.survivalScale)
    }

    static func fromConfig() -> MediaQualityControllerConfig {
        MediaQualityControllerConfig(
            ceilingKbps: Config.ownedMediaBitrateKbps,
            floorKbps: Config.ownedMediaBitrateFloorKbps,
            survivalFloorKbps: Config.ownedMediaSurvivalBitrateFloorKbps,
            downStep: Config.ownedMediaBitrateDownStep,
            upStep: Config.ownedMediaBitrateUpStep,
            lossDownPermille: Config.ownedMediaBitrateLossDownPermille,
            raiseCleanWindows: Config.ownedMediaBitrateRaiseCleanWindows,
            cadenceDownWindows: Config.ownedMediaCadenceDownWindows,
            fpsCeiling: Config.ownedMediaExpectedFrameRate,
            fpsFloor: Config.ownedMediaFpsFloor,
            ackHoldP95Ms: Config.ownedMediaAckHoldP95Ms,
            ackDownP95Ms: Config.ownedMediaAckDownP95Ms,
            cadenceGapMs: Config.ownedMediaCadenceGapMs,
            freezeGapMs: Config.ownedMediaFreezeGapMs,
            freezeFpsCeiling: Config.ownedMediaFreezeFpsCeiling,
            recoveryMaxGapMs: Config.ownedMediaRecoveryMaxGapMs,
            recoveryMinFpsPermille: Config.ownedMediaRecoveryMinFpsPermille,
            transitionWarmupWindows: Config.ownedMediaTransitionWarmupWindows,
            capacity1Kbps: Config.ownedMediaCapacity1BitrateKbps,
            capacity1Fps: Config.ownedMediaCapacity1Fps,
            capacity1Scale: Config.ownedMediaCapacity1ResolutionScale,
            capacity2Kbps: Config.ownedMediaCapacity2BitrateKbps,
            capacity2Fps: Config.ownedMediaCapacity2Fps,
            capacity2Scale: Config.ownedMediaCapacity2ResolutionScale,
            emergencyKbps: Config.ownedMediaEmergencyBitrateKbps,
            emergencyFps: Config.ownedMediaEmergencyFps,
            emergencyScale: Config.ownedMediaEmergencyResolutionScale,
            survivalScale: Config.ownedMediaSurvivalResolutionScale
        )
    }

    static func normalizedScale(_ scale: Double) -> Double {
        min(max(scale, 0.1), 1.0)
    }
}

struct MediaQualityController {
    /// ADR-0088: does this client report describe a stalled link?
    ///
    /// Lives here, with the rest of signal interpretation, rather than on the state that
    /// happens to call it: it reads a report and returns a judgement, holding no state of
    /// its own.
    ///
    /// Two independent grounds, because they fail differently:
    ///
    /// - the path is not satisfied, which the client learns from `NWPathMonitor` and the host
    ///   cannot see from its own side of a one-way datagram carrier;
    /// - the receive loop collected nothing for at least a full report interval, which is the
    ///   12.79s-freeze signature (every counter zero, including pending frame depth).
    ///
    /// Deliberately NOT grounds: a zero completed-frame count on its own. A calm screen
    /// legitimately produces no frames, and treating that as a stall would block the idle
    /// recovery this branch exists to grant.
    static func clientLinkStalled(
        telemetry: OwnedMediaLinkTelemetry?,
        reportIntervalMs: Int
    ) -> Bool {
        guard let telemetry else { return false }
        if let status = telemetry.pathStatus, status != "satisfied" { return true }
        if let arrivals = telemetry.datagramsReceived,
           arrivals == 0,
           let gapMs = telemetry.maxArrivalGapMs,
           gapMs >= Double(max(1, reportIntervalMs)) {
            return true
        }
        return false
    }

    private let config: MediaQualityControllerConfig
    private(set) var target: MediaQualityTarget
    private var cleanRecoveryMs = 0
    private var cadencePressureStreak = 0
    private var probeWindowsRemaining = 0
    private var warmupWindowsRemaining = 0
    private var probeAxis: MediaQualityProbeAxis = .none
    private var recoveryPhaseState: MediaQualityRecoveryPhase = .steady
    private var stableTarget: MediaQualityTarget
    // Nominal window credited per idle (zero-activity) observation. The controller
    // counts recovery in one-second windows (requiredRecoveryMs = raiseCleanWindows
    // * 1000, probeWindowsRemaining decremented once per window), so an idle window
    // credits the same unit to keep ms-accrual and probe-window counting aligned.
    private let idleRecoveryWindowMs = 1_000

    init(config: MediaQualityControllerConfig) {
        self.config = config
        let initialTarget = MediaQualityTarget(
            bitrateKbps: config.ceilingKbps,
            fps: config.fpsCeiling,
            resolutionScale: 1.0,
            rung: .native,
            reason: "initial"
        )
        self.target = initialTarget
        self.stableTarget = initialTarget
    }

    var targetKbps: Int { target.bitrateKbps }
    var targetFps: Int { target.fps }
    var targetResolutionScale: Double { target.resolutionScale }
    var requiredRecoveryMs: Int { config.raiseCleanWindows * 1_000 }
    var currentRecoveryStatus: MediaQualityRecoveryStatus {
        recoveryStatus(blocker: "none")
    }

    mutating func pin(to target: MediaQualityTarget) {
        self.target = target
        self.stableTarget = target
        cleanRecoveryMs = 0
        cadencePressureStreak = 0
        clearProbe()
    }

    mutating func observe(_ input: MediaQualityControllerInput) -> MediaQualityEvaluation {
        let previous = target
        let signals = makeSignals(input)
        let total = input.sample.completedFrames + input.sample.expiredFrames
        if total == 0 {
            resetPressureStreaks()
            // A calm screen is change-driven quiet, not a frozen link: ScreenCaptureKit
            // produces no frames when nothing moves, so a zero-activity window with a
            // clean link is a recovery opportunity, climb back so the next motion burst
            // starts crisp, rather than wiping recovery credit. A window with frames
            // still inflight is a pre-timeout stall, not idle, and must not climb.
            // ADR-0087: a host-raised window means the client stopped reporting, which is
            // the opposite of evidence that the link is healthy. Without this the synthetic
            // tick would read a silent client with an empty in-flight list as a calm screen
            // and climb the ladder into a stall.
            //
            // ADR-0088 tightens this from "who sent the window" to "what the window says".
            // The old test rested on a side effect: a stalled client happened to be silent
            // because the client suppressed zero-count reports, so silence stood in for
            // "stalled". Now that reports are sent unconditionally, a stalled client sends a
            // zero-count window with `clientReportMissing == false`, which would have reached
            // this branch and climbed the ladder mid-freeze. `clientLinkStalled` reads the
            // telemetry the report now carries, so the judgement no longer depends on the
            // messenger.
            let idleLinkClean = !input.clientReportMissing
                && !input.clientLinkStalled
                && input.inFlightFrames == 0
                && input.staleRecoveryCount == 0
                && !signals.lossPressure
                && !signals.repairPressure
                && !signals.queuePressure
            if idleLinkClean && target.rung != .native {
                return accrueCleanRecovery(
                    signals: signals,
                    previous: previous,
                    windowMs: idleRecoveryWindowMs
                )
            }
            resetRecovery()
            return evaluation(signals: signals, previous: previous, reason: "idle", recoveryBlocker: "idle")
        }

        if signals.stalePressure {
            resetPressureStreaks()
            resetRecovery()
            downshiftCapacity(reason: "stale-capacity-down")
            return evaluation(
                signals: signals,
                previous: previous,
                reason: target == previous ? floorReason : target.reason,
                recoveryBlocker: "stale-pressure"
            )
        }

        if signals.lossPressure {
            resetPressureStreaks()
            resetRecovery()
            downshiftLoss(reason: "loss-down")
            return evaluation(
                signals: signals,
                previous: previous,
                reason: target == previous ? floorReason : target.reason,
                recoveryBlocker: "loss-pressure"
            )
        }

        if warmupWindowsRemaining > 0 {
            warmupWindowsRemaining -= 1
            cleanRecoveryMs = 0
            return evaluation(
                signals: signals,
                previous: previous,
                reason: "transition-warmup",
                recoveryBlocker: "transition-warmup"
            )
        }

        if signals.freezePressure {
            if probeAxis != .none {
                let activeProbeAxis = probeAxis
                rollbackProbe(axis: activeProbeAxis)
                return evaluation(
                    signals: signals,
                    previous: previous,
                    reason: target.reason,
                    recoveryBlocker: "probe-\(activeProbeAxis.rawValue)-pressure"
                )
            }
            resetPressureStreaks()
            resetRecovery()
            downshiftCapacity(reason: "freeze-capacity-down")
            return evaluation(
                signals: signals,
                previous: previous,
                reason: target == previous ? floorReason : target.reason,
                recoveryBlocker: "freeze-pressure"
            )
        }

        if signals.queuePressure && signals.cadencePressure {
            if probeAxis != .none {
                let activeProbeAxis = probeAxis
                rollbackProbe(axis: activeProbeAxis)
                return evaluation(
                    signals: signals,
                    previous: previous,
                    reason: target.reason,
                    recoveryBlocker: "probe-\(activeProbeAxis.rawValue)-pressure"
                )
            }
            resetPressureStreaks()
            resetRecovery()
            downshiftCapacity(reason: "queue-cadence-down")
            return evaluation(
                signals: signals,
                previous: previous,
                reason: target == previous ? floorReason : target.reason,
                recoveryBlocker: "queue-cadence-pressure"
            )
        }

        if signals.cadencePressure {
            let activeProbeAxis = probeAxis
            if activeProbeAxis != .none {
                resetPressureStreaks()
                rollbackProbe(axis: activeProbeAxis)
                return evaluation(
                    signals: signals,
                    previous: previous,
                    reason: target == previous ? floorReason : target.reason,
                    recoveryBlocker: "probe-\(activeProbeAxis.rawValue)-pressure"
                )
            }
            resetRecovery()
            cadencePressureStreak += 1
            guard cadencePressureStreak >= config.cadenceDownWindows else {
                return evaluation(
                    signals: signals,
                    previous: previous,
                    reason: "cadence-hold",
                    recoveryBlocker: "cadence-pressure"
                )
            }
            cadencePressureStreak = 0
            downshiftCapacity(reason: "cadence-capacity-down")
            return evaluation(
                signals: signals,
                previous: previous,
                reason: target == previous ? floorReason : target.reason,
                recoveryBlocker: "cadence-pressure"
            )
        }

        cadencePressureStreak = 0

        if signals.queuePressure || (input.sample.ackAgeP95Ms ?? 0) >= config.ackHoldP95Ms {
            resetRecovery()
            return evaluation(
                signals: signals,
                previous: previous,
                reason: "latency-hold",
                recoveryBlocker: "recovery-wait-ack"
            )
        }

        if let recoveryBlocker = recoveryBlocker(input, signals: signals) {
            if recoveryBlocker == "recovery-wait-fps" || recoveryBlocker == "recovery-wait-gap" {
                resetRecovery()
            }
            return evaluation(
                signals: signals,
                previous: previous,
                reason: recoveryBlocker,
                recoveryBlocker: recoveryBlocker
            )
        }

        // A clean window with no production summary (sparse, ack-only) still
        // represents real elapsed link-clean time; credit a nominal window so
        // recovery progresses instead of stalling between sparse production windows.
        let cleanWindowMs = input.productionSummary?.windowMs ?? idleRecoveryWindowMs
        return accrueCleanRecovery(signals: signals, previous: previous, windowMs: cleanWindowMs)
    }

    // Shared climb path for a clean window, whether it carried production (active
    // recovery) or was idle (rest recovery). Accrues recovery credit, advances any
    // probe, and lifts the ladder one step once the clean streak clears the bar.
    private mutating func accrueCleanRecovery(
        signals: MediaQualityObservationSignals,
        previous: MediaQualityTarget,
        windowMs: Int
    ) -> MediaQualityEvaluation {
        cleanRecoveryMs += max(windowMs, 1)
        if probeWindowsRemaining > 0 {
            probeWindowsRemaining -= 1
        }
        if cleanRecoveryMs >= requiredRecoveryMs {
            cleanRecoveryMs = 0
            if probeAxis != .none {
                markProbeStable()
                return evaluation(
                    signals: signals,
                    previous: previous,
                    reason: "probe-stable",
                    recoveryBlocker: "none"
                )
            }
            recover()
            return evaluation(
                signals: signals,
                previous: previous,
                reason: target == previous ? "at-native" : target.reason,
                recoveryBlocker: target == previous ? "at-native" : "none"
            )
        }
        return evaluation(signals: signals, previous: previous, reason: "clean-hold", recoveryBlocker: "none")
    }

    // ADR-0033 requires that "the same controller derives the logged pressure classes and
    // the policy decision, so diagnostics cannot drift from behavior". Internal, not
    // private, because a manually pinned stream must derive its signals here too: it does
    // not run `observe`, but it still has to report (and now respond to) a stalled link.
    // Pure: reads the input and config, mutates nothing, so it is safe on a path whose
    // whole contract is that the target does not move.
    func makeSignals(_ input: MediaQualityControllerInput) -> MediaQualityObservationSignals {
        let sample = input.sample
        let total = sample.completedFrames + sample.expiredFrames
        let lossPermille = total > 0 ? (sample.expiredFrames * 1000) / total : 0
        let repairPressure = sample.resendRequests > 0
        let lossPressure = lossPermille >= config.lossDownPermille ||
            sample.expiredFrames > 0 ||
            sample.keyframeRequests > 0 ||
            repairPressure
        let queuePressure = (sample.ackAgeP95Ms ?? 0) >= config.ackDownP95Ms
        let stalePressure = input.staleRecoveryCount > 0
        // Production cadence (low fps, big gaps) measures how much the screen is
        // changing, not link capacity: a settled screen is change-driven sparse,
        // not a frozen link. Only read sparse production as freeze/cadence
        // pressure when the link itself is under stress (loss, repair, stale, or
        // slow acks). Without this gate a calm screen reads as a freeze, so the
        // ladder both downshifts and rolls back recovery probes, pinning
        // resolution low after motion stops.
        let linkStressed = sample.expiredFrames > 0 ||
            repairPressure ||
            sample.keyframeRequests > 0 ||
            stalePressure ||
            (sample.ackAgeP95Ms ?? 0) >= config.ackHoldP95Ms
        let cadencePressure = linkStressed && (input.productionSummary.map { summary in
            summary.fpsDeficit * 2 >= max(summary.targetFps, 1) ||
                summary.maxGapMs >= config.cadenceGapMs
        } ?? false)
        let freezePressure = linkStressed && (input.productionSummary.map { summary in
            summary.maxGapMs >= config.freezeGapMs ||
                summary.actualFps <= config.freezeFpsCeiling
        } ?? false)
        return MediaQualityObservationSignals(
            lossPressure: lossPressure,
            repairPressure: repairPressure,
            queuePressure: queuePressure,
            cadencePressure: cadencePressure,
            stalePressure: stalePressure,
            freezePressure: freezePressure,
            lossPermille: lossPermille
        )
    }

    private func recoveryBlocker(
        _ input: MediaQualityControllerInput,
        signals: MediaQualityObservationSignals
    ) -> String? {
        guard !signals.lossPressure,
              !signals.repairPressure,
              !signals.queuePressure,
              !signals.cadencePressure,
              !signals.stalePressure,
              !signals.freezePressure,
              input.staleRecoveryCount == 0,
              input.ackCount > 0
        else {
            return "recovery-wait-no-ack"
        }
        guard (input.sample.ackAgeP95Ms ?? Double.greatestFiniteMagnitude) < config.ackHoldP95Ms else {
            return "recovery-wait-ack"
        }
        // Recovery is gated on link health (loss, queue, stale, fast acks), not on
        // how many frames the screen produced. A calm screen yields sparse
        // production with clean acks, which is healthy: climb. Production cadence
        // (fps, gaps) reflects content activity, not link capacity, so it must not
        // block the climb, that was pinning resolution low whenever the user
        // stopped moving. A probe rolls back if a later motion burst reveals the
        // link cannot sustain the higher rung.
        return nil
    }

    private mutating func downshiftLoss(reason: String) {
        if target.bitrateKbps > config.floorKbps && target.rung <= .lossControl {
            let bitrate = max(config.floorKbps, Int((Double(target.bitrateKbps) * config.downStep).rounded()))
            target = target.with(
                bitrateKbps: bitrate,
                fps: config.fpsCeiling,
                resolutionScale: 1.0,
                rung: .lossControl,
                reason: reason
            )
            stableTarget = target
            clearProbe()
            return
        }
        downshiftCapacity(reason: target.rung >= .survival ? floorReason : "capacity-down")
    }

    private var floorReason: String {
        target.rung == .emergency ? "at-emergency-floor" : "at-survival-floor"
    }

    private mutating func downshiftCapacity(reason: String) {
        switch target.rung {
        case .native, .lossControl:
            target = fixedTarget(for: .capacity1, reason: reason)
        case .capacity1:
            target = fixedTarget(for: .capacity2, reason: reason)
        case .capacity2:
            target = fixedTarget(for: .survival, reason: "survival-down")
        case .survival:
            target = fixedTarget(for: .emergency, reason: "emergency-down")
        case .emergency:
            target = fixedTarget(for: .emergency, reason: "at-emergency-floor")
        }
        stableTarget = target
        clearProbe()
    }

    private mutating func recover() {
        if target.rung == .native {
            return
        }
        let canonical = fixedTarget(for: target.rung, reason: "quality-up")
        if target.bitrateKbps < canonical.bitrateKbps {
            recoverBitrate(toward: canonical.bitrateKbps)
            return
        }
        if target.resolutionScale < canonical.resolutionScale {
            beginProbe(
                target.with(resolutionScale: canonical.resolutionScale, reason: "quality-up"),
                axis: .resolution
            )
            return
        }
        if target.fps < canonical.fps {
            beginProbe(
                target.with(fps: canonical.fps, reason: "quality-up"),
                axis: .fps
            )
            return
        }

        let next = recoveryTarget(for: target.rung)
        if target.bitrateKbps < next.bitrateKbps {
            recoverBitrate(toward: next.bitrateKbps)
            return
        }
        if target.resolutionScale < next.resolutionScale {
            beginProbe(
                MediaQualityTarget(
                    bitrateKbps: next.bitrateKbps,
                    fps: target.fps,
                    resolutionScale: next.resolutionScale,
                    rung: next.rung,
                    reason: "quality-up"
                ),
                axis: .resolution
            )
            return
        }
        if target.fps < next.fps {
            beginProbe(
                MediaQualityTarget(
                    bitrateKbps: next.bitrateKbps,
                    fps: next.fps,
                    resolutionScale: next.resolutionScale,
                    rung: next.rung,
                    reason: "quality-up"
                ),
                axis: .fps
            )
            return
        }
        target = next.with(reason: "quality-up")
        stableTarget = target
        clearProbe()
    }

    private mutating func recoverBitrate(toward nextBitrateKbps: Int) {
        if target.bitrateKbps < nextBitrateKbps {
            let bitrate = min(nextBitrateKbps, Int((Double(target.bitrateKbps) * config.upStep).rounded()))
            target = target.with(bitrateKbps: bitrate, reason: "clean-up")
            stableTarget = target
            clearProbe()
            recoveryPhaseState = .bitrateRecovering
            return
        }
    }

    private mutating func beginProbe(_ nextTarget: MediaQualityTarget, axis: MediaQualityProbeAxis) {
        target = nextTarget
        probeAxis = axis
        recoveryPhaseState = axis == .resolution ? .resolutionProbe : .fpsProbe
        probeWindowsRemaining = config.raiseCleanWindows
        if axis == .resolution {
            warmupWindowsRemaining = config.transitionWarmupWindows
        } else {
            warmupWindowsRemaining = 0
        }
    }

    private mutating func rollbackProbe(axis: MediaQualityProbeAxis? = nil) {
        let rollbackAxis = axis ?? probeAxis
        target = stableTarget.with(reason: "probe-\(rollbackAxis.rawValue)-rollback")
        clearProbe()
        cleanRecoveryMs = 0
    }

    private mutating func markProbeStable() {
        stableTarget = target
        clearProbe()
    }

    private mutating func clearProbe() {
        probeAxis = .none
        probeWindowsRemaining = 0
        warmupWindowsRemaining = 0
        recoveryPhaseState = .steady
    }

    private func fixedTarget(for rung: MediaQualityRung, reason: String) -> MediaQualityTarget {
        switch rung {
        case .native:
            MediaQualityTarget(bitrateKbps: config.ceilingKbps, fps: config.fpsCeiling, resolutionScale: 1.0, rung: .native, reason: reason)
        case .lossControl:
            MediaQualityTarget(bitrateKbps: config.floorKbps, fps: config.fpsCeiling, resolutionScale: 1.0, rung: .lossControl, reason: reason)
        case .capacity1:
            MediaQualityTarget(bitrateKbps: config.capacity1Kbps, fps: config.capacity1Fps, resolutionScale: config.capacity1Scale, rung: .capacity1, reason: reason)
        case .capacity2:
            MediaQualityTarget(bitrateKbps: config.capacity2Kbps, fps: config.capacity2Fps, resolutionScale: config.capacity2Scale, rung: .capacity2, reason: reason)
        case .survival:
            MediaQualityTarget(bitrateKbps: config.survivalFloorKbps, fps: config.fpsFloor, resolutionScale: config.survivalScale, rung: .survival, reason: reason)
        case .emergency:
            MediaQualityTarget(bitrateKbps: config.emergencyKbps, fps: config.emergencyFps, resolutionScale: config.emergencyScale, rung: .emergency, reason: reason)
        }
    }

    private func recoveryTarget(for rung: MediaQualityRung) -> MediaQualityTarget {
        switch rung {
        case .emergency:
            fixedTarget(for: .survival, reason: "quality-up")
        case .survival:
            fixedTarget(for: .capacity2, reason: "quality-up")
        case .capacity2:
            fixedTarget(for: .capacity1, reason: "quality-up")
        case .capacity1:
            fixedTarget(for: .lossControl, reason: "quality-up")
        case .lossControl:
            fixedTarget(for: .native, reason: "quality-up")
        case .native:
            fixedTarget(for: .native, reason: "quality-up")
        }
    }

    private mutating func resetPressureStreaks() {
        cadencePressureStreak = 0
    }

    private mutating func resetRecovery() {
        cleanRecoveryMs = 0
        clearProbe()
    }

    private func recoveryStatus(blocker: String) -> MediaQualityRecoveryStatus {
        MediaQualityRecoveryStatus(
            cleanMs: cleanRecoveryMs,
            requiredMs: requiredRecoveryMs,
            blocker: blocker,
            probeWindowsRemaining: probeWindowsRemaining,
            phase: recoveryPhase(blocker: blocker),
            warmupWindowsRemaining: warmupWindowsRemaining,
            probeAxis: probeAxis,
            stableTarget: stableTarget
        )
    }

    private func recoveryPhase(blocker: String) -> MediaQualityRecoveryPhase {
        if blocker == "transition-warmup" {
            return .transitionWarmup
        }
        switch probeAxis {
        case .resolution:
            return .resolutionProbe
        case .fps:
            return .fpsProbe
        case .none:
            return recoveryPhaseState
        }
    }

    private func evaluation(
        signals: MediaQualityObservationSignals,
        previous: MediaQualityTarget,
        reason: String,
        recoveryBlocker: String
    ) -> MediaQualityEvaluation {
        MediaQualityEvaluation(
            signals: signals,
            outcome: MediaQualityOutcome(
                target: target.with(reason: reason),
                previousTarget: previous,
                reason: reason
            ),
            recoveryStatus: recoveryStatus(blocker: recoveryBlocker)
        )
    }
}

struct QuicSessionHostMediaState {
    enum Admission: Equatable {
        case ready(
            OwnedSurfaceUpdateId,
            abandoned: [GraphicsBackpressure.InFlightFrame]
        )
        case retry(afterNs: UInt64, reason: RetryReason)
    }

    enum RetryReason: String, Equatable {
        case capacity
    }

    enum KeyframeRequestAdmission: Equatable {
        case queued
        case suppressedInFlight(frameId: UInt64)
    }

    private var nextFrameId: UInt64 = 0
    private var lastProduceUptimeNs: UInt64?
    private var backpressure: GraphicsBackpressure
    private let qualityControllerConfig: MediaQualityControllerConfig
    private var qualityController: MediaQualityController
    private var resendRing: OwnedMediaResendRing
    private let expectedFrameRate: Int
    private var pendingClientKeyframeRequest = false
    private var keyframeInFlight: UInt64?
    private var resendRequestsInWindow = 0
    private var keyframeRequestsInWindow = 0
    private var ackAgesMs: [Double] = []
    private var staleRecoveryCountInWindow = 0
    private var replacedCapturesInWindow = 0
    private var abandonedBytesInWindow = 0
    private var resendPacketsServedInWindow = 0
    private var resendPacketsMissedInWindow = 0
    private var qualityWindowId: UInt64 = 0
    private var adaptiveQualityEnabled = true
    // ADR-0087: rate limit for the keyframe half of stall recovery. Nil until the first
    // one, so a session's first stall recovers immediately rather than serving out a
    // limit window it never used.
    private var lastStallRecoveryKeyframeNs: UInt64?
    private let stallRecoveryMinIntervalNs: UInt64
    // ADR-0088: cross-window smoothed/minimum round-trip, the queueing detector. Distinct
    // from the per-window ack percentiles, which cannot see inflation.
    private(set) var roundTrip: AckRoundTripTracker

    init(
        maxInflightFrames: Int = Config.ownedMediaBackpressureMaxInflightFrames,
        maxInflightBytes: Int = Config.ownedMediaBackpressureMaxInflightBytes,
        expectedFrameRate: Int = Config.ownedMediaExpectedFrameRate,
        qualityControllerConfig: MediaQualityControllerConfig = .fromConfig(),
        qualityController: MediaQualityController? = nil,
        resendRingFrames: Int = Config.ownedMediaResendRingFrames,
        stallRecoveryMinIntervalMs: Int = Config.ownedMediaStallRecoveryMinIntervalMs,
        roundTripMinimumWindowMs: Int = Config.ownedMediaRoundTripMinimumWindowMs
    ) {
        self.stallRecoveryMinIntervalNs = UInt64(max(0, stallRecoveryMinIntervalMs)) * 1_000_000
        self.roundTrip = AckRoundTripTracker(minimumWindowMs: roundTripMinimumWindowMs)
        self.backpressure = GraphicsBackpressure(
            maxUnacked: maxInflightFrames,
            maxUnackedBytes: maxInflightBytes
        )
        self.expectedFrameRate = max(1, expectedFrameRate)
        self.qualityControllerConfig = qualityControllerConfig
        self.qualityController = qualityController ?? MediaQualityController(config: qualityControllerConfig)
        self.resendRing = OwnedMediaResendRing(capacityFrames: resendRingFrames)
    }

    var targetKbps: Int { qualityController.targetKbps }
    var targetFps: Int { qualityController.targetFps }
    var targetResolutionScale: Double { qualityController.targetResolutionScale }
    var inFlightFrames: Int { backpressure.inFlight }
    var inFlightBytes: Int { backpressure.bytesInFlight }

    mutating func noteCaptureReplaced() {
        replacedCapturesInWindow += 1
    }

    mutating func applyClientMediaQuality(_ config: ClientMediaQualityConfig) -> MediaQualityOutcome? {
        let previous = qualityController.target
        if config.adaptiveEnabled {
            guard !adaptiveQualityEnabled else { return nil }
            adaptiveQualityEnabled = true
            qualityController = MediaQualityController(config: qualityControllerConfig)
            resetForQualityChange()
            clearQualityWindow()
            let target = qualityController.target.with(reason: "adaptive-quality-enabled")
            return MediaQualityOutcome(
                target: target,
                previousTarget: previous,
                reason: target.reason
            )
        }

        let target = manualTarget(from: config.fixedTarget, reason: "manual-quality-fixed")
        guard adaptiveQualityEnabled || !sameQualityTarget(previous, target) else {
            return nil
        }
        adaptiveQualityEnabled = false
        qualityController = MediaQualityController(config: qualityControllerConfig)
        qualityController.pin(to: target)
        resetForQualityChange()
        clearQualityWindow()
        return MediaQualityOutcome(
            target: target,
            previousTarget: previous,
            reason: target.reason
        )
    }

    mutating func reserveUpdateId(nowNs: UInt64) -> Admission {
        if let last = lastProduceUptimeNs {
            let interval = capacityIntervalNs()
            if interval > 0, nowNs &- last < interval {
                return .retry(afterNs: interval - (nowNs &- last), reason: .capacity)
            }
        }
        let abandoned = backpressure.abandonUntilCanProduce()
        if let inFlightKeyframe = keyframeInFlight,
           abandoned.contains(where: { $0.id == inFlightKeyframe }) {
            keyframeInFlight = nil
        }
        if !abandoned.isEmpty {
            staleRecoveryCountInWindow += abandoned.count
            abandonedBytesInWindow += abandoned.reduce(0) { $0 + $1.bytes }
        }
        nextFrameId &+= 1
        lastProduceUptimeNs = nowNs
        return .ready(
            OwnedSurfaceUpdateId(surfaceGeneration: 1, frameId: nextFrameId),
            abandoned: abandoned
        )
    }

    mutating func noteSent(
        frameId: UInt64,
        encodedBytes: Int,
        packets: [Data],
        isKeyframe: Bool = false,
        sentAtUptimeNs: UInt64 = DispatchTime.now().uptimeNanoseconds
    ) {
        backpressure.noteSent(frameId: frameId, bytes: encodedBytes, sentAtUptimeNs: sentAtUptimeNs)
        if isKeyframe {
            keyframeInFlight = frameId
        }
        resendRing.remember(frameId: frameId, packets: packets)
    }

    @discardableResult
    mutating func noteAck(frameId: UInt64, nowNs: UInt64 = DispatchTime.now().uptimeNanoseconds) -> Double? {
        guard let sentAtUptimeNs = backpressure.noteAck(frameId: frameId) else { return nil }
        if let inFlight = keyframeInFlight, frameId >= inFlight {
            keyframeInFlight = nil
        }
        let ageNs = nowNs >= sentAtUptimeNs ? nowNs - sentAtUptimeNs : 0
        let ageMs = Double(ageNs) / 1_000_000.0
        ackAgesMs.append(ageMs)
        // ADR-0088: the same sample feeds the cross-window queueing detector. The per-window
        // percentiles above describe the current level; only the tracker knows whether that
        // level is inflated relative to the path's own floor.
        roundTrip.record(rttMs: ageMs, nowNs: nowNs)
        return ageMs
    }

    mutating func packetsForResend(
        frameId: UInt64,
        indexes: [UInt16],
        maxCount: Int
    ) -> (packets: [(UInt16, Data)], misses: [UInt16]) {
        let result = resendRing.packets(frameId: frameId, indexes: indexes, maxCount: maxCount)
        resendPacketsServedInWindow += result.packets.count
        resendPacketsMissedInWindow += result.misses.count
        return result
    }

    mutating func noteResendRequest() {
        resendRequestsInWindow += 1
    }

    mutating func noteKeyframeRequest() -> KeyframeRequestAdmission {
        keyframeRequestsInWindow += 1
        if let keyframeInFlight {
            return .suppressedInFlight(frameId: keyframeInFlight)
        }
        pendingClientKeyframeRequest = true
        return .queued
    }

    mutating func resetForQualityChange() {
        backpressure.reset()
        pendingClientKeyframeRequest = false
        keyframeInFlight = nil
    }

    mutating func observeLinkHealth(
        completedFrames: Int,
        expiredFrames: Int,
        productionSummary: MediaProductionSummary?,
        clientReportMissing: Bool = false,
        clientTelemetry: OwnedMediaLinkTelemetry? = nil,
        reportIntervalMs: Int = Config.ownedMediaClientReportIntervalMs,
        nowNs: UInt64 = DispatchTime.now().uptimeNanoseconds
    ) -> MediaQualityDecision {
        qualityWindowId &+= 1
        // ADR-0088: age the round-trip floor on the window boundary, not only on new samples.
        // A freeze produces no acks at all, so a floor that could only expire inside
        // `record` would stay pinned to a pre-freeze value for the whole stall -- the one
        // stretch where the ratio most needs to be honest about how old its baseline is.
        roundTrip.expireMinimumCandidates(nowNs: nowNs)
        let ackStats = ackAgeStats()
        let sample = MediaQualitySample(
            completedFrames: completedFrames,
            expiredFrames: expiredFrames,
            resendRequests: resendRequestsInWindow,
            keyframeRequests: keyframeRequestsInWindow,
            ackAgeP50Ms: ackStats.p50,
            ackAgeP95Ms: ackStats.p95
        )
        // One input for both modes. The manual branch used to skip building this and
        // hand-assemble its signals with four of the six hardcoded false, so a manually
        // pinned stream logged `queuePressure=false freezePressure=false` through a
        // measured 12.79s freeze. Signals are derived by the controller either way now.
        let oldestInflightMs = backpressure.oldestSentUptimeNs.map { sentNs in
            Double(nowNs >= sentNs ? nowNs - sentNs : 0) / 1_000_000.0
        }
        let input = MediaQualityControllerInput(
            sample: sample,
            productionSummary: productionSummary,
            ackCount: ackStats.count,
            ackAgeMaxMs: ackStats.max,
            inFlightFrames: backpressure.inFlight,
            inFlightBytes: backpressure.bytesInFlight,
            oldestInflightMs: oldestInflightMs,
            staleRecoveryCount: staleRecoveryCountInWindow,
            clientReportMissing: clientReportMissing,
            clientLinkStalled: MediaQualityController.clientLinkStalled(
                telemetry: clientTelemetry,
                reportIntervalMs: reportIntervalMs
            )
        )

        if !adaptiveQualityEnabled {
            let target = qualityController.target.with(reason: "manual-quality-fixed")
            let signals = qualityController.makeSignals(input)
            let observation = MediaQualityObservation(
                windowId: qualityWindowId,
                sample: sample,
                previousTarget: target,
                productionSummary: productionSummary,
                ackCount: input.ackCount,
                ackAgeMaxMs: input.ackAgeMaxMs,
                inFlightFrames: input.inFlightFrames,
                inFlightBytes: input.inFlightBytes,
                oldestInflightMs: input.oldestInflightMs,
                staleRecoveryCount: input.staleRecoveryCount,
                freshness: freshnessSummary(),
                signals: signals,
                recoveryStatus: qualityController.currentRecoveryStatus
            )
            // Observation first, recovery second: the flush zeroes the in-flight counters
            // that are the evidence this window is the one that stalled.
            let recovery = recoverFromStall(input: input, signals: signals, nowNs: nowNs)
            clearQualityWindow()
            return MediaQualityDecision(
                observation: observation,
                outcome: MediaQualityOutcome(
                    target: target,
                    previousTarget: target,
                    reason: "manual-quality-fixed"
                ),
                stallRecovery: recovery
            )
        }

        let evaluation = qualityController.observe(input)
        let observation = MediaQualityObservation(
            windowId: qualityWindowId,
            sample: sample,
            previousTarget: evaluation.outcome.previousTarget,
            productionSummary: productionSummary,
            ackCount: input.ackCount,
            ackAgeMaxMs: input.ackAgeMaxMs,
            inFlightFrames: input.inFlightFrames,
            inFlightBytes: input.inFlightBytes,
            oldestInflightMs: input.oldestInflightMs,
            staleRecoveryCount: input.staleRecoveryCount,
            freshness: freshnessSummary(),
            signals: evaluation.signals,
            recoveryStatus: evaluation.recoveryStatus
        )
        // Adaptive gets the same recovery. It used to obtain the flush and the keyframe as
        // a side effect of `outcome.resolutionChanged`, which is why it recovered at all;
        // making it explicit means a rung that holds still recovers.
        let recovery = recoverFromStall(input: input, signals: evaluation.signals, nowNs: nowNs)
        clearQualityWindow()
        return MediaQualityDecision(
            observation: observation,
            outcome: evaluation.outcome,
            stallRecovery: recovery
        )
    }

    /// ADR-0087: unjam a stalled link, in either quality mode.
    ///
    /// The flush is the load-bearing half. `abandonUntilCanProduce` only ever drops one
    /// entry per produced frame, so once the cap fills it stays full and every subsequent
    /// ACK lands on an entry that was already abandoned — which `noteAck` correctly
    /// discards, taking the ACK-age telemetry with it. Flushing restores admission and
    /// lets the next real ACK be measured again. It costs nothing on the wire.
    ///
    /// The keyframe is the expensive half and is rate-limited separately.
    private mutating func recoverFromStall(
        input: MediaQualityControllerInput,
        signals: MediaQualityObservationSignals,
        nowNs: UInt64
    ) -> MediaStallRecovery? {
        // `jammed` catches the case the pressure classes cannot: a client that went silent
        // reports no loss and no expiry, so only the shape of the host's own in-flight
        // list says anything. No ACKs at all while admission is closed is that shape.
        // Asking `canProduce` rather than comparing the frame count keeps this agreeing
        // with the actual admission rule, which gates on the byte ceiling too.
        let jammed = input.ackCount == 0 && !backpressure.canProduce()
        let reason: String
        if signals.freezePressure {
            reason = "freeze"
        } else if jammed {
            reason = "no-ack-at-cap"
        } else if signals.stalePressure {
            reason = "stale"
        } else {
            return nil
        }

        let flushedFrames = backpressure.inFlight
        let flushedBytes = backpressure.bytesInFlight
        backpressure.reset()

        // Withhold the keyframe while one is already in flight (it is the recovery, and a
        // second would only compete with it for the same starved link), and while the rate
        // limit has not elapsed.
        var forcedKeyframe = false
        if keyframeInFlight == nil,
           lastStallRecoveryKeyframeNs.map({ nowNs &- $0 >= stallRecoveryMinIntervalNs }) ?? true {
            forcedKeyframe = true
            lastStallRecoveryKeyframeNs = nowNs
        }
        // Those frames are gone from the accounting; a later ACK cannot retire them.
        keyframeInFlight = nil

        return MediaStallRecovery(
            reason: reason,
            flushedFrames: flushedFrames,
            flushedBytes: flushedBytes,
            forcedKeyframe: forcedKeyframe
        )
    }

    mutating func takeClientKeyframeRequest() -> Bool {
        let shouldForceKeyframe = pendingClientKeyframeRequest
        pendingClientKeyframeRequest = false
        return shouldForceKeyframe
    }

    private func capacityIntervalNs() -> UInt64 {
        let fps = qualityController.targetFps
        guard fps > 0, fps < expectedFrameRate else { return 0 }
        return UInt64(1_000_000_000 / fps)
    }

    private func manualTarget(from clientTarget: ClientMediaQualityTarget?, reason: String) -> MediaQualityTarget {
        let bitrate = clientTarget?.bitrateKbps ?? qualityControllerConfig.ceilingKbps
        let fps = clientTarget?.fps ?? qualityControllerConfig.fpsCeiling
        let scale = clientTarget?.resolutionScale ?? 1.0
        return MediaQualityTarget(
            bitrateKbps: min(max(bitrate, 1), 20_000),
            fps: min(max(fps, 1), expectedFrameRate),
            resolutionScale: min(max(scale, 0.1), 1.0),
            rung: .native,
            reason: reason
        )
    }

    private func sameQualityTarget(_ lhs: MediaQualityTarget, _ rhs: MediaQualityTarget) -> Bool {
        lhs.bitrateKbps == rhs.bitrateKbps &&
            lhs.fps == rhs.fps &&
            lhs.resolutionScale == rhs.resolutionScale &&
            lhs.rung == rhs.rung
    }

    private func percentile(_ fraction: Double) -> Double? {
        guard !ackAgesMs.isEmpty else { return nil }
        let sorted = ackAgesMs.sorted()
        let clamped = min(max(fraction, 0), 1)
        let index = min(sorted.count - 1, Int((Double(sorted.count - 1) * clamped).rounded(.up)))
        return sorted[index]
    }

    private func ackAgeStats() -> (count: Int, p50: Double?, p95: Double?, max: Double?) {
        guard !ackAgesMs.isEmpty else {
            return (0, nil, nil, nil)
        }
        return (
            ackAgesMs.count,
            percentile(0.50),
            percentile(0.95),
            ackAgesMs.max()
        )
    }

    private mutating func clearQualityWindow() {
        resendRequestsInWindow = 0
        keyframeRequestsInWindow = 0
        staleRecoveryCountInWindow = 0
        replacedCapturesInWindow = 0
        abandonedBytesInWindow = 0
        resendPacketsServedInWindow = 0
        resendPacketsMissedInWindow = 0
        ackAgesMs.removeAll(keepingCapacity: true)
    }

    private func freshnessSummary() -> MediaFreshnessDiagnosticsSummary {
        MediaFreshnessDiagnosticsSummary(
            replacedCaptures: replacedCapturesInWindow,
            abandonedFrames: staleRecoveryCountInWindow,
            abandonedBytes: abandonedBytesInWindow,
            resendPacketsServed: resendPacketsServedInWindow,
            resendPacketsMissed: resendPacketsMissedInWindow
        )
    }
}
