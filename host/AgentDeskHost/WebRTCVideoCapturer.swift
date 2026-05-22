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
    private let logger = Logger(subsystem: Config.launchAgentLabel, category: "webrtc")
    private var deliveredCount = 0

    init(rtcSource: RTCVideoSource, frameSource: VideoFrameSource) {
        self.frameSource = frameSource
        super.init(delegate: rtcSource)
    }

    func start() async throws {
        // Push model: frameSource invokes our closure directly on whatever
        // thread it captures on (SCStream's userInteractive sample queue for
        // production). No AsyncStream buffer, no pump Task, no async hop
        // between capture and deliver. Frames go from screen to libwebrtc
        // in ~1 ms of wall clock instead of ~70 ms.
        try await frameSource.start { [weak self] frame in
            self?.deliver(frame)
        }
        logger.notice("frameSource started; push callback installed")
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
                logger.notice("delivered frame #\(self.deliveredCount, privacy: .public) size=\(CVPixelBufferGetWidth(frame.pixelBuffer), privacy: .public)x\(CVPixelBufferGetHeight(frame.pixelBuffer), privacy: .public)")
            }
        } else {
            logger.error("capturer delegate is nil; frame dropped")
        }
    }
}
