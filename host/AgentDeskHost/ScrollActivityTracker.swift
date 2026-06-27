import Foundation

enum ScrollActivityAxis: String, Equatable, Sendable {
    case vertical
    case horizontal
}

// What input DECLARES about content motion, the macOS-native substitute for the
// OS scroll order RDP gets on Windows: the phone caused the scroll, so the host
// is told the axis and direction directly. The magnitude is absent and not needed:
// a declared scroll routes to the HEVC video carrier, which does its own motion
// estimation in hardware. A nil signal means rest (no active scroll within the
// debounce window). Presence means scrolling.
struct MotionSignal: Equatable, Sendable {
    let axis: ScrollActivityAxis
    let sign: Int
}

// Tracks whether content is scrolling, and on which axis and in which direction,
// from the client's scroll input. It deliberately does NOT predict a pixel
// magnitude: the previous design's predicted offset and candidate list were a
// fragile input-to-pixel mapping, and the surface estimator measures the offset
// directly. The active-window debounce keeps a bursty flick reading as scrolling
// across the gap between input bursts and settles to rest once the window lapses.
struct ScrollActivityTracker: Equatable {
    private let activeWindowNs: UInt64
    private var axis: ScrollActivityAxis?
    private var sign: Int?
    private var activeUntilUptimeNs: UInt64 = 0

    init(activeWindowMs: Int = 180) {
        self.activeWindowNs = UInt64(max(0, activeWindowMs)) * 1_000_000
    }

    mutating func record(_ input: NormalizedInput, nowUptimeNs: UInt64) {
        guard case let .scroll(dx, dy, phase) = input else { return }
        let sample = dominantSample(dx: dx, dy: dy)
        let isTerminalPhase = phase == .ended || phase == .momentumEnded
        if let sample {
            if axis != sample.axis || sign != sample.sign || phase == .began || phase == .momentumBegan {
                axis = sample.axis
                sign = sample.sign
            }
        } else if phase == .began || phase == .momentumBegan {
            axis = nil
            sign = nil
        }
        if sample != nil || isTerminalPhase {
            activeUntilUptimeNs = nowUptimeNs &+ activeWindowNs
        }
    }

    // Scrolling (axis + sign) while a scroll is active within the debounce window,
    // else nil (rest).
    func motionSignal(nowUptimeNs: UInt64) -> MotionSignal? {
        guard let axis, let sign, nowUptimeNs <= activeUntilUptimeNs else { return nil }
        return MotionSignal(axis: axis, sign: sign)
    }

    private func dominantSample(dx: Float, dy: Float) -> (axis: ScrollActivityAxis, sign: Int)? {
        let horizontal = Double(dx)
        let vertical = Double(dy)
        if abs(vertical) >= abs(horizontal), vertical != 0 {
            return (.vertical, vertical < 0 ? -1 : 1)
        }
        if horizontal != 0 {
            return (.horizontal, horizontal < 0 ? -1 : 1)
        }
        return nil
    }
}

// Thread-safe holder the input path writes and the encode pump reads.
final class ScrollActivityStore: @unchecked Sendable {
    private let lock = NSLock()
    private var tracker: ScrollActivityTracker

    init(tracker: ScrollActivityTracker = ScrollActivityTracker(activeWindowMs: Config.hybridScrollActiveWindowMs)) {
        self.tracker = tracker
    }

    func record(_ input: NormalizedInput, nowUptimeNs: UInt64 = DispatchTime.now().uptimeNanoseconds) {
        lock.withLock {
            tracker.record(input, nowUptimeNs: nowUptimeNs)
        }
    }

    func motionSignal(nowUptimeNs: UInt64 = DispatchTime.now().uptimeNanoseconds) -> MotionSignal? {
        lock.withLock {
            tracker.motionSignal(nowUptimeNs: nowUptimeNs)
        }
    }
}
