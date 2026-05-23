import Foundation
import WebRTC

// ADR-0004 bridge: wraps a VideoFrameSource and pumps frames into an
// RTCVideoSource as RTCCVPixelBuffers. This is the only file alongside
// LibWebRTCMediaTransport that imports WebRTC on the host. The
// ScreenCaptureKit-vs-TestPattern choice lives one level up in
// VideoFrameSource; this bridge is codec-agnostic.

final class WebRTCVideoCapturer: RTCVideoCapturer, @unchecked Sendable {
    private let frameSource: VideoFrameSource
    private var pumpTask: Task<Void, Never>?

    init(rtcSource: RTCVideoSource, frameSource: VideoFrameSource) {
        self.frameSource = frameSource
        super.init(delegate: rtcSource)
    }

    func start() async throws {
        try await frameSource.start()
        pumpTask = Task { [weak self, frameSource] in
            for await frame in frameSource.frames {
                self?.deliver(frame)
                if Task.isCancelled { return }
            }
        }
    }

    func stop() {
        pumpTask?.cancel()
        pumpTask = nil
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
        delegate?.capturer(self, didCapture: rtcFrame)
    }
}
