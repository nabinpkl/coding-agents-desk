import Foundation
import AgentDeskWire

protocol MediaTransport: AnyObject, Sendable {
    func start(videoSource: VideoFrameSource?, videoSink: VideoFrameSink?) async throws
    func stop()

    // Per-session client preference for the crisp text overlay (from the client-config
    // wire message). The host composes this with its own Config.ownedMediaCrispEnabled
    // gate as an AND: the host env is the hard kill switch, the client chooses within it.
    // Applied live on the next drained frame; no restart needed.
    func setClientCrispEnabled(_ enabled: Bool)

    // Per-session client control for media quality. When adaptive is off and a fixed target
    // is present, the transport pins bitrate, FPS, and resolution while keeping the media
    // lane, packet repair, and backpressure mechanics alive.
    func setClientMediaQuality(_ config: ClientMediaQualityConfig)

    // Per-session: whether the client currently has the video on screen. Its
    // full-screen surfaces cover the video completely, and encoding into a
    // covered surface spends the downlink and the Mac's encoder on pixels
    // nobody sees. False drops captured frames before the encoder for this
    // client only; the capture source is shared, so other viewers are unaffected.
    func setWatchingVideo(_ watching: Bool)

    var connectionState: AsyncStream<MediaConnectionState> { get }
}

struct OwnedMediaDiagnosticsFpsWindow: Equatable {
    private(set) var windowStartedAtUptimeNs: UInt64
    private(set) var captured = 0
    private(set) var admitted = 0
    private(set) var encoded = 0
    private(set) var sent = 0
    private(set) var acked = 0

    init(windowStartedAtUptimeNs: UInt64) {
        self.windowStartedAtUptimeNs = windowStartedAtUptimeNs
    }

    mutating func incrementCaptured() { captured += 1 }
    mutating func incrementAdmitted() { admitted += 1 }
    mutating func incrementEncoded() { encoded += 1 }
    mutating func incrementSent() { sent += 1 }
    mutating func incrementAcked() { acked += 1 }

    mutating func flushIfDue(nowUptimeNs: UInt64) -> OwnedMediaDiagnosticsFpsSample? {
        guard nowUptimeNs >= windowStartedAtUptimeNs,
              nowUptimeNs - windowStartedAtUptimeNs >= 1_000_000_000
        else {
            return nil
        }
        let elapsedSeconds = max(Double(nowUptimeNs - windowStartedAtUptimeNs) / 1_000_000_000.0, 0.001)
        let sample = OwnedMediaDiagnosticsFpsSample(
            elapsedSeconds: elapsedSeconds,
            captured: captured,
            admitted: admitted,
            encoded: encoded,
            sent: sent,
            acked: acked
        )
        windowStartedAtUptimeNs = nowUptimeNs
        captured = 0
        admitted = 0
        encoded = 0
        sent = 0
        acked = 0
        return sample
    }
}

struct OwnedMediaDiagnosticsFpsSample: Equatable {
    let elapsedSeconds: Double
    let captured: Int
    let admitted: Int
    let encoded: Int
    let sent: Int
    let acked: Int

    func fps(_ count: Int) -> Double {
        Double(count) / elapsedSeconds
    }
}

struct MediaProductionSummary: Equatable {
    let actualFps: Int
    let targetFps: Int
    let fpsDeficit: Int
    let frames: Int
    let keyframes: Int
    let sentKbps: Int
    let targetKbps: Int
    let maxGapMs: Int
    let resolutionScale: Double
    let windowMs: Int
}

struct MediaQualityObservation: Equatable {
    let windowId: UInt64
    let sample: MediaQualitySample
    let previousTarget: MediaQualityTarget
    let productionSummary: MediaProductionSummary?
    let ackCount: Int
    let ackAgeMaxMs: Double?
    let inFlightFrames: Int
    let inFlightBytes: Int
    let oldestInflightMs: Double?
    let staleRecoveryCount: Int
    let freshness: MediaFreshnessDiagnosticsSummary
    let signals: MediaQualityObservationSignals
    let recoveryStatus: MediaQualityRecoveryStatus
}

