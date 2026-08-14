import Foundation
import AgentDeskWire

// ADR-0033: one host-owned media-quality controller chooses bitrate, fps, and
// capture resolution together from link-health and production smoothness.
enum MediaQualityRung: Int, Equatable, Comparable, Sendable {
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

struct MediaQualityTarget: Equatable, Sendable {
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

/// ADR-0098: what the LINK did this window, as opposed to what the host produced.
///
/// These were one type with production, and the fusion is what let the measured freeze go
/// unanswered. A freeze is precisely the window where the two halves disagree: the host
/// produced six frames dead on cadence and the client received none of them. With one type
/// there was nowhere for that disagreement to live, so the controller read a delivery failure
/// as a quiet screen and held its rung -- 25 windows of it in one 45-minute log.
///
/// The ordering rule this type exists to enforce: **the link's state is asked about before the
/// frame count.** A count of zero means the link resolved nothing, not that nothing was made.
struct MediaDeliveryObservation: Equatable {
    /// What the link resolved: completions, expiries, and the client's repair requests.
    let sample: MediaQualitySample
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
    // ADR-0098: the link's measured capacity, in bytes per second, from the bytes acks retired
    // (`LinkDeliveryEstimator`). nil means unknown -- no backlogged slice has completed -- which
    // is NOT the same as zero and must never be read as one.
    let deliveredBytesPerSecond: Double?
    // ADR-0088 built this and spent it on a log line. How many times the smoothed round-trip
    // exceeds the path's own floor: 1.0 is an empty queue, and it read 5.0 through the freeze.
    let roundTripInflationRatio: Double?

    init(
        sample: MediaQualitySample,
        ackCount: Int = 0,
        ackAgeMaxMs: Double? = nil,
        inFlightFrames: Int = 0,
        inFlightBytes: Int = 0,
        oldestInflightMs: Double? = nil,
        staleRecoveryCount: Int = 0,
        clientReportMissing: Bool = false,
        clientLinkStalled: Bool = false,
        deliveredBytesPerSecond: Double? = nil,
        roundTripInflationRatio: Double? = nil
    ) {
        self.clientReportMissing = clientReportMissing
        self.clientLinkStalled = clientLinkStalled
        self.deliveredBytesPerSecond = deliveredBytesPerSecond
        self.roundTripInflationRatio = roundTripInflationRatio
        self.sample = sample
        self.ackCount = max(0, ackCount)
        self.ackAgeMaxMs = ackAgeMaxMs
        self.inFlightFrames = max(0, inFlightFrames)
        self.inFlightBytes = max(0, inFlightBytes)
        self.oldestInflightMs = oldestInflightMs
        self.staleRecoveryCount = max(0, staleRecoveryCount)
    }

    /// Frames the link resolved one way or the other this window.
    ///
    /// Named for what it is, because the name it did not have is the bug: zero here was read as
    /// "the host made nothing", when it equally describes a link that acknowledged nothing.
    var resolvedFrames: Int { sample.completedFrames + sample.expiredFrames }

    /// The link is failing to deliver, on positive evidence rather than on absence of it.
    ///
    /// `clientReportMissing` is deliberately NOT grounds here even though it also means we are
    /// flying blind. A client that has gone quiet tells us nothing either way, and ADR-0087
    /// already spends that signal correctly by blocking the climb; descending on it would let a
    /// merely slow reporter walk the ladder to the floor. We descend on evidence of failure,
    /// never on the absence of evidence of health -- the same asymmetry `clientLinkStalled`
    /// itself is built on.
    var isStalled: Bool { clientLinkStalled }

    /// ADR-0098: the link measurably cannot carry the rung we are asking it for.
    ///
    /// The one statement in this whole struct made in the link's own units rather than in the
    /// host's. Everything else here is a symptom of a link that fell behind -- acks aging,
    /// frames expiring, the client going quiet. This is the shortfall itself.
    ///
    /// Unknown is not shortfall. A nil estimate means no backlogged slice has completed, which
    /// happens on a calm screen and at the start of every connection; descending on it would
    /// punish a link for being asked to carry nothing.
    func isBelowBudget(bitrateKbps: Int, ratio: Double) -> Bool {
        guard let deliveredBytesPerSecond else { return false }
        return deliveredBytesPerSecond < Double(max(1, bitrateKbps)) * 1_000.0 / 8.0 * ratio
    }

    /// ADR-0098: the queue in front of us is deep enough that sending more only adds delay.
    ///
    /// The failure `isBelowBudget` cannot see. A path that delivers everything, at its full rate,
    /// several seconds late shows a healthy goodput, no expiries and no stale frames -- and a
    /// picture on the phone that is seconds behind the Mac. Only the round-trip's distance from
    /// its own floor says so, which is what ADR-0088 built the tracker to measure.
    func isQueueBloated(ratio: Double) -> Bool {
        guard let roundTripInflationRatio else { return false }
        return roundTripInflationRatio >= ratio
    }
}

struct MediaQualityControllerInput: Equatable {
    let delivery: MediaDeliveryObservation
    /// What the HOST produced: its own capture and encode cadence.
    ///
    /// Never on its own evidence that the link is failing. A settled screen legitimately
    /// produces nothing, and during the measured freeze this side read perfectly healthy --
    /// `actualFps=6 targetFps=6 fpsDeficit=0` -- while nothing at all was arriving.
    let production: MediaProductionSummary?

