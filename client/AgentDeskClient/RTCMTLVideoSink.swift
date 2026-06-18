import UIKit
import WebRTC
import os

// ADR-0004 concrete VideoFrameSink impl, client side. Wraps an
// RTCMTLVideoView (libwebrtc's Metal-backed renderer). Swappable for
// AVSampleBufferVideoSink without changing call sites.

final class RTCMTLVideoSink: VideoFrameSink, @unchecked Sendable {
    let view: UIView
    let renderer: RTCMTLVideoView

    @MainActor
    init() {
        let metalView = RTCMTLVideoView(frame: .zero)
        metalView.videoContentMode = .scaleAspectFit
        metalView.backgroundColor = .black
        renderer = metalView
        view = metalView
    }
}

@MainActor
final class DualPlaneVideoSink: VideoFrameSink, @unchecked Sendable {
    let view: UIView
    let compositor: DualPlaneVideoCompositor
    private let detailSink: RTCMTLVideoSink
    private let motionSink: RTCMTLVideoSink
    private let logger = Logger(subsystem: "com.example.agentdesk.AgentDeskClient", category: "webrtc")
    private let cadenceTrackers: [MediaPlane: VideoRenderCadenceTracker]

    init(compositor: DualPlaneVideoCompositor = DualPlaneVideoCompositor()) {
        self.compositor = compositor
        detailSink = RTCMTLVideoSink()
        motionSink = RTCMTLVideoSink()
        cadenceTrackers = [
            .detail: VideoRenderCadenceTracker(plane: .detail),
            .motion: VideoRenderCadenceTracker(plane: .motion)
        ]
        let container = UIView(frame: .zero)
        container.backgroundColor = .black
        view = container
        for sink in [detailSink, motionSink] {
            sink.view.translatesAutoresizingMaskIntoConstraints = false
            container.addSubview(sink.view)
            NSLayoutConstraint.activate([
                sink.view.leadingAnchor.constraint(equalTo: container.leadingAnchor),
                sink.view.trailingAnchor.constraint(equalTo: container.trailingAnchor),
                sink.view.topAnchor.constraint(equalTo: container.topAnchor),
                sink.view.bottomAnchor.constraint(equalTo: container.bottomAnchor)
            ])
        }
        applyVisiblePlane()
    }

    func sink(for plane: MediaPlane) -> RTCMTLVideoSink {
        switch plane {
        case .detail: detailSink
        case .motion: motionSink
        }
    }

    func setMotionActive(_ active: Bool) {
        let event = compositor.setMotionActive(active)
        for tracker in cadenceTrackers.values {
            if let report = tracker.setScrollActive(active) {
                log(report)
            }
        }
        applyVisiblePlane()
        log(event)
    }

    func noteFrameRendered(_ sample: VideoRenderCadenceSample) {
        if let report = cadenceTrackers[sample.plane]?.note(sample) {
            log(report)
        }
        let event = compositor.noteFrameRendered(on: sample.plane, nowNs: sample.callbackUptimeNs)
        applyVisiblePlane()
        if let event {
            log(event)
        }
    }

    private func applyVisiblePlane() {
        detailSink.view.isHidden = compositor.visiblePlane != .detail
        motionSink.view.isHidden = compositor.visiblePlane != .motion
    }

    private func log(_ event: DualPlaneCompositorEvent) {
        let line = "scroll-compositor phase=\(event.phase.logName) visiblePlane=\(event.visiblePlane.rawValue) delayMs=\(MediaTimingMath.formatMilliseconds(event.delayMs))"
        logger.notice("\(line, privacy: .public)")
        emitConsoleDiagnostic(line)
    }

    private func log(_ report: VideoRenderCadenceReport) {
        let line = "render-cadence reason=\(report.reason) plane=\(report.plane.rawValue) visiblePlane=\(compositor.visiblePlane.rawValue) scrollActive=\(report.scrollActive) frames=\(report.frames) callbackWindowMs=\(MediaTimingMath.formatMilliseconds(report.callbackWindowMs)) avgCallbackGapMs=\(MediaTimingMath.formatMilliseconds(report.avgCallbackGapMs)) maxCallbackGapMs=\(MediaTimingMath.formatMilliseconds(report.maxCallbackGapMs)) mediaWindowMs=\(MediaTimingMath.formatMilliseconds(report.mediaWindowMs)) avgMediaGapMs=\(MediaTimingMath.formatMilliseconds(report.avgMediaGapMs)) maxMediaGapMs=\(MediaTimingMath.formatMilliseconds(report.maxMediaGapMs)) lateCallbackGaps=\(report.lateCallbackGaps) size=\(report.width)x\(report.height)"
        logger.notice("\(line, privacy: .public)")
        emitConsoleDiagnostic(line)
    }

    private func emitConsoleDiagnostic(_ line: String) {
        #if DEBUG
        print("[AgentDeskClient:webrtc] \(line)")
        #endif
    }
}

private extension DualPlaneCompositorEvent.Phase {
    var logName: String {
        switch self {
        case .motionStarted: return "motion-started"
        case .motionEnded: return "motion-ended"
        case .firstMotionFrame: return "first-motion-frame"
        case .detailRestored: return "detail-restored"
        }
    }
}
