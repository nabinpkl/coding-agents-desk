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

    init(compositor: DualPlaneVideoCompositor = DualPlaneVideoCompositor()) {
        self.compositor = compositor
        detailSink = RTCMTLVideoSink()
        motionSink = RTCMTLVideoSink()
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
        compositor.setMotionActive(active)
        applyVisiblePlane()
    }

    func noteFrameRendered(on plane: MediaPlane) {
        compositor.noteFrameRendered(on: plane)
        applyVisiblePlane()
    }

    private func applyVisiblePlane() {
        detailSink.view.isHidden = compositor.visiblePlane != .detail
        motionSink.view.isHidden = compositor.visiblePlane != .motion
    }
}
