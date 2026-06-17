import Foundation
import WebRTC
import os

// ADR-0004 bridge: wraps a VideoFrameSource and pumps frames into an
// RTCVideoSource as RTCCVPixelBuffers. This is the only file alongside
// LibWebRTCMediaTransport that imports WebRTC on the host. The
// ScreenCaptureKit-vs-TestPattern choice lives one level up in
// VideoFrameSource; this bridge is codec-agnostic.

final class WebRTCVideoCapturer: RTCVideoCapturer, @unchecked Sendable {
    private let frameSource: VideoFrameSource
    private let plane: MediaPlane
    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "webrtc")
    private var deliveredCount = 0
    // Serial queue we dispatch deliver() onto from the frameSource callback.
    // The push refactor removed our AsyncStream buffer (good, ~70 ms latency
    // win) but accidentally also removed the thread hop the pump Task used
    // to provide. Without that hop, libwebrtc's frame adaptation runs on
    // SCStream's sample queue and back-pressures SCStream itself, which
    // throttles to protect its queueDepth=3 budget. Result: stale frames,
    // visible cursor lag. This queue restores the isolation (no buffering,
    // just a thread handoff in microseconds).
    private let deliverQueue = DispatchQueue(label: "com.example.agentdesk.AgentDeskHost.webrtc.deliver", qos: .userInteractive)

    init(rtcSource: RTCVideoSource, frameSource: VideoFrameSource, plane: MediaPlane = .detail) {
        self.frameSource = frameSource
        self.plane = plane
        super.init(delegate: rtcSource)
    }

    func start() async throws {
        try await frameSource.start { [weak self, deliverQueue] frame in
            deliverQueue.async {
                self?.deliver(frame)
            }
        }
        logger.notice("frameSource started plane=\(self.plane.rawValue, privacy: .public); push callback installed")
    }

    func stop() {
        frameSource.stop()
    }

    private func deliver(_ frame: CapturedVideoFrame) {
        let buffer = RTCCVPixelBuffer(pixelBuffer: frame.pixelBuffer)
        let rotation: RTCVideoRotation
        switch frame.rotation {
        case ._0: rotation = ._0
        case ._90: rotation = ._90
        case ._180: rotation = ._180
        case ._270: rotation = ._270
        }
        let rtcFrame = RTCVideoFrame(
            buffer: buffer,
            rotation: rotation,
            timeStampNs: frame.presentationTimeNs
        )
        if let delegate = delegate {
            delegate.capturer(self, didCapture: rtcFrame)
            deliveredCount += 1
            if deliveredCount % 30 == 1 {
                let nowNs = DispatchTime.now().uptimeNanoseconds
                let captureToDeliverMs = MediaTimingMath.formatMilliseconds(
                    MediaTimingMath.millisecondsBetween(currentNs: nowNs, previousNs: frame.capturedAtUptimeNs)
                )
                logger.notice("capture-to-capturer plane=\(self.plane.rawValue, privacy: .public) frame=\(self.deliveredCount, privacy: .public) ageMs=\(captureToDeliverMs, privacy: .public) size=\(CVPixelBufferGetWidth(frame.pixelBuffer), privacy: .public)x\(CVPixelBufferGetHeight(frame.pixelBuffer), privacy: .public)")
            }
        } else {
            logger.error("capturer delegate is nil; frame dropped")
        }
    }
}
