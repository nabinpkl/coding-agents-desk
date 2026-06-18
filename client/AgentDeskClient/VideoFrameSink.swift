import UIKit

struct DualPlaneCompositorEvent: Equatable {
    enum Phase: Equatable {
        case motionStarted
        case motionEnded
        case firstMotionFrame
        case detailRestored
    }

    let phase: Phase
    let visiblePlane: MediaPlane
    let delayMs: Double?
}

struct VideoRenderCadenceSample: Equatable {
    let plane: MediaPlane
    let callbackUptimeNs: UInt64
    let mediaTimestampNs: Int64?
    let width: Int32
    let height: Int32
}

struct VideoRenderCadenceReport: Equatable {
    let plane: MediaPlane
    let reason: String
    let scrollActive: Bool
    let frames: Int
    let callbackWindowMs: Double?
    let avgCallbackGapMs: Double?
    let maxCallbackGapMs: Double?
    let mediaWindowMs: Double?
    let avgMediaGapMs: Double?
    let maxMediaGapMs: Double?
    let lateCallbackGaps: Int
    let width: Int32
    let height: Int32
}

final class VideoRenderCadenceTracker {
    private let plane: MediaPlane
    private let reportEveryFrames: Int
    private let lateCallbackGapMs: Double
    private var scrollActive = false
    private var windowStartCallbackNs: UInt64?
    private var firstMediaTimestampNs: Int64?
    private var lastCallbackNs: UInt64?
    private var lastMediaTimestampNs: Int64?
    private var frames = 0
    private var callbackGapCount = 0
    private var callbackGapTotalMs = 0.0
    private var callbackGapMaxMs = 0.0
    private var mediaGapCount = 0
    private var mediaGapTotalMs = 0.0
    private var mediaGapMaxMs = 0.0
    private var lateCallbackGaps = 0
    private var width: Int32 = 0
    private var height: Int32 = 0

    init(plane: MediaPlane, reportEveryFrames: Int = 30, lateCallbackGapMs: Double = 50.0) {
        self.plane = plane
        self.reportEveryFrames = reportEveryFrames
        self.lateCallbackGapMs = lateCallbackGapMs
    }

    func setScrollActive(_ active: Bool, nowNs: UInt64 = DispatchTime.now().uptimeNanoseconds) -> VideoRenderCadenceReport? {
        let report = flush(reason: active ? "scroll-start" : "scroll-end", nowNs: nowNs)
        scrollActive = active
        return report
    }

    func note(_ sample: VideoRenderCadenceSample) -> VideoRenderCadenceReport? {
        if windowStartCallbackNs == nil {
            windowStartCallbackNs = sample.callbackUptimeNs
            firstMediaTimestampNs = sample.mediaTimestampNs
        }
        frames += 1
        width = sample.width
        height = sample.height

        if let lastCallbackNs {
            let gapMs = Double(sample.callbackUptimeNs - lastCallbackNs) / 1_000_000.0
            callbackGapCount += 1
            callbackGapTotalMs += gapMs
            callbackGapMaxMs = max(callbackGapMaxMs, gapMs)
            if gapMs >= lateCallbackGapMs {
                lateCallbackGaps += 1
            }
        }
        lastCallbackNs = sample.callbackUptimeNs

        if let mediaTimestampNs = sample.mediaTimestampNs {
            if let lastMediaTimestampNs, mediaTimestampNs >= lastMediaTimestampNs {
                let gapMs = Double(mediaTimestampNs - lastMediaTimestampNs) / 1_000_000.0
                mediaGapCount += 1
                mediaGapTotalMs += gapMs
                mediaGapMaxMs = max(mediaGapMaxMs, gapMs)
            }
            lastMediaTimestampNs = mediaTimestampNs
        }

        guard frames % reportEveryFrames == 0 else { return nil }
        return flush(reason: "periodic", nowNs: sample.callbackUptimeNs)
    }

