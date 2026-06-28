import Foundation

protocol MediaTransport: AnyObject, Sendable {
    func start(videoSource: VideoFrameSource?, videoSink: VideoFrameSink?) async throws
    func stop()

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
