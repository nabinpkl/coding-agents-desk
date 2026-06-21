import Foundation

struct ScrollCopyOwnershipConfig: Equatable, Sendable {
    let ownershipTTLNs: UInt64
    let fallbackAfterNs: UInt64
    let maxMisses: Int

    init(
        ownershipTTLMs: Int = 500,
        fallbackAfterMs: Int = 300,
        maxMisses: Int = 2
    ) {
        self.ownershipTTLNs = UInt64(max(0, ownershipTTLMs)) * 1_000_000
        self.fallbackAfterNs = UInt64(max(0, fallbackAfterMs)) * 1_000_000
        self.maxMisses = max(0, maxMisses)
    }
}

struct ScrollCopyOwnership: Equatable {
    private let config: ScrollCopyOwnershipConfig
    private(set) var latestInputHint: ScrollActivityHint?
    private(set) var latestAcceptedAxis: ScrollActivityAxis?
    private(set) var latestAcceptedSign: Int?
    private(set) var latestAcceptedOffsetPx: Int?
    private(set) var latestAcceptedFrameId: UInt64?
    private(set) var latestAcceptedAtUptimeNs: UInt64?
    private(set) var missCount: Int = 0
    private(set) var activeUntilUptimeNs: UInt64 = 0

    init(config: ScrollCopyOwnershipConfig = ScrollCopyOwnershipConfig()) {
        self.config = config
    }

    mutating func observeInputHint(_ hint: ScrollActivityHint?) {
        latestInputHint = hint
    }

    mutating func observeAccepted(
        axis: ScrollActivityAxis,
        sign: Int,
        offsetPx: Int,
        frameId: UInt64,
        nowUptimeNs: UInt64
    ) {
        let normalizedSign = sign < 0 ? -1 : 1
        let magnitude = abs(offsetPx)
        guard magnitude > 0 else { return }
        latestAcceptedAxis = axis
        latestAcceptedSign = normalizedSign
        latestAcceptedOffsetPx = normalizedSign * magnitude
        latestAcceptedFrameId = frameId
        latestAcceptedAtUptimeNs = nowUptimeNs
        missCount = 0
        activeUntilUptimeNs = Self.saturatingAdd(nowUptimeNs, config.ownershipTTLNs)
    }

    mutating func observeMiss(nowUptimeNs: UInt64) {
        guard hasActiveOwnership(nowUptimeNs: nowUptimeNs) else { return }
        missCount += 1
    }

    mutating func release() {
        latestInputHint = nil
        latestAcceptedAxis = nil
        latestAcceptedSign = nil
        latestAcceptedOffsetPx = nil
        latestAcceptedFrameId = nil
        latestAcceptedAtUptimeNs = nil
        missCount = 0
        activeUntilUptimeNs = 0
    }

    func hint(nowUptimeNs: UInt64) -> ScrollActivityHint? {
        if let latestInputHint, latestInputHint.isActive(nowUptimeNs: nowUptimeNs) {
            return latestInputHint
        }
        guard hasActiveOwnership(nowUptimeNs: nowUptimeNs),
              missCount < config.maxMisses,
              let axis = latestAcceptedAxis,
              let sign = latestAcceptedSign,
              let offsetPx = latestAcceptedOffsetPx else {
            return nil
        }
        return ScrollActivityHint(
            axis: axis,
            sign: sign,
            predictedOffsetPx: offsetPx,
            candidateOffsets: [offsetPx],
            activeUntilUptimeNs: activeUntilUptimeNs,
            eventCount: 1,
            source: .scrollCopyOwnership
        )
    }

    func allowsHevcFallback(nowUptimeNs: UInt64) -> Bool {
        guard hasActiveOwnership(nowUptimeNs: nowUptimeNs),
              let latestAcceptedAtUptimeNs else {
            return true
        }
        if missCount >= config.maxMisses {
            return true
        }
        return Self.elapsedNs(from: latestAcceptedAtUptimeNs, to: nowUptimeNs) >= config.fallbackAfterNs
    }

    private func hasActiveOwnership(nowUptimeNs: UInt64) -> Bool {
        latestAcceptedFrameId != nil && nowUptimeNs <= activeUntilUptimeNs
    }

    private static func elapsedNs(from start: UInt64, to end: UInt64) -> UInt64 {
        end >= start ? end - start : 0
    }

    private static func saturatingAdd(_ lhs: UInt64, _ rhs: UInt64) -> UInt64 {
        lhs > UInt64.max - rhs ? UInt64.max : lhs + rhs
    }
}
