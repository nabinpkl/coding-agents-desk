import Foundation
import AgentDeskWire

// ADR-0033 established one host-owned controller choosing bitrate, fps, and resolution
// together. ADR-0101 made the target it chooses a NUMBER rather than a named rung: the old
// four-step capacity ladder could not represent a link whose capacity sat between rungs
// (capacity1 asked 650kbps while its own fps needed ~916 of measured content), and had no step
// below its floor, so a bloated queue logged `at-emergency-floor` 126 times in one session with
// nowhere left to go. Bitrate moves continuously in [floorKbps, ceilingKbps]; fps is DERIVED
// from bitrate through the measured delta-frame cost, so every target carries its cadence in
// bytes by construction (the cb74f8bf floor lesson, generalized); resolution never moves
// (ADR-0100).
struct MediaQualityTarget: Equatable, Sendable {
    let bitrateKbps: Int
    let fps: Int
    let resolutionScale: Double
    let reason: String

    func with(
        bitrateKbps: Int? = nil,
        fps: Int? = nil,
        resolutionScale: Double? = nil,
        reason: String
    ) -> MediaQualityTarget {
        MediaQualityTarget(
            bitrateKbps: bitrateKbps ?? self.bitrateKbps,
            fps: fps ?? self.fps,
            resolutionScale: resolutionScale ?? self.resolutionScale,
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
    // The same round-trip in milliseconds, kept because the ratio alone cannot say whether its
    // own answer matters. A ratio is scale-free: 3.7x a floor of 11ms is a picture 47ms behind,
    // which nobody can see, and the identical ratio on a slow path is a picture seconds behind.
    // Measured on one session across both interfaces: Wi-Fi ran 3.70 median inflation at 46.9ms
    // smoothed, cellular ran 1.50 at 158.7ms -- so the detector called the FASTER path bloated
    // 75% of the time and the four-times-slower one healthy.
    let roundTripSmoothedMs: Double?

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
        roundTripInflationRatio: Double? = nil,
        roundTripSmoothedMs: Double? = nil
    ) {
        self.clientReportMissing = clientReportMissing
        self.clientLinkStalled = clientLinkStalled
        self.deliveredBytesPerSecond = deliveredBytesPerSecond
        self.roundTripInflationRatio = roundTripInflationRatio
        self.roundTripSmoothedMs = roundTripSmoothedMs
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
    /// Two conditions, and the second one is why this stopped firing on every calm Wi-Fi window.
    ///
    /// The ratio answers "is this path slower than its own best". It cannot answer "and does
    /// that matter", because it is scale-free -- the same 3.7x means 47ms behind on a fast path
    /// and several seconds behind on a slow one, and only the second is the failure this exists
    /// to catch. Measured across one session: Wi-Fi at 46.9ms smoothed crossed the 2.5 ratio in
    /// 75% of windows while cellular at 158.7ms crossed it in 17%, so the detector was calling
    /// the four-times-faster path the queued one.
    ///
    /// That verdict is not cheap. It runs `resetRecovery()`, which zeroes a THIRTY SECOND
    /// clean-time requirement, so firing it three windows in four made the resolution ladder
    /// unable to climb at all and pinned the picture at its emergency floor.
    ///
    /// The absolute term alone would be just as wrong in the other direction: a path sitting at
    /// a steady 300ms is distant, not queued, and sending less recovers none of it. So both
    /// have to hold -- the ratio says something changed, the floor says it is big enough to see.
    func isQueueBloated(ratio: Double, minimumSmoothedMs: Double) -> Bool {
        guard let roundTripInflationRatio, let roundTripSmoothedMs else { return false }
        return roundTripInflationRatio >= ratio && roundTripSmoothedMs >= minimumSmoothedMs
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
    /// The smoothed wire cost of a delta frame of this content (`deltaFrameBytesEwma`), the
    /// number a bitrate needs before it can be turned into a cadence. nil before the first
    /// delta of a connection.
    let deltaFrameBytesEwma: Double?

    init(
        delivery: MediaDeliveryObservation,
        production: MediaProductionSummary? = nil,
        deltaFrameBytesEwma: Double? = nil
    ) {
        self.delivery = delivery
        self.production = production
        self.deltaFrameBytesEwma = deltaFrameBytesEwma
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
        bitrateChanged || fpsChanged || resolutionChanged
    }
    var bitrateChanged: Bool { target.bitrateKbps != previousTarget.bitrateKbps }
    var fpsChanged: Bool { target.fps != previousTarget.fps }
    var resolutionChanged: Bool { target.resolutionScale != previousTarget.resolutionScale }
}

// ADR-0101 deleted the probe/warmup machinery that used to live beside this status
// (MediaQualityProbeAxis, probe windows, the transition warmup). Probes existed because
// raising fps was a gamble the controller had to test; a derived fps only rises because
// bitrate already earned its climb through the clean-credit gate, and any overreach is
// answered by the next descent snapping to the measured delivery rate.
struct MediaQualityRecoveryStatus: Equatable {
    let cleanMs: Int
    let requiredMs: Int
    let blocker: String
}

struct MediaQualityControllerConfig: Equatable {
    let ceilingKbps: Int
    /// ADR-0101: the heartbeat floor, and the reason the range does not reach 0. A target of
    /// literally nothing stops all frames, which stops all acks, which starves the delivery
    /// estimator and the round-trip tracker -- and a controller that cannot measure cannot
    /// climb. The floor is one small frame a second: enough traffic to keep the measurement
    /// loop alive, low enough to let a bloated queue actually drain.
    let floorKbps: Int
    let downStep: Double
    let upStep: Double
    let lossDownPermille: Int
    let raiseCleanWindows: Int
    let cadenceDownWindows: Int
    let staleDownWindows: Int
    let fpsCeiling: Int
    let ackHoldP95Ms: Double
    let ackDownP95Ms: Double
    let cadenceGapMs: Int
    let freezeGapMs: Int
    let freezeFpsCeiling: Int
    /// ADR-0100: ONE scale, always, because resolution is not an adaptation axis.
    ///
    /// It used to be four values descending 0.75 / 0.5 / 0.5 / 0.33, and moving between them is
    /// what made this expensive: `VTCompressionSessionCreate` fixes width and height, so a scale
    /// change recreates the session and discards every acknowledged LTR reference, after which
    /// each refresh falls back to a full IDR for the 9-16 seconds it takes to establish a new one.
    /// Bitrate and fps move freely; they cost nothing to change.
    let resolutionScale: Double
    // ADR-0098: the fraction of the target's own budget the link must be measurably delivering.
    let deliveryShortfallRatio: Double
    let deliveryShortfallWindows: Int
    // ADR-0098: how far the smoothed round-trip may sit above the path's floor. Shares
    // `deliveryShortfallWindows` for its streak -- "one window is a burst, two is a link" is the
    // same claim for both -- but counts it separately, so neither signal spends the other's run.
    let roundTripInflationDownRatio: Double
    /// The absolute half of the queue test: how late the picture has to actually be before an
    /// inflated ratio is allowed to mean anything. See `isQueueBloated`.
    let roundTripBloatMinimumSmoothedMs: Double
    /// ADR-0101: what to assume a delta frame costs before the live EWMA has a sample --
    /// session start, and the fallback whenever the measurement is absent. Sized near the
    /// measured mean delta (7.7KB) with room over it, so an unmeasured session opens with a
    /// conservative cadence rather than an optimistic one.
    let seedFrameBytes: Double
    /// The budget a frame gets over its measured EWMA cost, so cadence is derived with slack
    /// for the frames above the mean rather than exactly at it.
    let frameBytesHeadroom: Double
    /// ADR-0101: the fraction of the MEASURED delivery rate a confirmed descent lands at.
    /// Below 1.0 on purpose: landing exactly at capacity keeps the queue exactly full, and the
    /// point of the descent is to drain it. Mirrors the pacer's delivery tracking
    /// (`LinkSendPacer.bytesPerSecond(forKbps:headroom:deliveredBytesPerSecond:...)`) so the
    /// quality decision and the wire pacing stop disagreeing about what the link can carry.
    let deliverySnapRatio: Double

    init(
        ceilingKbps: Int,
        floorKbps: Int,
        downStep: Double,
        upStep: Double,
        lossDownPermille: Int,
        raiseCleanWindows: Int,
        cadenceDownWindows: Int,
        staleDownWindows: Int = Config.ownedMediaStaleDownWindows,
        fpsCeiling: Int,
        ackHoldP95Ms: Double,
        ackDownP95Ms: Double,
        cadenceGapMs: Int,
        freezeGapMs: Int,
        freezeFpsCeiling: Int,
        resolutionScale: Double = Config.ownedMediaResolutionScale,
        deliveryShortfallRatio: Double = Config.ownedMediaDeliveryShortfallRatio,
        deliveryShortfallWindows: Int = Config.ownedMediaDeliveryShortfallWindows,
        roundTripInflationDownRatio: Double = Config.ownedMediaRoundTripInflationDownRatio,
        roundTripBloatMinimumSmoothedMs: Double = Config.ownedMediaRoundTripBloatMinimumSmoothedMs,
        seedFrameBytes: Double = Config.ownedMediaSeedFrameBytes,
        frameBytesHeadroom: Double = Config.ownedMediaFrameBytesHeadroom,
        deliverySnapRatio: Double = Config.ownedMediaDeliverySnapRatio
    ) {
        self.ceilingKbps = max(1, ceilingKbps)
        self.floorKbps = min(max(1, floorKbps), self.ceilingKbps)
        self.downStep = min(max(downStep, 0.01), 0.99)
        self.upStep = max(upStep, 1.01)
        self.lossDownPermille = max(1, lossDownPermille)
        self.raiseCleanWindows = max(1, raiseCleanWindows)
        self.cadenceDownWindows = max(1, cadenceDownWindows)
        self.staleDownWindows = max(1, staleDownWindows)
        self.fpsCeiling = max(1, fpsCeiling)
        self.ackHoldP95Ms = max(1, ackHoldP95Ms)
        self.ackDownP95Ms = max(self.ackHoldP95Ms, ackDownP95Ms)
        self.cadenceGapMs = max(1, cadenceGapMs)
        self.freezeGapMs = max(self.cadenceGapMs, freezeGapMs)
        self.freezeFpsCeiling = max(0, freezeFpsCeiling)
        self.resolutionScale = Self.normalizedScale(resolutionScale)
        // Clamped below 1.0 deliberately. At 1.0 the rule reads "descend unless the link is
        // delivering every byte we asked for", which no healthy link does continuously, so the
        // controller would walk itself to the floor on a link that was fine.
        self.deliveryShortfallRatio = min(max(0.05, deliveryShortfallRatio), 0.95)
        self.deliveryShortfallWindows = max(1, deliveryShortfallWindows)
        // Floored above 1.0, because 1.0 is an empty queue by definition: at or below it the rule
        // reads "descend whenever the path has any latency at all", which is always.
        self.roundTripInflationDownRatio = max(1.01, roundTripInflationDownRatio)
        self.roundTripBloatMinimumSmoothedMs = max(0, roundTripBloatMinimumSmoothedMs)
        // Floored well above zero: this number is a divisor in the cadence derivation, and a
        // tiny value would read as "frames are free", deriving the ceiling fps from any budget.
        self.seedFrameBytes = max(500, seedFrameBytes)
        self.frameBytesHeadroom = max(1.0, frameBytesHeadroom)
        self.deliverySnapRatio = min(max(0.1, deliverySnapRatio), 1.0)
    }

    static func fromConfig() -> MediaQualityControllerConfig {
        MediaQualityControllerConfig(
            ceilingKbps: Config.ownedMediaBitrateKbps,
            floorKbps: Config.ownedMediaFloorKbps,
            downStep: Config.ownedMediaBitrateDownStep,
            upStep: Config.ownedMediaBitrateUpStep,
            lossDownPermille: Config.ownedMediaBitrateLossDownPermille,
            raiseCleanWindows: Config.ownedMediaBitrateRaiseCleanWindows,
            cadenceDownWindows: Config.ownedMediaCadenceDownWindows,
            staleDownWindows: Config.ownedMediaStaleDownWindows,
            fpsCeiling: Config.ownedMediaAdaptiveFpsCeiling,
            ackHoldP95Ms: Config.ownedMediaAckHoldP95Ms,
            ackDownP95Ms: Config.ownedMediaAckDownP95Ms,
            cadenceGapMs: Config.ownedMediaCadenceGapMs,
            freezeGapMs: Config.ownedMediaFreezeGapMs,
            freezeFpsCeiling: Config.ownedMediaFreezeFpsCeiling,
            deliveryShortfallRatio: Config.ownedMediaDeliveryShortfallRatio,
            deliveryShortfallWindows: Config.ownedMediaDeliveryShortfallWindows,
            roundTripInflationDownRatio: Config.ownedMediaRoundTripInflationDownRatio,
            roundTripBloatMinimumSmoothedMs: Config.ownedMediaRoundTripBloatMinimumSmoothedMs,
            seedFrameBytes: Config.ownedMediaSeedFrameBytes,
            frameBytesHeadroom: Config.ownedMediaFrameBytesHeadroom,
            deliverySnapRatio: Config.ownedMediaDeliverySnapRatio
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
    // ADR-0101: the last measured delta-frame wire cost handed in by `observe`, kept across
    // windows because the EWMA rides the input and an idle window carries none. This is the
    // divisor that turns a bitrate into a cadence; until a measurement arrives, the config
    // seed stands in for it.
    private var measuredFrameBytes: Double?
    // Nominal window credited per idle (zero-activity) observation. The controller
    // counts recovery in one-second windows (requiredRecoveryMs = raiseCleanWindows
    // * 1000), so an idle window credits the same unit to keep ms-accrual aligned.
    private let idleRecoveryWindowMs = 1_000

    /// Whether `adoptLinkQualityPrior` has had its one chance. Separate from whether it acted:
    /// a client reporting `good` on its first window must not leave the door open for a later
    /// window reporting `minimal` to reset a target that measurement is by then driving.
    private var hasConsideredLinkQualityPrior = false
    private var hasBeenPinned = false

    init(config: MediaQualityControllerConfig) {
        self.config = config
        self.target = MediaQualityTarget(
            bitrateKbps: config.ceilingKbps,
            fps: config.fpsCeiling,
            // Not 1.0. Opening at native scale and then adapting down would be a scale CHANGE
            // on the opening decision -- a session recreate before a single quality window has
            // been observed, which is the cost ADR-0100 exists to remove.
            resolutionScale: config.resolutionScale,
            reason: "initial"
        )
    }

    var targetKbps: Int { target.bitrateKbps }
    var targetFps: Int { target.fps }
    var targetResolutionScale: Double { target.resolutionScale }
    var requiredRecoveryMs: Int { config.raiseCleanWindows * 1_000 }
    var currentRecoveryStatus: MediaQualityRecoveryStatus {
        recoveryStatus(blocker: "none")
    }

    /// ADR-0101: the per-frame byte budget the cadence is derived through -- the measured delta
    /// EWMA with headroom, or the config seed while unmeasured. Exposed so the applied-target
    /// log can name why a given bitrate produced a given fps.
    var frameBytesTarget: Double {
        max(500, (measuredFrameBytes ?? config.seedFrameBytes) * config.frameBytesHeadroom)
    }

    /// The cadence a bitrate can actually carry: budget bytes-per-second over the per-frame
    /// cost, clamped to [1, ceiling]. "A target carries its cadence in bytes" (cb74f8bf) made
    /// continuous -- there is no fps knob left to mis-set against the budget.
    private func derivedFps(forKbps kbps: Int) -> Int {
        let bytesPerSecond = Double(max(1, kbps)) * 1_000.0 / 8.0
        return min(max(Int(bytesPerSecond / frameBytesTarget), 1), config.fpsCeiling)
    }

    private func makeTarget(kbps: Int, reason: String) -> MediaQualityTarget {
        let clamped = min(max(kbps, config.floorKbps), config.ceilingKbps)
        return MediaQualityTarget(
            bitrateKbps: clamped,
            fps: derivedFps(forKbps: clamped),
            resolutionScale: config.resolutionScale,
            reason: reason
        )
    }

    /// The bitrate to open on for a client that has told us how good its link is.
    ///
    /// A prior, not a verdict: measurement governs from the first window, and the target climbs
    /// back the moment the link proves it can carry more. It exists because the controller
    /// otherwise learns the link the expensive way -- it opens at the ceiling and discovers a
    /// weak one by failing on it. Measured on a `linkQuality=minimal` cellular path, that
    /// discovery cost several seconds of full-rate video the link could not carry, and it
    /// settled below where this would have started.
    ///
    /// Deliberately conservative rather than accurate. It names a rate the link is very likely
    /// to sustain, not the rate it will end on, because the two errors are not symmetric:
    /// opening too low costs a second of climbing, opening too high costs the first seconds of
    /// the session, which is exactly when the user is deciding whether this works at all.
    /// The numbers are the old capacity rungs' budgets (ADR-0101 kept the priors when it
    /// retired the rungs); cadence is derived, not paired.
    ///
    /// `good` and `unknown` get no opinion. An absent or optimistic reading is not evidence of
    /// a weak link, and the ceiling is already the right guess without evidence.
    static func startingKbps(forLinkQuality quality: String?) -> Int? {
        switch quality {
        case "minimal": 400
        case "moderate": 650
        default: nil
        }
    }

    /// Open on the bitrate the client's reported link quality suggests, once per connection.
    ///
    /// Ignored unless the controller is still exactly where it started. Anything else means
    /// better evidence is already in play: either measurement has moved the target, or a resume
    /// pinned the one the previous connection ended on (ADR-0090), which is a rate this link
    /// actually sustained seconds ago rather than an inference from a coarse label.
    /// - Returns: the target this displaced, or `nil` if it did not act. The caller needs it:
    ///   the prior moves the target *before* the window is judged, so that window's own
    ///   evaluation compares the new target against itself and reports no change. Reported that
    ///   way the move would never reach the encoder, and the controller would say it had
    ///   dropped while full-rate frames kept going out.
    @discardableResult
    mutating func adoptLinkQualityPrior(_ quality: String?) -> MediaQualityTarget? {
        guard !hasConsideredLinkQualityPrior else { return nil }
        hasConsideredLinkQualityPrior = true
        // Only from the untouched opening position. A pin means better evidence is already in
        // play (a resume carried a target this link actually sustained, or a manual choice),
        // and observe() runs after the prior on every window, so an unpinned target below the
        // ceiling cannot exist here.
        guard !hasBeenPinned, target.bitrateKbps == config.ceilingKbps else { return nil }
        guard let kbps = Self.startingKbps(forLinkQuality: quality) else { return nil }
        let displaced = target
        pin(to: makeTarget(kbps: kbps, reason: "link-quality-prior"))
        return displaced
    }

    mutating func pin(to target: MediaQualityTarget) {
        hasBeenPinned = true
        self.target = target
        cleanRecoveryMs = 0
        cadencePressureStreak = 0
        stalePressureStreak = 0
        deliveryShortfallStreak = 0
        queueBloatStreak = 0
    }

    mutating func observe(_ input: MediaQualityControllerInput) -> MediaQualityEvaluation {
        let previous = target
        // ADR-0101: adopt the freshest frame-cost measurement before any branch can derive a
        // cadence from it. Kept across windows -- an idle window carries no EWMA and must not
        // forget the content's cost.
        if let ewma = input.deltaFrameBytesEwma {
            measuredFrameBytes = ewma
        }
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
            descend(reason: "delivery-stalled-down", deliveredBytesPerSecond: delivery.deliveredBytesPerSecond)
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
            descend(reason: "stale-capacity-down", deliveredBytesPerSecond: delivery.deliveredBytesPerSecond)
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
            descend(reason: "delivery-shortfall-down", deliveredBytesPerSecond: delivery.deliveredBytesPerSecond)
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
        if delivery.isQueueBloated(
            ratio: config.roundTripInflationDownRatio,
            minimumSmoothedMs: config.roundTripBloatMinimumSmoothedMs
        ) {
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
            descend(reason: "queue-bloat-down", deliveredBytesPerSecond: delivery.deliveredBytesPerSecond)
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
            if idleLinkClean && target.bitrateKbps < config.ceilingKbps {
                return accrueCleanRecovery(
                    signals: signals,
                    previous: previous,
                    windowMs: idleRecoveryWindowMs
                )
            }
            resetRecovery()
            return evaluation(signals: signals, previous: previous, reason: "idle", recoveryBlocker: "idle")
        }

        // ADR-0101: loss is just another descent trigger now. The old lossControl phase cut
        // bitrate while HOLDING the ceiling fps (more, smaller frames); with cadence derived
        // from the frame cost, a loss descent lowers fps too and keeps frames at the content's
        // measured size -- fewer, intact frames on a lossy link.
        if signals.lossPressure {
            resetPressureStreaks()
            resetRecovery()
            descend(reason: "loss-down", deliveredBytesPerSecond: delivery.deliveredBytesPerSecond)
            return evaluation(
                signals: signals,
                previous: previous,
                reason: target == previous ? floorReason : target.reason,
                recoveryBlocker: "loss-pressure"
            )
        }

        if signals.freezePressure {
            resetPressureStreaks()
            resetRecovery()
            descend(reason: "freeze-capacity-down", deliveredBytesPerSecond: delivery.deliveredBytesPerSecond)
            return evaluation(
                signals: signals,
                previous: previous,
                reason: target == previous ? floorReason : target.reason,
                recoveryBlocker: "freeze-pressure"
            )
        }

        if signals.queuePressure && signals.cadencePressure {
            resetPressureStreaks()
            resetRecovery()
            descend(reason: "queue-cadence-down", deliveredBytesPerSecond: delivery.deliveredBytesPerSecond)
            return evaluation(
                signals: signals,
                previous: previous,
                reason: target == previous ? floorReason : target.reason,
                recoveryBlocker: "queue-cadence-pressure"
            )
        }

        if signals.cadencePressure {
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
            descend(reason: "cadence-capacity-down", deliveredBytesPerSecond: delivery.deliveredBytesPerSecond)
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
    // recovery) or was idle (rest recovery). Accrues recovery credit and lifts the
    // target one multiplicative step once the clean streak clears the bar.
    private mutating func accrueCleanRecovery(
        signals: MediaQualityObservationSignals,
        previous: MediaQualityTarget,
        windowMs: Int
    ) -> MediaQualityEvaluation {
        cleanRecoveryMs += max(windowMs, 1)
        if cleanRecoveryMs >= requiredRecoveryMs {
            cleanRecoveryMs = 0
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

    private var floorReason: String { "at-floor" }

    /// The climb earned its step and had nowhere to put it. With one continuous axis the only
    /// place that happens is the ceiling, which IS native -- the old `at-rung-ceiling` case
    /// (a rung at its own top while the ladder sat at the bottom) went with the rungs.
    private var atCeilingReason: String { "at-native" }

    /// ADR-0101: every confirmed descent, whatever signal triggered it.
    ///
    /// Two terms, min-combined. The multiplicative step is the blind move -- the link
    /// complained but did not say how much it can carry. The snap term is the point of the
    /// continuous axis: when the delivery estimator HAS a number, one descent lands at that
    /// number times a drain margin, instead of walking toward it a step per confirmation.
    /// The ladder this replaces needed four confirmed steps to reach where the link already
    /// was, and had no step at all below its bottom rung. Unknown is not zero: with no
    /// measurement only the blind step applies, the same asymmetry `isBelowBudget` is built on.
    private mutating func descend(reason: String, deliveredBytesPerSecond: Double?) {
        // ADR-0098: a descent spends the shortfall evidence, whichever signal triggered it. The
        // ask just got smaller, so a streak accumulated against the OLD budget says nothing
        // about the new one, and carrying it forward would let a single stale-down and a single
        // short window combine into a second step the link never asked for.
        deliveryShortfallStreak = 0
        queueBloatStreak = 0
        var nextKbps = Double(target.bitrateKbps) * config.downStep
        if let deliveredBytesPerSecond, deliveredBytesPerSecond > 0 {
            let deliveredKbps = deliveredBytesPerSecond * 8.0 / 1_000.0
            nextKbps = min(nextKbps, deliveredKbps * config.deliverySnapRatio)
        }
        let kbps = max(config.floorKbps, Int(nextKbps.rounded()))
        guard kbps < target.bitrateKbps else {
            target = target.with(reason: floorReason)
            return
        }
        target = makeTarget(kbps: kbps, reason: reason)
    }

    /// One multiplicative step toward the ceiling, cadence re-derived with it. Slow by design
    /// against the fast descent: the climb is a bet the link has to keep re-earning, and any
    /// overreach is answered within two windows by a descent that snaps back to measurement.
    private mutating func recover() {
        guard target.bitrateKbps < config.ceilingKbps else { return }
        let kbps = min(
            config.ceilingKbps,
            Int((Double(target.bitrateKbps) * config.upStep).rounded())
        )
        target = makeTarget(kbps: kbps, reason: "quality-up")
    }

    /// The target to hand a stream switching from a manual pin back to adaptive.
    ///
    /// ADR-0098. A fresh controller opens at the ceiling, and the encoder acts on that
    /// immediately: measured at 18:32:45, enabling adaptive on a stream pinned to 0.33 scale
    /// recreated the compression session at the full 3600x2338 and emitted a 120,646-byte
    /// keyframe, then the link-quality prior arrived one window later and spent a second
    /// 102,918-byte keyframe going back down. 223KB in 364ms, on the link that had just been
    /// diagnosed as congested.
    ///
    /// So the RUNNING stream is adopted as it stands, which costs no keyframe at all --
    /// resolution is the only axis whose change forces an IDR, because HEVC has no reference
    /// picture resampling. Bitrate is clamped into the adaptive range so the controller can
    /// move it from here; fps is kept, not re-derived, because derivation could RAISE the
    /// cadence and this handoff must only ever keep or lower the encoder's ambition.
    static func adaptiveHandoffTarget(
        from current: MediaQualityTarget,
        config: MediaQualityControllerConfig,
        reason: String
    ) -> MediaQualityTarget {
        MediaQualityTarget(
            bitrateKbps: min(max(current.bitrateKbps, config.floorKbps), config.ceilingKbps),
            fps: min(max(current.fps, 1), config.fpsCeiling),
            resolutionScale: current.resolutionScale,
            reason: reason
        )
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
        // Any pressure at all restarts the climb-back clock. That is the point: the measured
        // failure was climbing after four clean seconds onto a link that had not actually
        // recovered, and then paying another keyframe to come back down.
        cleanRecoveryMs = 0
    }

    private func recoveryStatus(blocker: String) -> MediaQualityRecoveryStatus {
        MediaQualityRecoveryStatus(
            cleanMs: cleanRecoveryMs,
            requiredMs: requiredRecoveryMs,
            blocker: blocker
        )
    }

    /// Every branch of `observe` returns through here: one place builds the evaluation, so
    /// diagnostics cannot drift from the decision (ADR-0033's rule, kept through ADR-0101).
    private mutating func evaluation(
        signals: MediaQualityObservationSignals,
        previous: MediaQualityTarget,
        reason: String,
        recoveryBlocker: String
    ) -> MediaQualityEvaluation {
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
    // What a delta frame of THIS content actually costs on the wire, smoothed. The floor work
    // (cb74f8bf) sized cadence from an offline measurement of this number (p50 4.8KB, mean
    // 7.7KB); tracking it live is what lets a cadence be derived instead of configured. Delta
    // frames only: keyframes are session-start events (ADR-0100) and two orders of magnitude
    // off the cost this describes. nil until the first delta is sent.
    private(set) var deltaFrameBytesEwma: Double?
    private let frameBytesEwmaAlpha: Double

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
        deliveryWindowMs: Int = Config.ownedMediaDeliveryWindowMs,
        frameBytesEwmaAlpha: Double = Config.ownedMediaFrameBytesEwmaAlpha
    ) {
        self.frameBytesEwmaAlpha = min(max(frameBytesEwmaAlpha, 0.01), 1.0)
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
        // A pending client resync request bypasses the capacity pacer. The recovery frame is
        // the one frame the client is NOT discarding while its gap-recovery gate is armed, so
        // pacing it behind ordinary frames -- which that gate throws away unrendered -- delays
        // the only thing that ends the freeze. Measured before this: on a saturated LTE link
        // the refresh answer regularly took over the client's 4s escalation window to arrive,
        // and the escalations bought 164KB IDRs into the same jam. Bounded by construction:
        // one pending request at a time (`noteKeyframeRequest` suppresses while one is in
        // flight), so this admits one unpaced frame per resync round trip, not a stream.
        if let last = lastProduceUptimeNs, !pendingClientKeyframeRequest {
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
        } else if let current = deltaFrameBytesEwma {
            deltaFrameBytesEwma = current + frameBytesEwmaAlpha * (Double(encodedBytes) - current)
        } else {
            deltaFrameBytesEwma = Double(encodedBytes)
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
                roundTripInflationRatio: roundTrip.inflationRatio,
                roundTripSmoothedMs: roundTrip.smoothedMs
            ),
            production: productionSummary,
            deltaFrameBytesEwma: deltaFrameBytesEwma
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
                recoveryStatus: qualityController.currentRecoveryStatus,
                deliveredBytesPerSecond: input.delivery.deliveredBytesPerSecond,
                frameBytesTarget: qualityController.frameBytesTarget
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
            recoveryStatus: evaluation.recoveryStatus,
            deliveredBytesPerSecond: input.delivery.deliveredBytesPerSecond,
            frameBytesTarget: qualityController.frameBytesTarget
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
        // ADR-0100: the ladder never changes resolution, but an explicit client choice still may
        // -- that is a deliberate user action paying one keyframe, not the oscillation this
        // removed. The DEFAULT must not be native though: a manual target that omits a scale
        // would otherwise rescale the session just by arriving.
        let scale = clientTarget?.resolutionScale ?? qualityControllerConfig.resolutionScale
        return MediaQualityTarget(
            bitrateKbps: min(max(bitrate, 1), 20_000),
            fps: min(max(fps, 1), expectedFrameRate),
            resolutionScale: min(max(scale, 0.1), 1.0),
            reason: reason
        )
    }

    private func sameQualityTarget(_ lhs: MediaQualityTarget, _ rhs: MediaQualityTarget) -> Bool {
        lhs.bitrateKbps == rhs.bitrateKbps &&
            lhs.fps == rhs.fps &&
            lhs.resolutionScale == rhs.resolutionScale
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