struct MediaFreshnessDiagnosticsSummary: Equatable {
    let replacedCaptures: Int
    let abandonedFrames: Int
    let abandonedBytes: Int
    let resendPacketsServed: Int
    let resendPacketsMissed: Int
}

// ADR-0087: what the transport must do when a window comes back stalled, decided
// independently of the quality ladder so it also reaches a manually pinned stream.
//
// The two halves are deliberately rate-limited differently. Flushing the in-flight
// accounting costs zero bytes and only reopens admission, so it runs on every stalled
// window. A keyframe is 47-165KB against a link measured at 300-650kbps, so it is the
// half that has to be spaced out.
struct MediaStallRecovery: Equatable {
    let reason: String
    /// In-flight entries dropped by the flush, captured before it ran. These are the
    /// frames whose ACKs would have been discarded anyway.
    let flushedFrames: Int
    let flushedBytes: Int
    /// False when the flush ran but the keyframe was withheld: one is already on the
    /// wire, or the rate limit has not elapsed.
    let forcedKeyframe: Bool
}

struct MediaQualityDecision: Equatable {
    let observation: MediaQualityObservation
    let outcome: MediaQualityOutcome
    /// Non-nil when this window detected a stalled link. Independent of `outcome`:
    /// a manual pin never changes its target but can still need recovery.
    var stallRecovery: MediaStallRecovery? = nil

    var changedAxes: String {
        var axes: [String] = []
        if outcome.bitrateChanged { axes.append("bitrate") }
        if outcome.fpsChanged { axes.append("fps") }
        if outcome.resolutionChanged { axes.append("resolution") }
        if outcome.target.rung != outcome.previousTarget.rung { axes.append("rung") }
        return axes.isEmpty ? "none" : axes.joined(separator: ",")
    }
}

struct MediaProductionDiagnosticsTracker: Equatable {
    private let publishIntervalNs: UInt64
    private var windowStartNs: UInt64?
    private var lastSentNs: UInt64?
    private var frames = 0
    private var keyframes = 0
    private var bytes = 0
    private var maxGapMs = 0

    init(publishIntervalNs: UInt64 = 1_000_000_000) {
        self.publishIntervalNs = max(1, publishIntervalNs)
    }

    mutating func noteSent(
        bytes: Int,
        isKeyframe: Bool,
        targetKbps: Int,
        targetFps: Int,
        resolutionScale: Double,
        nowNs: UInt64
    ) -> MediaProductionSummary? {
        if let lastSentNs, nowNs >= lastSentNs {
            maxGapMs = max(maxGapMs, Int(round(Double(nowNs - lastSentNs) / 1_000_000.0)))
        }
        lastSentNs = nowNs
        if windowStartNs == nil {
            windowStartNs = nowNs
        }
        frames += 1
        self.bytes += max(0, bytes)
        if isKeyframe {
            keyframes += 1
        }

        guard let windowStartNs, nowNs >= windowStartNs + publishIntervalNs else {
            return nil
        }
        let elapsedSeconds = Double(nowNs - windowStartNs) / 1_000_000_000.0
        let actualFps = Int(round(Double(frames) / elapsedSeconds))
        let sentKbps = Int(round(Double(self.bytes * 8) / elapsedSeconds / 1_000.0))
        let summary = MediaProductionSummary(
            actualFps: actualFps,
            targetFps: targetFps,
            fpsDeficit: max(0, targetFps - actualFps),
            frames: frames,
            keyframes: keyframes,
            sentKbps: sentKbps,
            targetKbps: targetKbps,
            maxGapMs: maxGapMs,
            resolutionScale: resolutionScale,
            windowMs: Int(round(elapsedSeconds * 1_000.0))
        )
        self.windowStartNs = nowNs
        frames = 0
        keyframes = 0
        self.bytes = 0
        maxGapMs = 0
        return summary
    }
}

enum MediaConnectionState: Equatable {
    case connecting
    case connected
    case disconnected
    case failed
    case closed
}

protocol MediaTransportFactory {
    func make() -> MediaTransport
}

enum MediaTransportError: Error {
    case notYetImplemented
}

protocol VideoFrameSink: AnyObject, Sendable {}
