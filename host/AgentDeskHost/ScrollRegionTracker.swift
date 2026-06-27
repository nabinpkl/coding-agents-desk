import CoreGraphics
import Foundation

enum ScrollRegionSource: Equatable, Sendable {
    case window(id: UInt32)
    case cursorFallback

    var diagnosticName: String {
        switch self {
        case .window:
            return "window"
        case .cursorFallback:
            return "cursor-fallback"
        }
    }
}

struct ScrollRegionStability: Equatable, Sendable {
    let stableFrameCount: Int
    let overlapRatioWithPrevious: Double
}

struct ScrollRegion: Equatable, Sendable {
    let x: Int
    let y: Int
    let width: Int
    let height: Int
    let source: ScrollRegionSource
    let stability: ScrollRegionStability

    var maxX: Int { x + width }
    var maxY: Int { y + height }

    var rect: CGRect {
        CGRect(x: x, y: y, width: width, height: height)
    }

    func overlapRatio(with other: ScrollRegion) -> Double {
        let left = max(x, other.x)
        let top = max(y, other.y)
        let right = min(maxX, other.maxX)
        let bottom = min(maxY, other.maxY)
        guard right > left, bottom > top else { return 0 }
        let intersection = (right - left) * (bottom - top)
        let union = width * height + other.width * other.height - intersection
        guard union > 0 else { return 0 }
        return Double(intersection) / Double(union)
    }

    func isFullSurface(width surfaceWidth: Int, height surfaceHeight: Int) -> Bool {
        x == 0 && y == 0 && width == surfaceWidth && height == surfaceHeight
    }
}

struct ScrollRegionWindow: Equatable, Sendable {
    let id: UInt32
    let ownerProcessID: Int
    let layer: Int
    let bounds: CGRect
    let isOnScreen: Bool
    let alpha: Double
}

protocol ScrollRegionWindowListProvider: Sendable {
    func scrollRegionWindows() -> [ScrollRegionWindow]
}

struct CGScrollRegionWindowListProvider: ScrollRegionWindowListProvider {
    func scrollRegionWindows() -> [ScrollRegionWindow] {
        guard let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else {
            return []
        }
        return info.compactMap { entry in
            guard let bounds = bounds(from: entry[kCGWindowBounds as String])
            else { return nil }
            let id = number(entry[kCGWindowNumber as String]).map { UInt32(truncating: $0) } ?? 0
            let ownerProcessID = number(entry[kCGWindowOwnerPID as String]).map { Int(truncating: $0) } ?? -1
            let layer = number(entry[kCGWindowLayer as String]).map { Int(truncating: $0) } ?? Int.max
            let alpha = number(entry[kCGWindowAlpha as String]).map { Double(truncating: $0) } ?? 1
            let isOnScreen = bool(entry[kCGWindowIsOnscreen as String]) ?? true
            return ScrollRegionWindow(
                id: id,
                ownerProcessID: ownerProcessID,
                layer: layer,
                bounds: bounds,
                isOnScreen: isOnScreen,
                alpha: alpha
            )
        }
    }

    private func bounds(from value: Any?) -> CGRect? {
        guard let dictionary = value as? NSDictionary else { return nil }
        return CGRect(dictionaryRepresentation: dictionary)
    }

    private func number(_ value: Any?) -> NSNumber? {
        switch value {
        case let value as NSNumber:
            value
        case let value as Int:
            NSNumber(value: value)
        case let value as UInt32:
            NSNumber(value: value)
        case let value as Double:
            NSNumber(value: value)
        default:
            nil
        }
    }

    private func bool(_ value: Any?) -> Bool? {
        switch value {
        case let value as Bool:
            value
        case let value as NSNumber:
            value.boolValue
        default:
            nil
        }
    }
}

struct ScrollRegionFocusHint: Equatable, Sendable {
    let axis: ScrollActivityAxis
    let sign: Int
    let focusPoint: CGPoint
    let displayBounds: CGRect
    let activeUntilUptimeNs: UInt64
    let eventCount: Int

