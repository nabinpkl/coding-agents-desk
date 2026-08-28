import CoreGraphics
import Foundation

/// Shared by the host and standalone helper. Platform fields belong in one place.
enum DockSwipeEvent {
    enum Phase: String {
        case began, changed, ended, cancelled
        var value: Int64 {
            switch self {
            case .began: return 1
            case .changed: return 2
            case .ended: return 4
            case .cancelled: return 8
            }
        }
    }

    static func make(
        phase: Phase, progress: Double, velocityX: Double, location: CGPoint? = nil
    ) -> CGEvent? {
        guard progress.isFinite, velocityX.isFinite, let event = CGEvent(source: nil) else { return nil }
        if let location { event.location = location }
        event.setIntegerValueField(CGEventField(rawValue: 55)!, value: 30)
        event.setIntegerValueField(CGEventField(rawValue: 110)!, value: 23)
        event.setIntegerValueField(CGEventField(rawValue: 123)!, value: 1)
        event.setIntegerValueField(CGEventField(rawValue: 132)!, value: phase.value)
        event.setDoubleValueField(CGEventField(rawValue: 124)!, value: progress)
        event.setDoubleValueField(CGEventField(rawValue: 129)!, value: velocityX)
        event.setDoubleValueField(CGEventField(rawValue: 130)!, value: velocityX)
        return event
    }
}
