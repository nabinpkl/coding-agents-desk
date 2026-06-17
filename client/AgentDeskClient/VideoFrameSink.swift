import UIKit

final class DualPlaneVideoCompositor {
    private(set) var visiblePlane: MediaPlane
    private var restorePending = false

    init(initialPlane: MediaPlane = .detail) {
        self.visiblePlane = initialPlane
    }

    func setMotionActive(_ active: Bool) {
        if active {
            restorePending = false
            visiblePlane = .motion
        } else if visiblePlane == .motion {
            restorePending = true
        } else {
            restorePending = false
        }
    }

    func noteFrameRendered(on plane: MediaPlane) {
        guard restorePending, plane == .detail else { return }
        visiblePlane = .detail
        restorePending = false
    }
}

// ADR-0004 render seam. Concrete impl in R8.6.4 wraps RTCMTLVideoView; the
// AVSampleBufferDisplayLayer variant is a future drop-in via the same
// protocol.

protocol VideoFrameSink: AnyObject, Sendable {
    @MainActor var view: UIView { get }
}