    func isActive(nowUptimeNs: UInt64) -> Bool {
        nowUptimeNs <= activeUntilUptimeNs
    }
}

struct ScrollRegionCandidate: Equatable, Sendable {
    let region: ScrollRegion
    let axis: ScrollActivityAxis
    let sign: Int
    let activeUntilUptimeNs: UInt64
    let eventCount: Int
}

struct ScrollRegionTracker: Sendable {
    private let activeWindowNs: UInt64
    private let stabilityOverlapThreshold: Double
    private var focusHint: ScrollRegionFocusHint?
    private var previousRegion: ScrollRegion?
    private var latestStableRegion: ScrollRegion?
    private var latestAxis: ScrollActivityAxis?
    private var latestSign: Int?
    private var acceptedValidationCount = 0
    private var missCount = 0

    init(activeWindowMs: Int = 180, stabilityOverlapThreshold: Double = 0.80) {
        self.activeWindowNs = UInt64(max(0, activeWindowMs)) * 1_000_000
        self.stabilityOverlapThreshold = min(1, max(0, stabilityOverlapThreshold))
    }

    mutating func record(_ input: NormalizedInput, focusPoint: CGPoint, displayBounds: CGRect, nowUptimeNs: UInt64) {
        guard case let .scroll(dx, dy, phase) = input,
              let sample = dominantSample(dx: dx, dy: dy)
        else { return }
        let eventCount = (focusHint?.eventCount ?? 0) + 1
        focusHint = ScrollRegionFocusHint(
            axis: sample.axis,
            sign: sample.sign,
            focusPoint: focusPoint,
            displayBounds: displayBounds,
            activeUntilUptimeNs: nowUptimeNs &+ activeWindowNs,
            eventCount: eventCount
        )
        if phase == .began || phase == .momentumBegan {
            acceptedValidationCount = 0
            missCount = 0
        }
    }

    func hint(nowUptimeNs: UInt64) -> ScrollRegionFocusHint? {
        guard let focusHint, focusHint.isActive(nowUptimeNs: nowUptimeNs) else { return nil }
        return focusHint
    }

    mutating func candidate(
        from hint: ScrollRegionFocusHint,
        surfaceWidth: Int,
        surfaceHeight: Int,
        nowUptimeNs: UInt64,
        windowListProvider: any ScrollRegionWindowListProvider = CGScrollRegionWindowListProvider()
    ) -> ScrollRegionCandidate? {
        guard hint.isActive(nowUptimeNs: nowUptimeNs) else { return nil }
        guard let region = region(
            focusPoint: hint.focusPoint,
            displayBounds: hint.displayBounds,
            surfaceSize: CGSize(width: surfaceWidth, height: surfaceHeight),
            axis: hint.axis,
            windowListProvider: windowListProvider
        ) else { return nil }
        return ScrollRegionCandidate(
            region: region,
            axis: hint.axis,
            sign: hint.sign,
            activeUntilUptimeNs: hint.activeUntilUptimeNs,
            eventCount: hint.eventCount
        )
    }

    mutating func region(
        focusPoint: CGPoint,
        displayBounds: CGRect = .zero,
        surfaceSize: CGSize,
        axis: ScrollActivityAxis,
        windowListProvider: any ScrollRegionWindowListProvider
    ) -> ScrollRegion? {
        let surfaceWidth = max(0, Int(surfaceSize.width.rounded(.toNearestOrAwayFromZero)))
        let surfaceHeight = max(0, Int(surfaceSize.height.rounded(.toNearestOrAwayFromZero)))
        guard surfaceWidth > 0, surfaceHeight > 0 else { return nil }
        let effectiveDisplayBounds = displayBounds.width > 0 && displayBounds.height > 0
            ? displayBounds
            : CGRect(x: 0, y: 0, width: CGFloat(surfaceWidth), height: CGFloat(surfaceHeight))
        let region = windowRegion(
            focusPoint: focusPoint,
            displayBounds: effectiveDisplayBounds,
            surfaceWidth: surfaceWidth,
            surfaceHeight: surfaceHeight,
            windowListProvider: windowListProvider
        ) ?? fallbackRegion(
            focusPoint: focusPoint,
            displayBounds: effectiveDisplayBounds,
            surfaceWidth: surfaceWidth,
            surfaceHeight: surfaceHeight,
            axis: axis
        )
        let stableRegion = applyStability(to: region)
        previousRegion = stableRegion
        return stableRegion
    }

