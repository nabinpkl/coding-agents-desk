import Foundation

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

    init(
        sample: MediaQualitySample,
        productionSummary: MediaProductionSummary? = nil,
        ackCount: Int = 0,
        ackAgeMaxMs: Double? = nil,
        inFlightFrames: Int = 0,
        inFlightBytes: Int = 0,
        oldestInflightMs: Double? = nil,
        staleRecoveryCount: Int = 0
    ) {
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

struct MediaQualityRecoveryStatus: Equatable {
    let cleanMs: Int
    let requiredMs: Int
    let blocker: String
    let probeWindowsRemaining: Int
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
    private let config: MediaQualityControllerConfig
    private(set) var target: MediaQualityTarget
    private var cleanRecoveryMs = 0
    private var cadencePressureStreak = 0
    private var probeWindowsRemaining = 0

    init(config: MediaQualityControllerConfig) {
        self.config = config
        self.target = MediaQualityTarget(
            bitrateKbps: config.ceilingKbps,
            fps: config.fpsCeiling,
            resolutionScale: 1.0,
            rung: .native,
            reason: "initial"
        )
    }

    var targetKbps: Int { target.bitrateKbps }
    var targetFps: Int { target.fps }
    var targetResolutionScale: Double { target.resolutionScale }
    var requiredRecoveryMs: Int { config.raiseCleanWindows * 1_000 }

    mutating func observe(_ input: MediaQualityControllerInput) -> MediaQualityEvaluation {
        let previous = target
        let signals = makeSignals(input)
        let total = input.sample.completedFrames + input.sample.expiredFrames
        guard total > 0 else {
            resetPressureStreaks()
            resetRecovery()
            return evaluation(signals: signals, previous: previous, reason: "idle", recoveryBlocker: "idle")
        }

        if signals.freezePressure {
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

        if signals.queuePressure && signals.cadencePressure {
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
            let wasRecoveryProbe = probeWindowsRemaining > 0
            resetRecovery()
            if wasRecoveryProbe {
                resetPressureStreaks()
                downshiftCapacity(reason: "probe-cadence-down")
                return evaluation(
                    signals: signals,
                    previous: previous,
                    reason: target == previous ? floorReason : target.reason,
                    recoveryBlocker: "probe-cadence-pressure"
                )
            }
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

        if signals.lossPressure {
            resetRecovery()
            downshiftLoss(reason: "loss-down")
            return evaluation(
                signals: signals,
                previous: previous,
                reason: target == previous ? floorReason : target.reason,
                recoveryBlocker: "loss-pressure"
            )
        }

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

        let productionWindowMs = max(input.productionSummary?.windowMs ?? 0, 1)
        cleanRecoveryMs += productionWindowMs
        if probeWindowsRemaining > 0 {
            probeWindowsRemaining -= 1
        }
        if cleanRecoveryMs >= requiredRecoveryMs {
            cleanRecoveryMs = 0
            recover()
            if target.rung != previous.rung {
                probeWindowsRemaining = config.raiseCleanWindows
            }
            return evaluation(
                signals: signals,
                previous: previous,
                reason: target == previous ? "at-native" : target.reason,
                recoveryBlocker: target == previous ? "at-native" : "none"
            )
        }
        return evaluation(signals: signals, previous: previous, reason: "clean-hold", recoveryBlocker: "none")
    }

    private func makeSignals(_ input: MediaQualityControllerInput) -> MediaQualityObservationSignals {
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
        let cadencePressure = input.productionSummary.map { summary in
            summary.fpsDeficit * 2 >= max(summary.targetFps, 1) ||
                summary.maxGapMs >= config.cadenceGapMs
        } ?? false
        let freezePressure = input.productionSummary.map { summary in
            summary.maxGapMs >= config.freezeGapMs ||
                summary.actualFps <= config.freezeFpsCeiling
        } ?? false
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
        guard let production = input.productionSummary else {
            return "recovery-wait-no-production"
        }
        let fpsPermille = (production.actualFps * 1_000) / max(production.targetFps, 1)
        guard fpsPermille >= config.recoveryMinFpsPermille else {
            return "recovery-wait-fps"
        }
        guard production.maxGapMs <= config.recoveryMaxGapMs else {
            return "recovery-wait-gap"
        }
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
    }

    private mutating func recover() {
        if target.rung == .native {
            return
        }
        let next = recoveryTarget(for: target.rung)
        if target.bitrateKbps < next.bitrateKbps {
            let bitrate = min(next.bitrateKbps, Int((Double(target.bitrateKbps) * config.upStep).rounded()))
            target = target.with(bitrateKbps: bitrate, reason: "clean-up")
            return
        }
        target = next.with(reason: "quality-up")
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
        probeWindowsRemaining = 0
    }

    private func recoveryStatus(blocker: String) -> MediaQualityRecoveryStatus {
        MediaQualityRecoveryStatus(
            cleanMs: cleanRecoveryMs,
            requiredMs: requiredRecoveryMs,
            blocker: blocker,
            probeWindowsRemaining: probeWindowsRemaining
        )
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
        case ready(OwnedSurfaceUpdateId)
        case retry(afterNs: UInt64, reason: RetryReason)
    }

    enum RetryReason: String, Equatable {
        case capacity
        case backpressure
    }

    enum KeyframeRequestAdmission: Equatable {
        case queued
        case suppressedInFlight(frameId: UInt64)
    }

    private var nextFrameId: UInt64 = 0
    private var lastProduceUptimeNs: UInt64?
    private var backpressure: GraphicsBackpressure
    private var qualityController: MediaQualityController
    private var resendRing: OwnedMediaResendRing
    private let expectedFrameRate: Int
    private let retryIntervalNs: UInt64
    private let staleInflightTimeoutNs: UInt64
    private var pendingClientKeyframeRequest = false
    private var keyframeInFlight: UInt64?
    private var resendRequestsInWindow = 0
    private var keyframeRequestsInWindow = 0
    private var ackAgesMs: [Double] = []
    private var staleRecoveryCountInWindow = 0
    private var qualityWindowId: UInt64 = 0

    init(
        maxInflightFrames: Int = Config.ownedMediaBackpressureMaxInflightFrames,
        maxInflightBytes: Int = Config.ownedMediaBackpressureMaxInflightBytes,
        expectedFrameRate: Int = Config.ownedMediaExpectedFrameRate,
        qualityController: MediaQualityController = MediaQualityController(config: .fromConfig()),
        resendRingFrames: Int = Config.ownedMediaResendRingFrames,
        retryIntervalNs: UInt64 = UInt64(Config.ownedMediaDrainRetryIntervalMs) * 1_000_000,
        staleInflightTimeoutNs: UInt64 = UInt64(Config.ownedMediaBackpressureStaleTimeoutMs) * 1_000_000
    ) {
        self.backpressure = GraphicsBackpressure(
            maxUnacked: maxInflightFrames,
            maxUnackedBytes: maxInflightBytes
        )
        self.expectedFrameRate = max(1, expectedFrameRate)
        self.qualityController = qualityController
        self.resendRing = OwnedMediaResendRing(capacityFrames: resendRingFrames)
        self.retryIntervalNs = max(1, retryIntervalNs)
        self.staleInflightTimeoutNs = max(1, staleInflightTimeoutNs)
    }

    var targetKbps: Int { qualityController.targetKbps }
    var targetFps: Int { qualityController.targetFps }
    var targetResolutionScale: Double { qualityController.targetResolutionScale }
    var inFlightFrames: Int { backpressure.inFlight }
    var inFlightBytes: Int { backpressure.bytesInFlight }

    mutating func reserveUpdateId(nowNs: UInt64) -> Admission {
        if !backpressure.canProduce() {
            if let oldestSentUptimeNs = backpressure.oldestSentUptimeNs {
                let ageNs = nowNs >= oldestSentUptimeNs ? nowNs - oldestSentUptimeNs : 0
                if ageNs >= staleInflightTimeoutNs {
                    backpressure.reset()
                    keyframeInFlight = nil
                    staleRecoveryCountInWindow += 1
                } else {
                    return .retry(
                        afterNs: min(retryIntervalNs, staleInflightTimeoutNs - ageNs),
                        reason: .backpressure
                    )
                }
            } else {
                return .retry(afterNs: retryIntervalNs, reason: .backpressure)
            }
        }
        if let last = lastProduceUptimeNs {
            let interval = capacityIntervalNs()
            if interval > 0, nowNs &- last < interval {
                return .retry(afterNs: interval - (nowNs &- last), reason: .capacity)
            }
        }
        nextFrameId &+= 1
        lastProduceUptimeNs = nowNs
        return .ready(OwnedSurfaceUpdateId(surfaceGeneration: 1, frameId: nextFrameId))
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
        return ageMs
    }

    mutating func packetsForResend(
        frameId: UInt64,
        indexes: [UInt16],
        maxCount: Int
    ) -> (packets: [(UInt16, Data)], misses: [UInt16]) {
        resendRing.packets(frameId: frameId, indexes: indexes, maxCount: maxCount)
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
        nowNs: UInt64 = DispatchTime.now().uptimeNanoseconds
    ) -> MediaQualityDecision {
        qualityWindowId &+= 1
        let ackStats = ackAgeStats()
        let sample = MediaQualitySample(
            completedFrames: completedFrames,
            expiredFrames: expiredFrames,
            resendRequests: resendRequestsInWindow,
            keyframeRequests: keyframeRequestsInWindow,
            ackAgeP50Ms: ackStats.p50,
            ackAgeP95Ms: ackStats.p95
        )
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
            staleRecoveryCount: staleRecoveryCountInWindow
        )
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
            signals: evaluation.signals,
            recoveryStatus: evaluation.recoveryStatus
        )
        resendRequestsInWindow = 0
        keyframeRequestsInWindow = 0
        staleRecoveryCountInWindow = 0
        ackAgesMs.removeAll(keepingCapacity: true)
        return MediaQualityDecision(
            observation: observation,
            outcome: evaluation.outcome
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
}