    init(delivery: MediaDeliveryObservation, production: MediaProductionSummary? = nil) {
        self.delivery = delivery
        self.production = production
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
    let staleDownWindows: Int
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
    let resolutionDownDwellMs: Int
    let resolutionRaiseCleanMs: Int
    // ADR-0098: the fraction of the rung's own budget the link must be measurably delivering.
    let deliveryShortfallRatio: Double
    let deliveryShortfallWindows: Int
    // ADR-0098: how far the smoothed round-trip may sit above the path's floor. Shares
    // `deliveryShortfallWindows` for its streak -- "one window is a burst, two is a link" is the
    // same claim for both -- but counts it separately, so neither signal spends the other's run.
    let roundTripInflationDownRatio: Double

    init(
        ceilingKbps: Int,
        floorKbps: Int,
        survivalFloorKbps: Int,
        downStep: Double,
        upStep: Double,
        lossDownPermille: Int,
        raiseCleanWindows: Int,
        cadenceDownWindows: Int,
        staleDownWindows: Int = Config.ownedMediaStaleDownWindows,
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
        survivalScale: Double,
        resolutionDownDwellMs: Int = Config.ownedMediaResolutionDownDwellMs,
        resolutionRaiseCleanMs: Int = Config.ownedMediaResolutionRaiseCleanMs,
        deliveryShortfallRatio: Double = Config.ownedMediaDeliveryShortfallRatio,
        deliveryShortfallWindows: Int = Config.ownedMediaDeliveryShortfallWindows,
        roundTripInflationDownRatio: Double = Config.ownedMediaRoundTripInflationDownRatio
    ) {
        self.ceilingKbps = max(1, ceilingKbps)
        self.floorKbps = min(max(1, floorKbps), self.ceilingKbps)
        self.survivalFloorKbps = min(max(1, survivalFloorKbps), self.floorKbps)
        self.downStep = min(max(downStep, 0.01), 0.99)
        self.upStep = max(upStep, 1.01)
        self.lossDownPermille = max(1, lossDownPermille)
        self.raiseCleanWindows = max(1, raiseCleanWindows)
        self.cadenceDownWindows = max(1, cadenceDownWindows)
        self.staleDownWindows = max(1, staleDownWindows)
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
        self.resolutionDownDwellMs = max(0, resolutionDownDwellMs)
        self.resolutionRaiseCleanMs = max(0, resolutionRaiseCleanMs)
        // Clamped below 1.0 deliberately. At 1.0 the rule reads "descend unless the link is
        // delivering every byte we asked for", which no healthy link does continuously, so the
        // ladder would walk itself to the floor on a link that was fine.
        self.deliveryShortfallRatio = min(max(0.05, deliveryShortfallRatio), 0.95)
        self.deliveryShortfallWindows = max(1, deliveryShortfallWindows)
        // Floored above 1.0, because 1.0 is an empty queue by definition: at or below it the rule
        // reads "descend whenever the path has any latency at all", which is always.
        self.roundTripInflationDownRatio = max(1.01, roundTripInflationDownRatio)
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
            staleDownWindows: Config.ownedMediaStaleDownWindows,
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
            survivalScale: Config.ownedMediaSurvivalResolutionScale,
            resolutionDownDwellMs: Config.ownedMediaResolutionDownDwellMs,
            resolutionRaiseCleanMs: Config.ownedMediaResolutionRaiseCleanMs,
            deliveryShortfallRatio: Config.ownedMediaDeliveryShortfallRatio,
            deliveryShortfallWindows: Config.ownedMediaDeliveryShortfallWindows,
            roundTripInflationDownRatio: Config.ownedMediaRoundTripInflationDownRatio
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
    ///
    /// The same trap reaches the arrivals clause by a second route, which the first device run
    /// caught: on a calm screen the host sends nothing, so the client receives nothing and
    /// reports `datagramsReceived == 0` with a gap spanning the whole window. 27 windows of
    /// that session matched, every one of them healthy. Counting them as stalls wipes the idle
    /// recovery credit that lets the ladder climb back after a downgrade.
    ///
    /// Gap magnitude alone cannot separate the two, because an idle Mac with nobody at the
    /// keyboard reports an arbitrarily long gap for the same innocent reason. The discriminator
    /// is whether the client's silence is longer than *our own*: if we were putting frames on
    /// the wire while they heard nothing, the link ate them. If we were equally quiet, they
    /// heard nothing because there was nothing to hear.
    ///
    /// So the arrivals clause fires only when the client's gap exceeds the host's quiet period
    /// by more than a report interval. Worked through:
    ///
    /// - calm screen (measured): host quiet 686ms, client gap 686ms -> not a stall;
    /// - live freeze: host sending continuously (quiet ~100ms), client gap 12790ms -> stall;
    /// - freeze after the host gave up: host quiet 1500ms, client gap 12790ms -> stall;
    /// - user away: host quiet 30s, client gap 30s -> not a stall.
    ///
    /// The path clause has no such gate, because an unsatisfied path is real evidence the link
    /// is gone whether or not we were sending on it.
    static func clientLinkStalled(
        telemetry: OwnedMediaLinkTelemetry?,
        reportIntervalMs: Int,
        hostQuietMs: Double?
    ) -> Bool {
        guard let telemetry else { return false }
        if let status = telemetry.pathStatus, status != "satisfied" { return true }
        let intervalMs = Double(max(1, reportIntervalMs))
        guard let arrivals = telemetry.datagramsReceived,
              arrivals == 0,
              let gapMs = telemetry.maxArrivalGapMs,
              gapMs >= intervalMs
        else { return false }
        // Never sent anything at all: there is no traffic whose absence could be evidence.
        guard let hostQuietMs else { return false }
        return gapMs > hostQuietMs + intervalMs
    }

    private let config: MediaQualityControllerConfig
    private(set) var target: MediaQualityTarget
    private var cleanRecoveryMs = 0
    private var cadencePressureStreak = 0
    private var stalePressureStreak = 0
    // ADR-0098: consecutive windows the measured goodput fell short of the rung's budget.
    private var deliveryShortfallStreak = 0
    // ADR-0098: consecutive windows the round-trip sat far above the path's own floor. Counted
    // apart from the shortfall streak because the two describe different failures and must not
    // spend each other's evidence.
    private var queueBloatStreak = 0
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

    // R231. The rung names a resolution the way it names a bitrate, but the two are not the
    // same kind of instruction. Bitrate and fps are live properties of the compression
    // session; resolution is fixed at session creation, so changing it recreates the session,
    // which emits an IDR and destroys every long-term reference inside it. That is not an
    // implementation cost that could be optimised away: HEVC has no reference picture
    // resampling, and the codecs that do are not encodable on this host.
    //
    // So the rung's scale is treated as a REQUEST, and this is what has actually been
    // committed to the encoder. The request has to persist to be granted. The measured
    // failure it prevents: 0.75 -> 0.50 -> 0.75 inside seventeen seconds, three keyframes of
    // 86,644 / 68,598 / 122,041 bytes, on the cellular link least able to carry them.
    private var committedResolutionScale: Double = 1.0
    // How long the rung has continuously asked for something other than the committed scale.
    private var resolutionPressureMs = 0
    // Whether that pressure is currently accruing, deliberately not which scale it points at.
    // A link that is genuinely failing produces repeated stale windows, and each one walks the
    // rung down another step, so the requested scale keeps changing: 0.75, then 0.50, then
    // 0.33. Keyed on the exact value, every one of those steps would reset the clock and a
    // collapsing link would never earn its rescale at all -- the precise failure this gate
    // must not have. They accumulate instead, because they are all the same evidence.
    private var resolutionPressureAccruing = false
    // Duration credited to the current window, captured at the top of `observe` so the single
    // funnel below can accrue in the same units the recovery clock uses.
    private var currentWindowMs = 1_000
    // Set by the paths whose evidence is about the setting actually running, rather than a
    // guess about capacity. Two cases: a probe that failed its warmup has just demonstrated
    // that the scale it raised to does not work, and a freeze means the stream is already
    // broken rather than predicted to break. Waiting out a dwell in either case holds a
    // known-bad resolution for ten seconds on purpose, so they skip the gate.
    private var resolutionEvidenceIsProven = false
    // R231c. Total clean time since the last thing went wrong, for the resolution axis only.
    // `cleanRecoveryMs` cannot serve this: it is zeroed every time it reaches
    // `requiredRecoveryMs` so the ladder can take its next recovery step, which caps it at 4s
    // and makes "clean for thirty seconds" unrepresentable in it.
    private var resolutionCleanMs = 0
    /// Whether `adoptLinkQualityPrior` has had its one chance. Separate from whether it acted:
    /// a client reporting `good` on its first window must not leave the door open for a later
    /// window reporting `minimal` to reset a ladder that measurement is by then driving.
    private var hasConsideredLinkQualityPrior = false
    private var hasBeenPinned = false

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

    /// The rung to open on for a client that has told us how good its link is.
    ///
    /// A prior, not a verdict: measurement governs from the first window, and the ladder climbs
    /// back the moment the link proves it can carry more. It exists because the controller
    /// otherwise learns the link the expensive way -- it opens at `.native` and discovers a weak
    /// one by failing on it. Measured on a `linkQuality=minimal` cellular path, that discovery
    /// cost several seconds of full-rate video the link could not carry, and it settled below
    /// where this would have started.
    ///
    /// Deliberately conservative rather than accurate. It names a rung the link is very likely
    /// to sustain, not the rung it will end on, because the two errors are not symmetric:
    /// opening too low costs a second of climbing, opening too high costs the first seconds of
    /// the session, which is exactly when the user is deciding whether this works at all.
    ///
    /// `good` and `unknown` get no opinion. An absent or optimistic reading is not evidence of
    /// a weak link, and the ceiling is already the right guess without evidence.
    static func startingRung(forLinkQuality quality: String?) -> MediaQualityRung? {
        switch quality {
        case "minimal": .capacity2
        case "moderate": .capacity1
        default: nil
        }
    }

    /// Open on the rung the client's reported link quality suggests, once per connection.
    ///
    /// Ignored unless the controller is still exactly where it started. Anything else means
    /// better evidence is already in play: either measurement has moved the rung, or a resume
    /// pinned the one the previous connection ended on (ADR-0090), which is a rung this link
    /// actually sustained seconds ago rather than an inference from a coarse label.
    /// - Returns: the target this displaced, or `nil` if it did not act. The caller needs it:
    ///   the prior moves the rung *before* the window is judged, so that window's own
    ///   evaluation compares the new rung against itself and reports no change. Reported that
    ///   way the move would never reach the encoder, and the ladder would say it had dropped
    ///   while full-rate frames kept going out.
    @discardableResult
    mutating func adoptLinkQualityPrior(_ quality: String?) -> MediaQualityTarget? {
        guard !hasConsideredLinkQualityPrior else { return nil }
        hasConsideredLinkQualityPrior = true
        guard !hasBeenPinned, target.rung == .native else { return nil }
        guard let rung = Self.startingRung(forLinkQuality: quality) else { return nil }
        let displaced = target
        pin(to: fixedTarget(for: rung, reason: "link-quality-prior"))
        return displaced
    }

    mutating func pin(to target: MediaQualityTarget) {
        hasBeenPinned = true
        self.target = target
        self.stableTarget = target
        cleanRecoveryMs = 0
        cadencePressureStreak = 0
        stalePressureStreak = 0
        deliveryShortfallStreak = 0
        queueBloatStreak = 0
        // A pin is the encoder's scale being set directly, not a request to be gated: this is
        // the resume path (ADR-0090) handing back the rung the previous connection ended on,
        // and the encoder is about to run at exactly that scale. Adopting it as committed is
        // what keeps the resume from immediately reading as pressure in one direction or the
        // other and spending a keyframe undoing itself.
        committedResolutionScale = target.resolutionScale
        resolutionCleanMs = 0
        clearResolutionPressure()
        clearProbe()
    }

    mutating func observe(_ input: MediaQualityControllerInput) -> MediaQualityEvaluation {
        let previous = target
        currentWindowMs = max(input.production?.windowMs ?? idleRecoveryWindowMs, 1)
        let signals = makeSignals(input)
        let delivery = input.delivery

        // ADR-0098: the link is asked about BEFORE the frame count, and this ordering is the
        // whole fix.
        //
        // A freeze resolves no frames -- nothing is acked because nothing arrives, and nothing
        // expires because expiry needs a client report the client is not sending -- so it fell
        // into the zero-frame branch below, whose only outcomes are climb and hold. Every
        // descent branch is written after it. Measured on a stalled LTE link: 25 windows with
        // zero completions and frames still in flight, 6 of them carrying stale pressure, all
        // of them logged `reason=idle` while the rung never moved.
        //
        // No streak gate, unlike stale and cadence pressure. Those count because one window of
        // them is usually noise (R231b measured 47 of 51 stale bursts lasting exactly one
        // window). A stalled link is not noise: the client is reporting that it received
        // nothing over a span longer than our own quiet period, or that its path is not
        // satisfied. Waiting for a second window of that is waiting through a freeze the user
        // is already looking at.
        if delivery.isStalled {
            resetPressureStreaks()
            resetStaleStreak()
            resetRecovery()
            resolutionEvidenceIsProven = true
            downshiftCapacity(reason: "delivery-stalled-down")
            return evaluation(
                signals: signals,
                previous: previous,
                reason: target == previous ? floorReason : target.reason,
                recoveryBlocker: "delivery-stalled"
            )
        }

        // ADR-0098: stale pressure is judged before the frame count too, for the same reason and
        // against a premise that turned out to be false. The zero-frame branch used to reset the
        // stale streak on the grounds that "a window with no frames cannot have produced a stale
        // one" -- but `staleRecoveryCount` is incremented by `abandonUntilCanProduce` at PRODUCE
        // time, which is entirely independent of whether anything was acked. A window that
        // abandoned five frames and had none acknowledged has both, and it was being called idle.
        //
        // Measured consequence of the old order: a freeze alternating idle and stale windows
        // reset the streak on every idle one, so 12 stale windows produced exactly one
        // `stale-capacity-down` in 45 minutes.
        if signals.stalePressure {
            resetPressureStreaks()
            resetRecovery()
            // R231b: one window of stale pressure is not evidence. Measured over 25 minutes,
            // 47 of 51 stale bursts lasted exactly one window, and reacting to each of them is
            // what turned the ladder into an oscillator. Same shape as `cadenceDownWindows`.
            stalePressureStreak += 1
            guard stalePressureStreak >= config.staleDownWindows else {
                return evaluation(
                    signals: signals,
                    previous: previous,
                    reason: "stale-hold",
                    recoveryBlocker: "stale-pressure"
                )
            }
            resetStaleStreak()
            downshiftCapacity(reason: "stale-capacity-down")
            return evaluation(
                signals: signals,
                previous: previous,
                reason: target == previous ? floorReason : target.reason,
                recoveryBlocker: "stale-pressure"
            )
        }
        // A window without stale pressure breaks the run, so the next burst starts from zero
        // rather than pairing up with an unrelated one from minutes ago. Reaching here means
        // stale pressure was already ruled out above, so this is now true of the idle branch as
        // well -- which is what makes it safe for a quiet window to clear the run.
        resetStaleStreak()

        // ADR-0098: descend on the measured shortfall itself, not on a symptom of it.
        //
        // Every other descent branch above reads an effect: acks aging, frames expiring, the
        // client reporting a dead path. Each is real and each lags, because it needs the queue
        // to have already grown enough to show. This one asks the link directly -- goodput from
        // the bytes acks retired -- and it fires while the queue is still building.
        //
        // It sits after stale pressure rather than before it because stale is the more specific
        // complaint: `abandonUntilCanProduce` dropping frames says the host is over the cap
        // right now, where a shortfall says the last few seconds averaged short. Both descend by
        // the same step, so the order only decides which reason is logged.
        //
        // The max filter is what keeps this from running away. After a downshift the window
        // still holds the capacity measured before it, so the very next window compares the new,
        // smaller ask against the old, larger measurement and the streak breaks. The ladder
        // takes one step per genuine 5-second stretch of shortfall, not one per window.
        if delivery.isBelowBudget(
            bitrateKbps: target.bitrateKbps,
            ratio: config.deliveryShortfallRatio
        ) {
            resetPressureStreaks()
            resetRecovery()
            deliveryShortfallStreak += 1
            guard deliveryShortfallStreak >= config.deliveryShortfallWindows else {
                return evaluation(
                    signals: signals,
                    previous: previous,
                    reason: "delivery-shortfall-hold",
                    recoveryBlocker: "delivery-shortfall"
                )
            }
            downshiftCapacity(reason: "delivery-shortfall-down")
            return evaluation(
                signals: signals,
                previous: previous,
                reason: target == previous ? floorReason : target.reason,
                recoveryBlocker: "delivery-shortfall"
            )
        }
        deliveryShortfallStreak = 0

        // ADR-0098: the other half of what ADR-0088 measured and never spent.
        //
        // Goodput cannot see this one. A path can deliver every byte, at the rate we asked for,
        // several seconds late -- healthy throughput, nothing expiring, nothing stale, and a
        // picture on the phone that is seconds behind the Mac. The round-trip's distance from its
        // own floor is the only signal that says so, and it read 5.0 through the freeze while the
        // ladder held.
        //
        // Descending is the right response even though the queue is not of our making: the queue
        // drains at the link's rate whatever we do, and the only lever we have over how long it
        // stays full is how fast we refill it.
        if delivery.isQueueBloated(ratio: config.roundTripInflationDownRatio) {
            resetPressureStreaks()
            resetRecovery()
            queueBloatStreak += 1
            guard queueBloatStreak >= config.deliveryShortfallWindows else {
                return evaluation(
                    signals: signals,
                    previous: previous,
                    reason: "queue-bloat-hold",
                    recoveryBlocker: "queue-bloat"
                )
            }
            downshiftCapacity(reason: "queue-bloat-down")
            return evaluation(
                signals: signals,
                previous: previous,
                reason: target == previous ? floorReason : target.reason,
                recoveryBlocker: "queue-bloat"
            )
        }
        queueBloatStreak = 0

        if delivery.resolvedFrames == 0 {
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
            let idleLinkClean = !delivery.clientReportMissing
                && !delivery.clientLinkStalled
                && delivery.inFlightFrames == 0
                && delivery.staleRecoveryCount == 0
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
            resolutionEvidenceIsProven = true
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

        if signals.queuePressure || (input.delivery.sample.ackAgeP95Ms ?? 0) >= config.ackHoldP95Ms {
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
        let cleanWindowMs = input.production?.windowMs ?? idleRecoveryWindowMs
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
        resolutionCleanMs += max(windowMs, 1)
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
                reason: target == previous ? atCeilingReason : target.reason,
                recoveryBlocker: target == previous ? atCeilingReason : "none"
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
        let sample = input.delivery.sample
        let total = sample.completedFrames + sample.expiredFrames
        let lossPermille = total > 0 ? (sample.expiredFrames * 1000) / total : 0
        let repairPressure = sample.resendRequests > 0
        let lossPressure = lossPermille >= config.lossDownPermille ||
            sample.expiredFrames > 0 ||
            sample.keyframeRequests > 0 ||
            repairPressure
        let queuePressure = (sample.ackAgeP95Ms ?? 0) >= config.ackDownP95Ms
        let stalePressure = input.delivery.staleRecoveryCount > 0
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
        let cadencePressure = linkStressed && (input.production.map { summary in
            summary.fpsDeficit * 2 >= max(summary.targetFps, 1) ||
                summary.maxGapMs >= config.cadenceGapMs
        } ?? false)
        let freezePressure = linkStressed && (input.production.map { summary in
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
              input.delivery.staleRecoveryCount == 0,
              input.delivery.ackCount > 0
        else {
            return "recovery-wait-no-ack"
        }
        guard (input.delivery.sample.ackAgeP95Ms ?? Double.greatestFiniteMagnitude) < config.ackHoldP95Ms else {
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

    /// The climb earned its step and had nowhere to put it.
    ///
    /// Named for where the ladder actually is. This was hardcoded to `at-native`, which one
    /// 45-minute log emitted 27 times from the EMERGENCY floor -- the opposite end of the
    /// ladder, and the one place where "we are at full quality" is the most misleading thing a
    /// diagnostic could say. A rung can be at its own ceiling without being at the top.
    private var atCeilingReason: String {
        target.rung == .native ? "at-native" : "at-rung-ceiling"
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
        // ADR-0098: a descent spends the shortfall evidence, whichever signal triggered it. The
        // ask just got smaller, so a streak accumulated against the OLD budget says nothing
        // about the new one, and carrying it forward would let a single stale-down and a single
        // short window combine into a second step the link never asked for.
        deliveryShortfallStreak = 0
        queueBloatStreak = 0
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
        // R231c: do not start the climb until the link has held clean. This HOLDS rather than
        // falling through to fps, because the recovery sequence is one axis at a time by design
        // -- bitrate, then resolution, then fps -- so that a probe failure is attributable to
        // the axis that moved. Letting fps overtake a stalled resolution step would break that.
        if target.resolutionScale < canonical.resolutionScale {
            guard resolutionClimbIsEarned else { return }
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
            guard resolutionClimbIsEarned else { return }
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
        // The probe just tested this exact setting and it failed. That is the strongest
        // evidence available about the current scale, so the rollback is not speculation and
        // does not wait.
        resolutionEvidenceIsProven = true
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

    /// The rung to hand a stream switching from a manual pin back to adaptive.
    ///
    /// ADR-0098. A fresh controller opens at the ceiling, and the encoder acts on that
    /// immediately: measured at 18:32:45, enabling adaptive on a stream pinned to 0.33 scale
    /// recreated the compression session at the full 3600x2338 and emitted a 120,646-byte
    /// keyframe, then the link-quality prior arrived one window later and spent a second
    /// 102,918-byte keyframe going back down. 223KB in 364ms, on the link that had just been
    /// diagnosed as congested.
    ///
    /// So the scale that is already running is kept exactly, which costs no keyframe at all --
    /// resolution is the only axis whose change forces an IDR, because HEVC has no reference
    /// picture resampling. Bitrate and fps come from the ladder rung that owns that scale, so
    /// the controller lands on a real rung and can climb; pinning the manual target verbatim
    /// would leave it at `.native` below the ceiling, where `recover` returns early and the
    /// bitrate could never come back.
    ///
    /// The rung chosen is the highest-quality one whose canonical scale does not EXCEED what is
    /// running, so this can only ever keep or lower the encoder's ambition, never raise it.
    static func adaptiveHandoffTarget(
        from current: MediaQualityTarget,
        config: MediaQualityControllerConfig,
        reason: String
    ) -> MediaQualityTarget {
        let rung = [MediaQualityRung.native, .lossControl, .capacity1, .capacity2, .survival, .emergency]
            .first { canonicalTarget(for: $0, config: config, reason: reason).resolutionScale <= current.resolutionScale }
            ?? .emergency
        return canonicalTarget(for: rung, config: config, reason: reason)
            .with(resolutionScale: current.resolutionScale, reason: reason)
    }

    static func canonicalTarget(
        for rung: MediaQualityRung,
        config: MediaQualityControllerConfig,
        reason: String
    ) -> MediaQualityTarget {
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

    private func fixedTarget(for rung: MediaQualityRung, reason: String) -> MediaQualityTarget {
        Self.canonicalTarget(for: rung, config: config, reason: reason)
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

    /// Deliberately NOT part of `resetPressureStreaks`. The stale branch calls that on its way
    /// through to clear the cadence streak, and folding this in would have the signal reset the
    /// very counter it is trying to accumulate.
    private mutating func resetStaleStreak() {
        stalePressureStreak = 0
    }

    private mutating func resetRecovery() {
        cleanRecoveryMs = 0
        // Any pressure at all restarts the climb-back clock. That is the point: the measured
        // failure was climbing after four clean seconds onto a link that had not actually
        // recovered, and then paying another keyframe to come back down.
        resolutionCleanMs = 0
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

    /// R231. Every branch of `observe` returns through here, which is why the resolution gate
    /// lives at this point rather than at each `downshiftCapacity` / `recover` site: the rungs
    /// stay free to say whatever they mean, and exactly one place decides what the encoder is
    /// allowed to act on.
    private mutating func evaluation(
        signals: MediaQualityObservationSignals,
        previous: MediaQualityTarget,
        reason: String,
        recoveryBlocker: String
    ) -> MediaQualityEvaluation {
        gateResolution()
        return MediaQualityEvaluation(
            signals: signals,
            outcome: MediaQualityOutcome(
                target: target.with(reason: reason),
                previousTarget: previous,
                reason: reason
            ),
            recoveryStatus: recoveryStatus(blocker: recoveryBlocker)
        )
    }

    /// Hold `target.resolutionScale` at the committed value until the rung has asked for a
    /// different one for long enough to be believed.
    ///
    /// Asymmetric on purpose. Down is the shorter wait because a link that genuinely got
    /// worse has to be answered, and 10s of high resolution at a starved bitrate is ugly but
    /// bounded -- it quantizes hard and blocks up around text, then clears the moment bitrate
    /// recovers. Up is the longer wait because the climb back has no urgency at all and was
    /// the most expensive frame measured, spent returning to a scale the link had just failed
    /// at. Note the direction that reads backwards: rescaling *during* congestion answers
    /// "not enough bandwidth" by emitting the largest possible frame, so on this one axis
    /// slow is the safe choice.
    private mutating func gateResolution() {
        // The request is read from the RUNG, not from `target.resolutionScale`. That looks like
        // a detail and is the difference between working and not: this function writes its
        // decision back into `target`, so by the next window `target.resolutionScale` is
        // already the committed value and would compare equal to itself. Pressure would then
        // only survive across windows that each actively reassigned the target, and in the
        // measured trace those arrive about every six seconds -- so a ten second dwell could
        // never be reached and a genuinely worse link would never rescale at all. The rung is
        // the state that actually persists between windows, so the rung is what gets asked.
        let requested = fixedTarget(for: target.rung, reason: target.reason).resolutionScale
        guard requested != committedResolutionScale else {
            // The rung came back on its own. Whatever move was accruing is abandoned, which is
            // the entire point: an excursion that reverses inside the dwell commits nothing
            // and costs no keyframe.
            clearResolutionPressure()
            return
        }
        // Only the way DOWN is gated here. The climb back is already gated, by a mechanism
        // this controller has had all along: `recover()` does not raise resolution directly,
        // it opens a `resolutionProbe` phase with a clean-streak requirement, a transition
        // warmup, and a rollback if the probe fails. Adding a second, parallel dwell on top of
        // that would model the same thing twice and break the probe, which is exactly what the
        // first version of this gate did. If the up-move is still too eager -- and the 122,041B
        // frame says it is -- the lever is that probe's threshold, not another clock.
        guard requested < committedResolutionScale else {
            // Upward. R231c: the climb has to be earned with sustained clean time, or it is held
            // at the committed scale. This is the funnel, so it also catches the rung move and
            // the fps probe, both of which carry the next rung's scale and would otherwise raise
            // resolution as a side effect of climbing a free axis.
            if resolutionClimbIsEarned {
                committedResolutionScale = requested
                resolutionCleanMs = 0
                clearResolutionPressure()
                return
            }
            target = target.with(resolutionScale: committedResolutionScale, reason: target.reason)
            stableTarget = stableTarget.with(
                resolutionScale: committedResolutionScale,
                reason: stableTarget.reason
            )
            return
        }
        if resolutionEvidenceIsProven {
            committedResolutionScale = requested
            clearResolutionPressure()
            return
        }
        if !resolutionPressureAccruing {
            resolutionPressureAccruing = true
            resolutionPressureMs = 0
        }
        resolutionPressureMs += currentWindowMs
        if resolutionPressureMs >= config.resolutionDownDwellMs {
            // Whatever the rung is asking for right now, not the value that opened the window:
            // if the link kept degrading during the wait, the deepest request is the honest one.
            committedResolutionScale = requested
            clearResolutionPressure()
        }
        // The reason is carried through untouched: the branch that set it is still telling the
        // truth about why bitrate and fps moved, and only the scale is being withheld.
        target = target.with(resolutionScale: committedResolutionScale, reason: target.reason)
        // `stableTarget` is the probe rollback point, so it has to describe a stream that
        // actually ran. Left ungated it would name a scale the encoder never used, and a
        // rollback would then install that scale as if returning to something proven.
        stableTarget = stableTarget.with(
            resolutionScale: committedResolutionScale,
            reason: stableTarget.reason
        )
    }

    /// R231c. Has the link been clean long enough to justify spending a keyframe climbing back?
    /// Measured: 80% of upward rescales were undone within 30 seconds, so four times out of five
    /// this returning false is the difference between a keyframe and nothing.
    private var resolutionClimbIsEarned: Bool {
        resolutionCleanMs >= config.resolutionRaiseCleanMs
    }

    private mutating func clearResolutionPressure() {
        resolutionPressureMs = 0
        resolutionPressureAccruing = false
        resolutionEvidenceIsProven = false
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
    /// When we last handed a frame to the carrier. Deliberately NOT reset per window: the
    /// question `clientLinkStalled` asks is "how long have we been quiet", which spans windows.
    /// A per-window counter cannot answer it, because the freeze shape that matters is the one
    /// where the host stopped producing several windows ago and the client is still silent.
    private var lastSentUptimeNs: UInt64?
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
    // ADR-0098: how much the link actually carried, from the bytes acks retire. The rung, the
    // encoder's average and the pacer's refill were all numbers the host asked for; this is the
    // only one it was told.
    private(set) var deliveryEstimator: LinkDeliveryEstimator

    init(
        maxInflightFrames: Int = Config.ownedMediaBackpressureMaxInflightFrames,
        maxInflightBytes: Int = Config.ownedMediaBackpressureMaxInflightBytes,
        expectedFrameRate: Int = Config.ownedMediaExpectedFrameRate,
        qualityControllerConfig: MediaQualityControllerConfig = .fromConfig(),
        qualityController: MediaQualityController? = nil,
        resendRingFrames: Int = Config.ownedMediaResendRingFrames,
        stallRecoveryMinIntervalMs: Int = Config.ownedMediaStallRecoveryMinIntervalMs,
        roundTripMinimumWindowMs: Int = Config.ownedMediaRoundTripMinimumWindowMs,
        deliverySliceMs: Int = Config.ownedMediaDeliverySliceMs,
        deliveryWindowMs: Int = Config.ownedMediaDeliveryWindowMs
    ) {
        self.stallRecoveryMinIntervalNs = UInt64(max(0, stallRecoveryMinIntervalMs)) * 1_000_000
        self.roundTrip = AckRoundTripTracker(minimumWindowMs: roundTripMinimumWindowMs)
        self.deliveryEstimator = LinkDeliveryEstimator(
            sliceMs: deliverySliceMs,
            windowMs: deliveryWindowMs
        )
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
            // ADR-0098: hand the ladder the stream as it is actually running, not the ceiling.
            // A fresh controller opens at native, and the encoder acted on that before any
            // measurement arrived -- two full keyframes, 223KB in 364ms, on a link that had just
            // been diagnosed as congested.
            qualityController.pin(to: MediaQualityController.adaptiveHandoffTarget(
                from: previous,
                config: qualityControllerConfig,
                reason: "adaptive-quality-enabled"
            ))
            resetForQualityChange()
            clearQualityWindow()
            let target = qualityController.target
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

    /// ADR-0090: start this connection at the rung the previous one ended on instead of at the
    /// ceiling.
    ///
    /// The ladder lived entirely on the transport, so a reconnect restarted it at full scale.
    /// That is not merely a wasted probe: the first encode at the new scale recreates the
    /// compression session, and every long-term reference lives inside that session. So the
    /// reset put a resolution change directly in the path of every resume, which is the one
    /// moment the cheap recovery path exists for -- the refresh had nothing left to reference
    /// and degraded to a full keyframe on a link that had just come back.
    ///
    /// Only the target carries. Backpressure, the resend ring and the round-trip samples all
    /// describe the connection that just died and would be actively wrong applied to this one.
    ///
    /// Adaptation continues from here rather than being frozen: `pin` clears the recovery
    /// credit and probe state, so the ladder re-earns its way up. A rung measured seconds ago
    /// is a far better opening bid than the ceiling, but it is still only a bid -- the link may
    /// genuinely have changed, which is the whole reason the drop happened.
    mutating func resumeQualityTarget(_ target: MediaQualityTarget) {
        qualityController.pin(to: target)
        resetForQualityChange()
        clearQualityWindow()
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
        lastSentUptimeNs = sentAtUptimeNs
        if isKeyframe {
            keyframeInFlight = frameId
        }
        resendRing.remember(frameId: frameId, packets: packets)
    }

    @discardableResult
    mutating func noteAck(frameId: UInt64, nowNs: UInt64 = DispatchTime.now().uptimeNanoseconds) -> Double? {
        guard let retirement = backpressure.noteAck(frameId: frameId) else { return nil }
        if let inFlight = keyframeInFlight, frameId >= inFlight {
            keyframeInFlight = nil
        }
        // ADR-0098: goodput is fed from every advancing ack, including the ones whose own frame
        // was already abandoned. Those bytes still arrived; only their round-trip attribution is
        // untrustworthy, and that is a separate question from how much the link carried.
        deliveryEstimator.noteDelivered(
            bytes: retirement.bytes,
            backlogBytesAfter: backpressure.bytesInFlight,
            nowNs: nowNs
        )
        guard let sentAtUptimeNs = retirement.ackedSentAtUptimeNs else { return nil }
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
        // ADR-0098: the slice in progress was measuring against a backlog that just vanished
        // without the link having carried it, so its rate would be an app-limited sample wearing
        // a link-limited label. The completed samples still describe this link and stay -- the
        // link did not change, only what we are asking of it.
        deliveryEstimator.discardPendingSlice()
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
        // Before this window is judged, not after: the prior's whole value is being in place
        // for the earliest decision, and a client's first report is the earliest its link
        // quality can be known. It no-ops on every window after the first.
        let displacedByPrior = qualityController.adoptLinkQualityPrior(clientTelemetry?.linkQuality)
        // ADR-0088: age the round-trip floor on the window boundary, not only on new samples.
        // A freeze produces no acks at all, so a floor that could only expire inside
        // `record` would stay pinned to a pre-freeze value for the whole stall -- the one
        // stretch where the ratio most needs to be honest about how old its baseline is.
        roundTrip.expireMinimumCandidates(nowNs: nowNs)
        // ADR-0098: same reason, same boundary. A max filter only falls by expiry, so a freeze --
        // which delivers nothing, and therefore calls nothing on the estimator -- would keep
        // reporting the capacity measured before it started for as long as it lasted.
        deliveryEstimator.expire(nowNs: nowNs)
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
            delivery: MediaDeliveryObservation(
                sample: sample,
                ackCount: ackStats.count,
                ackAgeMaxMs: ackStats.max,
                inFlightFrames: backpressure.inFlight,
                inFlightBytes: backpressure.bytesInFlight,
                oldestInflightMs: oldestInflightMs,
                staleRecoveryCount: staleRecoveryCountInWindow,
                clientReportMissing: clientReportMissing,
                clientLinkStalled: MediaQualityController.clientLinkStalled(
                    telemetry: clientTelemetry,
                    reportIntervalMs: reportIntervalMs,
                    hostQuietMs: lastSentUptimeNs.map { sentNs in
                        Double(nowNs >= sentNs ? nowNs - sentNs : 0) / 1_000_000.0
                    }
                ),
                deliveredBytesPerSecond: deliveryEstimator.deliveredBytesPerSecond,
                roundTripInflationRatio: roundTrip.inflationRatio
            ),
            production: productionSummary
        )

        if !adaptiveQualityEnabled {
            let target = qualityController.target.with(reason: "manual-quality-fixed")
            let signals = qualityController.makeSignals(input)
            let observation = MediaQualityObservation(
                windowId: qualityWindowId,
                sample: sample,
                previousTarget: target,
                productionSummary: productionSummary,
                ackCount: input.delivery.ackCount,
                ackAgeMaxMs: input.delivery.ackAgeMaxMs,
                inFlightFrames: input.delivery.inFlightFrames,
                inFlightBytes: input.delivery.inFlightBytes,
                oldestInflightMs: input.delivery.oldestInflightMs,
                staleRecoveryCount: input.delivery.staleRecoveryCount,
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

        var evaluation = qualityController.observe(input)
        if let displaced = displacedByPrior {
            // Report this window's move against what the prior displaced, not against the rung
            // the prior installed, so the drop is visible to the encoder and to the log. If the
            // window's own evaluation moved further, that target stands; only the baseline
            // changes.
            evaluation = MediaQualityEvaluation(
                signals: evaluation.signals,
                outcome: MediaQualityOutcome(
                    target: evaluation.outcome.target,
                    previousTarget: displaced,
                    reason: evaluation.outcome.target == displaced
                        ? evaluation.outcome.reason
                        : "link-quality-prior"
                ),
                recoveryStatus: evaluation.recoveryStatus
            )
        }
        let observation = MediaQualityObservation(
            windowId: qualityWindowId,
            sample: sample,
            previousTarget: evaluation.outcome.previousTarget,
            productionSummary: productionSummary,
            ackCount: input.delivery.ackCount,
            ackAgeMaxMs: input.delivery.ackAgeMaxMs,
            inFlightFrames: input.delivery.inFlightFrames,
            inFlightBytes: input.delivery.inFlightBytes,
            oldestInflightMs: input.delivery.oldestInflightMs,
            staleRecoveryCount: input.delivery.staleRecoveryCount,
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
        let jammed = input.delivery.ackCount == 0 && !backpressure.canProduce()
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
        // Same reason as the quality-change flush: the backlog is gone and the link never
        // carried it. Keeping the completed samples matters more here than anywhere -- they are
        // the record of what this link could do before it stalled, and the pacer needs a number
        // to come back to.
        deliveryEstimator.discardPendingSlice()

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