    mutating func observeValidation(candidate: ScrollRegionCandidate, accepted: Bool) -> ScrollRegion? {
        guard accepted else {
            missCount += 1
            if missCount >= 2 {
                release()
            }
            return nil
        }
        missCount = 0
        let sameMotion = latestAxis == candidate.axis && latestSign == candidate.sign
        let sameSource = latestStableRegion?.source == candidate.region.source
        let overlap = latestStableRegion?.overlapRatio(with: candidate.region) ?? candidate.region.stability.overlapRatioWithPrevious
        if !sameMotion || !sameSource || overlap < stabilityOverlapThreshold {
            latestAxis = candidate.axis
            latestSign = candidate.sign
            latestStableRegion = candidate.region
            acceptedValidationCount = 1
            return nil
        }
        acceptedValidationCount += 1
        latestStableRegion = candidate.region
        return acceptedValidationCount >= 2 ? candidate.region : nil
    }

    mutating func release() {
        latestStableRegion = nil
        latestAxis = nil
        latestSign = nil
        acceptedValidationCount = 0
        missCount = 0
    }

    mutating func releaseIfMissingCandidate(_ candidate: ScrollRegionCandidate?) -> Bool {
        guard candidate == nil, stableRegion != nil else { return false }
        release()
        return true
    }

    var stableRegion: ScrollRegion? {
        acceptedValidationCount >= 2 ? latestStableRegion : nil
    }

    func isStable(candidate: ScrollRegionCandidate?) -> Bool {
        guard let candidate, let stableRegion else { return false }
        return latestAxis == candidate.axis &&
            latestSign == candidate.sign &&
            stableRegion.source == candidate.region.source &&
            stableRegion.overlapRatio(with: candidate.region) >= stabilityOverlapThreshold
    }

    private mutating func applyStability(to region: ScrollRegion) -> ScrollRegion {
        guard let previousRegion,
              previousRegion.source == region.source
        else {
            return ScrollRegion(
                x: region.x,
                y: region.y,
                width: region.width,
                height: region.height,
                source: region.source,
                stability: ScrollRegionStability(stableFrameCount: 1, overlapRatioWithPrevious: 0)
            )
        }
        let overlap = previousRegion.overlapRatio(with: region)
        let count = overlap >= stabilityOverlapThreshold
            ? previousRegion.stability.stableFrameCount + 1
            : 1
        return ScrollRegion(
            x: region.x,
            y: region.y,
            width: region.width,
            height: region.height,
            source: region.source,
            stability: ScrollRegionStability(stableFrameCount: count, overlapRatioWithPrevious: overlap)
        )
    }

    private func windowRegion(
        focusPoint: CGPoint,
        displayBounds: CGRect,
        surfaceWidth: Int,
        surfaceHeight: Int,
        windowListProvider: any ScrollRegionWindowListProvider
    ) -> ScrollRegion? {
        for window in windowListProvider.scrollRegionWindows() {
            guard isValid(window),
                  window.bounds.contains(focusPoint)
            else { continue }
            return clamp(
                rect: mapRectToSurface(window.bounds, displayBounds: displayBounds, surfaceWidth: surfaceWidth, surfaceHeight: surfaceHeight),
                source: .window(id: window.id),
                surfaceWidth: surfaceWidth,
                surfaceHeight: surfaceHeight
            )
        }
        return nil
    }

    private func isValid(_ window: ScrollRegionWindow) -> Bool {
        window.isOnScreen &&
            window.layer == 0 &&
            window.alpha > 0 &&
            window.ownerProcessID > 0 &&
            window.bounds.width >= 64 &&
            window.bounds.height >= 64
    }