    func flush(reason: String, nowNs: UInt64 = DispatchTime.now().uptimeNanoseconds) -> VideoRenderCadenceReport? {
        guard frames > 0 else { return nil }
        let callbackWindowMs = windowStartCallbackNs.map {
            Double(nowNs - $0) / 1_000_000.0
        }
        let mediaWindowMs: Double?
        if let firstMediaTimestampNs,
           let lastMediaTimestampNs,
           lastMediaTimestampNs >= firstMediaTimestampNs {
            mediaWindowMs = Double(lastMediaTimestampNs - firstMediaTimestampNs) / 1_000_000.0
        } else {
            mediaWindowMs = nil
        }
        let report = VideoRenderCadenceReport(
            plane: plane,
            reason: reason,
            scrollActive: scrollActive,
            frames: frames,
            callbackWindowMs: callbackWindowMs,
            avgCallbackGapMs: average(total: callbackGapTotalMs, count: callbackGapCount),
            maxCallbackGapMs: callbackGapCount > 0 ? callbackGapMaxMs : nil,
            mediaWindowMs: mediaWindowMs,
            avgMediaGapMs: average(total: mediaGapTotalMs, count: mediaGapCount),
            maxMediaGapMs: mediaGapCount > 0 ? mediaGapMaxMs : nil,
            lateCallbackGaps: lateCallbackGaps,
            width: width,
            height: height
        )
        resetWindow()
        return report
    }

    private func average(total: Double, count: Int) -> Double? {
        count > 0 ? total / Double(count) : nil
    }

    private func resetWindow() {
        windowStartCallbackNs = nil
        firstMediaTimestampNs = nil
        lastCallbackNs = nil
        lastMediaTimestampNs = nil
        frames = 0
        callbackGapCount = 0
        callbackGapTotalMs = 0
        callbackGapMaxMs = 0
        mediaGapCount = 0
        mediaGapTotalMs = 0
        mediaGapMaxMs = 0
        lateCallbackGaps = 0
        width = 0
        height = 0
    }
}

final class DualPlaneVideoCompositor {
    private(set) var visiblePlane: MediaPlane
    private var restorePending = false
    private var motionStartedAtNs: UInt64?
    private var motionEndedAtNs: UInt64?
    private var waitingForFirstMotionFrame = false

    init(initialPlane: MediaPlane = .detail) {
        self.visiblePlane = initialPlane
    }

    @discardableResult
    func setMotionActive(
        _ active: Bool,
        nowNs: UInt64 = DispatchTime.now().uptimeNanoseconds
    ) -> DualPlaneCompositorEvent {
        if active {
            restorePending = false
            motionStartedAtNs = nowNs
            motionEndedAtNs = nil
            waitingForFirstMotionFrame = true
            visiblePlane = .motion
            return DualPlaneCompositorEvent(
                phase: .motionStarted,
                visiblePlane: visiblePlane,
                delayMs: nil
            )
        } else if visiblePlane == .motion {
            restorePending = true
            motionEndedAtNs = nowNs
            return DualPlaneCompositorEvent(
                phase: .motionEnded,
                visiblePlane: visiblePlane,
                delayMs: MediaTimingMath.millisecondsBetween(currentNs: nowNs, previousNs: motionStartedAtNs)
            )
        } else {
            restorePending = false
            waitingForFirstMotionFrame = false
            motionStartedAtNs = nil
            motionEndedAtNs = nil
            return DualPlaneCompositorEvent(
                phase: .motionEnded,
                visiblePlane: visiblePlane,
                delayMs: nil
            )
        }
    }

    @discardableResult
    func noteFrameRendered(
        on plane: MediaPlane,
        nowNs: UInt64 = DispatchTime.now().uptimeNanoseconds
    ) -> DualPlaneCompositorEvent? {
        if waitingForFirstMotionFrame, plane == .motion {
            waitingForFirstMotionFrame = false
            return DualPlaneCompositorEvent(
                phase: .firstMotionFrame,
                visiblePlane: visiblePlane,
                delayMs: MediaTimingMath.millisecondsBetween(currentNs: nowNs, previousNs: motionStartedAtNs)
            )
        }
        guard restorePending, plane == .detail else { return nil }
        visiblePlane = .detail
        restorePending = false
        let event = DualPlaneCompositorEvent(
            phase: .detailRestored,
            visiblePlane: visiblePlane,
            delayMs: MediaTimingMath.millisecondsBetween(currentNs: nowNs, previousNs: motionEndedAtNs)
        )
        motionStartedAtNs = nil
        motionEndedAtNs = nil
        return event
    }
}

// ADR-0004 render seam. Concrete impl in R8.6.4 wraps RTCMTLVideoView; the
// AVSampleBufferDisplayLayer variant is a future drop-in via the same
// protocol.

protocol VideoFrameSink: AnyObject, Sendable {
    @MainActor var view: UIView { get }
}
