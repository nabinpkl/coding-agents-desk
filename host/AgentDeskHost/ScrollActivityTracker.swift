import Foundation

enum ScrollActivityAxis: String, Equatable, Sendable {
    case vertical
    case horizontal
}

enum ScrollActivityHintSource: String, Equatable, Sendable {
    case input
    case scrollCopyOwnership
}

struct ScrollActivityHint: Equatable, Sendable {
    let axis: ScrollActivityAxis
    let sign: Int
    let predictedOffsetPx: Int
    let candidateOffsets: [Int]
    let activeUntilUptimeNs: UInt64
    let eventCount: Int
    let source: ScrollActivityHintSource

    init(
        axis: ScrollActivityAxis,
        sign: Int,
        predictedOffsetPx: Int,
        candidateOffsets: [Int],
        activeUntilUptimeNs: UInt64,
        eventCount: Int,
        source: ScrollActivityHintSource = .input
    ) {
        self.axis = axis
        self.sign = sign
        self.predictedOffsetPx = predictedOffsetPx
        self.candidateOffsets = candidateOffsets
        self.activeUntilUptimeNs = activeUntilUptimeNs
        self.eventCount = eventCount
        self.source = source
    }

    func isActive(nowUptimeNs: UInt64) -> Bool {
        nowUptimeNs <= activeUntilUptimeNs
    }
}

struct ScrollActivityTracker: Equatable {
    private static let candidateDeltas = [-16, -8, -4, -2, -1, 0, 1, 2, 4, 8, 16]

    private let activeWindowNs: UInt64
    private let maxOffsetPx: Int
    private var axis: ScrollActivityAxis?
    private var sign: Int?
    private var accumulatedOffset: Double = 0
    private var latestOffset: Double = 0
    private var activeUntilUptimeNs: UInt64 = 0
    private var eventCount: Int = 0

    init(activeWindowMs: Int = 180, maxOffsetPx: Int = 240) {
        self.activeWindowNs = UInt64(max(0, activeWindowMs)) * 1_000_000
        self.maxOffsetPx = max(1, maxOffsetPx)
    }

    mutating func record(_ input: NormalizedInput, nowUptimeNs: UInt64) {
        guard case let .scroll(dx, dy, phase) = input else { return }
        let sample = dominantSample(dx: dx, dy: dy)
        let isTerminalPhase = phase == .ended || phase == .momentumEnded
        if let sample {
            if axis != sample.axis || sign != sample.sign || phase == .began || phase == .momentumBegan {
                axis = sample.axis
                sign = sample.sign
                accumulatedOffset = 0
                latestOffset = 0
                eventCount = 0
            }
            accumulatedOffset += sample.delta
            latestOffset = sample.delta
        } else if phase == .began || phase == .momentumBegan {
            axis = nil
            sign = nil
            accumulatedOffset = 0
            latestOffset = 0
            eventCount = 0
        }
        if sample != nil || isTerminalPhase {
            eventCount += 1
            activeUntilUptimeNs = nowUptimeNs &+ activeWindowNs
        }
    }

    func hint(nowUptimeNs: UInt64) -> ScrollActivityHint? {
        guard let axis,
              let sign,
              nowUptimeNs <= activeUntilUptimeNs,
              latestOffset != 0
        else {
            return nil
        }
        let predictedOffsetPx = signedOffset(latestOffset, sign: sign)
        let accumulatedOffsetPx = signedOffset(accumulatedOffset, sign: sign)
        return ScrollActivityHint(
            axis: axis,
            sign: sign,
            predictedOffsetPx: predictedOffsetPx,
            candidateOffsets: candidateOffsets(
                primaryOffset: predictedOffsetPx,
                secondaryOffset: accumulatedOffsetPx,
                sign: sign
            ),
            activeUntilUptimeNs: activeUntilUptimeNs,
            eventCount: eventCount
        )
    }

    private func dominantSample(dx: Float, dy: Float) -> (axis: ScrollActivityAxis, sign: Int, delta: Double)? {
        let horizontal = Double(dx)
        let vertical = Double(dy)
        if abs(vertical) >= abs(horizontal), vertical != 0 {
            let sign = vertical < 0 ? -1 : 1
            return (.vertical, sign, vertical)
        }
        if horizontal != 0 {
            let sign = horizontal < 0 ? -1 : 1
            return (.horizontal, sign, horizontal)
        }
        return nil
    }

    private func signedOffset(_ value: Double, sign: Int) -> Int {
        let magnitude = min(
            maxOffsetPx,
            max(1, Int(abs(value).rounded(.toNearestOrAwayFromZero)))
        )
        return sign * magnitude
    }

    private func candidateOffsets(primaryOffset: Int, secondaryOffset: Int, sign: Int) -> [Int] {
        var seen = Set<Int>()
        var offsets: [Int] = []
        func append(_ offset: Int) {
            guard offset.signum() == sign,
                  abs(offset) >= 1,
                  abs(offset) <= maxOffsetPx else {
                return
            }
            if seen.insert(offset).inserted {
                offsets.append(offset)
            }
        }
        func appendNeighborhood(around offset: Int) {
            append(offset)
            for delta in Self.candidateDeltas {
                append(offset + delta)
            }
        }
        appendNeighborhood(around: primaryOffset)
        appendNeighborhood(around: secondaryOffset)
        if offsets.count > 24 {
            offsets = Array(offsets.prefix(24))
        }
        return offsets
    }
}

final class ScrollActivityHintStore: @unchecked Sendable {
    private let lock = NSLock()
    private var tracker: ScrollActivityTracker

    init(tracker: ScrollActivityTracker = ScrollActivityTracker()) {
        self.tracker = tracker
    }

    func record(_ input: NormalizedInput, nowUptimeNs: UInt64 = DispatchTime.now().uptimeNanoseconds) {
        lock.withLock {
            tracker.record(input, nowUptimeNs: nowUptimeNs)
        }
    }

    func hint(nowUptimeNs: UInt64 = DispatchTime.now().uptimeNanoseconds) -> ScrollActivityHint? {
        lock.withLock {
            tracker.hint(nowUptimeNs: nowUptimeNs)
        }
    }
}