    private func fallbackRegion(
        focusPoint: CGPoint,
        displayBounds: CGRect,
        surfaceWidth: Int,
        surfaceHeight: Int,
        axis: ScrollActivityAxis
    ) -> ScrollRegion {
        let maxWidth = axis == .vertical ? 1_440 : 1_600
        let maxHeight = axis == .vertical ? 1_200 : 900
        let focus = mapPointToSurface(focusPoint, displayBounds: displayBounds, surfaceWidth: surfaceWidth, surfaceHeight: surfaceHeight)
        let width = min(surfaceWidth, maxWidth)
        let height = min(surfaceHeight, maxHeight)
        return clamp(
            rect: CGRect(
                x: focus.x - CGFloat(width) / 2,
                y: focus.y - CGFloat(height) / 2,
                width: CGFloat(width),
                height: CGFloat(height)
            ),
            source: .cursorFallback,
            surfaceWidth: surfaceWidth,
            surfaceHeight: surfaceHeight
        )
    }

    private func mapPointToSurface(
        _ point: CGPoint,
        displayBounds: CGRect,
        surfaceWidth: Int,
        surfaceHeight: Int
    ) -> CGPoint {
        let scaleX = CGFloat(surfaceWidth) / displayBounds.width
        let scaleY = CGFloat(surfaceHeight) / displayBounds.height
        return CGPoint(
            x: (point.x - displayBounds.minX) * scaleX,
            y: (point.y - displayBounds.minY) * scaleY
        )
    }

    private func mapRectToSurface(
        _ rect: CGRect,
        displayBounds: CGRect,
        surfaceWidth: Int,
        surfaceHeight: Int
    ) -> CGRect {
        let origin = mapPointToSurface(rect.origin, displayBounds: displayBounds, surfaceWidth: surfaceWidth, surfaceHeight: surfaceHeight)
        let scaleX = CGFloat(surfaceWidth) / displayBounds.width
        let scaleY = CGFloat(surfaceHeight) / displayBounds.height
        return CGRect(
            x: origin.x,
            y: origin.y,
            width: rect.width * scaleX,
            height: rect.height * scaleY
        )
    }

    private func clamp(
        rect: CGRect,
        source: ScrollRegionSource,
        surfaceWidth: Int,
        surfaceHeight: Int
    ) -> ScrollRegion {
        let width = min(surfaceWidth, max(1, Int(rect.width.rounded(.toNearestOrAwayFromZero))))
        let height = min(surfaceHeight, max(1, Int(rect.height.rounded(.toNearestOrAwayFromZero))))
        let x = min(max(0, Int(rect.minX.rounded(.toNearestOrAwayFromZero))), max(0, surfaceWidth - width))
        let y = min(max(0, Int(rect.minY.rounded(.toNearestOrAwayFromZero))), max(0, surfaceHeight - height))
        return ScrollRegion(
            x: x,
            y: y,
            width: width,
            height: height,
            source: source,
            stability: ScrollRegionStability(stableFrameCount: 1, overlapRatioWithPrevious: 0)
        )
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

final class ScrollRegionHintStore: @unchecked Sendable {
    private let lock = NSLock()
    private var tracker: ScrollRegionTracker

    init(tracker: ScrollRegionTracker = ScrollRegionTracker()) {
        self.tracker = tracker
    }

    func record(
        _ input: NormalizedInput,
        focusPoint: CGPoint,
        displayBounds: CGRect,
        nowUptimeNs: UInt64 = DispatchTime.now().uptimeNanoseconds
    ) {
        lock.withLock {
            tracker.record(input, focusPoint: focusPoint, displayBounds: displayBounds, nowUptimeNs: nowUptimeNs)
        }
    }

    func hint(nowUptimeNs: UInt64 = DispatchTime.now().uptimeNanoseconds) -> ScrollRegionFocusHint? {
        lock.withLock {
            tracker.hint(nowUptimeNs: nowUptimeNs)
        }
    }
}
