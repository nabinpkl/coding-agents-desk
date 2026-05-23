import UIKit
import WebRTC

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
        renderer = metalView
        view = metalView
    }
}
