import UIKit

// ADR-0004 render seam. Concrete impl in R8.6.4 wraps RTCMTLVideoView; the
// AVSampleBufferDisplayLayer variant is a future drop-in via the same
// protocol.

protocol VideoFrameSink: AnyObject, Sendable {
    @MainActor var view: UIView { get }
}
