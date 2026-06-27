import Foundation

struct ScrollViewport: Equatable, Sendable {
    let x: Int
    let y: Int
    let width: Int
    let height: Int
    let source: String
    let outerRegion: ScrollRegion
    let stability: ScrollRegionStability

    var maxX: Int { x + width }
    var maxY: Int { y + height }

    func overlapRatio(with other: ScrollViewport) -> Double {
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

    func coversOuterRegionTooClosely(maxCoverage: Double, minInsetPx: Int) -> Bool {
        let viewportArea = Double(width * height)
        let outerArea = Double(max(1, outerRegion.width * outerRegion.height))
        let coverage = viewportArea / outerArea
        let leftInset = x - outerRegion.x
        let rightInset = outerRegion.maxX - maxX
        let topInset = y - outerRegion.y
        let bottomInset = outerRegion.maxY - maxY
        let hasBoundary = leftInset >= minInsetPx ||
            rightInset >= minInsetPx ||
            topInset >= minInsetPx ||
            bottomInset >= minInsetPx
        return coverage > maxCoverage || !hasBoundary
    }
}

struct ScrollViewportConfig: Equatable, Sendable {
    let minWidth: Int
    let minHeight: Int
    let confidenceThreshold: Double
    let minInsetPx: Int
    let overlapThreshold: Double

    static let `default` = ScrollViewportConfig(
        minWidth: 320,
        minHeight: 240,
        confidenceThreshold: 0.88,
        minInsetPx: 24,
        overlapThreshold: 0.80
    )
}

struct ScrollViewportCandidate: Equatable, Sendable {
    let viewport: ScrollViewport
    let axis: ScrollActivityAxis
    let sign: Int
}

struct ScrollViewportTracker: Sendable {
    private static let bandStep = 16
    private static let maxOuterCoverage = 0.95

    private let config: ScrollViewportConfig
    private var latestStableViewport: ScrollViewport?
    private var latestAxis: ScrollActivityAxis?
    private var latestSign: Int?
    private var acceptedValidationCount = 0
    private var missCount = 0

    init(config: ScrollViewportConfig = .default) {
        self.config = config
    }

    var stableViewport: ScrollViewport? {
        acceptedValidationCount >= 2 ? latestStableViewport : nil
    }

    mutating func candidate(
        previous: ScrollDeltaSurface,
        current: ScrollDeltaSurface,
        outerRegion: ScrollRegion,
        offset: ScrollDeltaOffset
    ) -> ScrollViewportCandidate? {
        guard previous.width == current.width,
              previous.height == current.height,
              offset.dx != 0 || offset.dy != 0 else {
            return nil
        }
        let axis: ScrollActivityAxis = offset.dy != 0 ? .vertical : .horizontal
        let sign = (axis == .vertical ? offset.dy : offset.dx) < 0 ? -1 : 1
        guard let rect = axis == .vertical
            ? verticalViewport(previous: previous, current: current, outerRegion: outerRegion, offset: offset.dy)
            : horizontalViewport(previous: previous, current: current, outerRegion: outerRegion, offset: offset.dx)
        else {
            return nil
        }
        let viewport = ScrollViewport(
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            source: "derived-pixels",
            outerRegion: outerRegion,
            stability: ScrollRegionStability(
                stableFrameCount: latestStableViewport.map { viewportOverlapCount(with: rect, outerRegion: outerRegion, previous: $0) } ?? 1,
                overlapRatioWithPrevious: latestStableViewport.map {
                    ScrollViewport(
                        x: rect.x,
                        y: rect.y,
                        width: rect.width,
                        height: rect.height,
                        source: "derived-pixels",
                        outerRegion: outerRegion,
                        stability: ScrollRegionStability(stableFrameCount: 1, overlapRatioWithPrevious: 0)
                    ).overlapRatio(with: $0)
                } ?? 0
            )
        )
        guard viewport.width >= config.minWidth,
              viewport.height >= config.minHeight,
              !viewport.coversOuterRegionTooClosely(
                maxCoverage: Self.maxOuterCoverage,
                minInsetPx: config.minInsetPx
              ) else {
            return nil
        }
        return ScrollViewportCandidate(viewport: viewport, axis: axis, sign: sign)
    }

    mutating func observeValidation(candidate: ScrollViewportCandidate?, accepted: Bool) -> ScrollViewport? {
        guard accepted, let candidate else {
            missCount += 1
            if missCount >= 2 {
                release()
            }
            return nil
        }
        missCount = 0
        let sameMotion = latestAxis == candidate.axis && latestSign == candidate.sign
        let overlap = latestStableViewport?.overlapRatio(with: candidate.viewport) ?? candidate.viewport.stability.overlapRatioWithPrevious
        if !sameMotion || overlap < config.overlapThreshold {
            latestAxis = candidate.axis
            latestSign = candidate.sign
            latestStableViewport = candidate.viewport
            acceptedValidationCount = 1
            return nil
        }
        acceptedValidationCount += 1
        latestStableViewport = candidate.viewport
        return acceptedValidationCount >= 2 ? candidate.viewport : nil
    }

    mutating func release() {
        latestStableViewport = nil
        latestAxis = nil
        latestSign = nil
        acceptedValidationCount = 0
        missCount = 0
    }

    private func viewportOverlapCount(with rect: Rect, outerRegion: ScrollRegion, previous: ScrollViewport) -> Int {
        let viewport = ScrollViewport(
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            source: "derived-pixels",
            outerRegion: outerRegion,
            stability: ScrollRegionStability(stableFrameCount: 1, overlapRatioWithPrevious: 0)
        )
        return viewport.overlapRatio(with: previous) >= config.overlapThreshold
            ? previous.stability.stableFrameCount + 1
            : 1
    }

    private func verticalViewport(
        previous: ScrollDeltaSurface,
        current: ScrollDeltaSurface,
        outerRegion: ScrollRegion,
        offset: Int
    ) -> Rect? {
        matchingViewport(previous: previous, current: current, outerRegion: outerRegion, dx: 0, dy: offset)
    }

    private func horizontalViewport(
        previous: ScrollDeltaSurface,
        current: ScrollDeltaSurface,
        outerRegion: ScrollRegion,
        offset: Int
    ) -> Rect? {
        matchingViewport(previous: previous, current: current, outerRegion: outerRegion, dx: offset, dy: 0)
    }

    private func matchingViewport(
        previous: ScrollDeltaSurface,
        current: ScrollDeltaSurface,
        outerRegion: ScrollRegion,
        dx: Int,
        dy: Int
    ) -> Rect? {
        previous.pixels.withUnsafeBytes { previousBytes in
            current.pixels.withUnsafeBytes { currentBytes in
                guard let previousBase = previousBytes.bindMemory(to: UInt8.self).baseAddress,
                      let currentBase = currentBytes.bindMemory(to: UInt8.self).baseAddress else {
                    return nil
                }
                var minX = Int.max
                var minY = Int.max
                var maxX = Int.min
                var maxY = Int.min
                var matchedCells = 0
                for y in stride(from: outerRegion.y, to: outerRegion.maxY, by: Self.bandStep) {
                    let cellBottom = min(outerRegion.maxY, y + Self.bandStep)
                    for x in stride(from: outerRegion.x, to: outerRegion.maxX, by: Self.bandStep) {
                        let cellRight = min(outerRegion.maxX, x + Self.bandStep)
                        if cellConfidence(
                            previous: previous,
                            current: current,
                            previousBase: previousBase,
                            currentBase: currentBase,
                            xRange: x..<cellRight,
                            yRange: y..<cellBottom,
                            dx: dx,
                            dy: dy
                        ) >= config.confidenceThreshold {
                            minX = min(minX, x)
                            minY = min(minY, y)
                            maxX = max(maxX, cellRight)
                            maxY = max(maxY, cellBottom)
                            matchedCells += 1
                        }
                    }
                }
                guard matchedCells > 0,
                      maxX > minX,
                      maxY > minY else {
                    return nil
                }
                return Rect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
            }
        }
    }

    private func cellConfidence(
        previous: ScrollDeltaSurface,
        current: ScrollDeltaSurface,
        previousBase: UnsafePointer<UInt8>,
        currentBase: UnsafePointer<UInt8>,
        xRange: Range<Int>,
        yRange: Range<Int>,
        dx: Int,
        dy: Int
    ) -> Double {
        var matches = 0
        var samples = 0
        for y in stride(from: yRange.lowerBound, to: yRange.upperBound, by: 8) {
            for x in stride(from: xRange.lowerBound, to: xRange.upperBound, by: 8) {
                let previousX = x - dx
                let previousY = y - dy
                guard previousX >= 0,
                      previousX < previous.width,
                      previousY >= 0,
                      previousY < previous.height else {
                    continue
                }
                let shiftedMatches = pixelsMatch(
                    previous: previous,
                    current: current,
                    previousBase: previousBase,
                    currentBase: currentBase,
                    previousX: previousX,
                    previousY: previousY,
                    currentX: x,
                    currentY: y
                )
                let unchanged = pixelsMatch(
                    previous: previous,
                    current: current,
                    previousBase: previousBase,
                    currentBase: currentBase,
                    previousX: x,
                    previousY: y,
                    currentX: x,
                    currentY: y
                )
                if shiftedMatches && !unchanged {
                    matches += 1
                }
                samples += 1
            }
        }
        return samples == 0 ? 0 : Double(matches) / Double(samples)
    }

    private func pixelsMatch(
        previous: ScrollDeltaSurface,
        current: ScrollDeltaSurface,
        previousBase: UnsafePointer<UInt8>,
        currentBase: UnsafePointer<UInt8>,
        previousX: Int,
        previousY: Int,
        currentX: Int,
        currentY: Int
    ) -> Bool {
        guard previousX >= 0, previousX < previous.width,
              previousY >= 0, previousY < previous.height,
              currentX >= 0, currentX < current.width,
              currentY >= 0, currentY < current.height else {
            return false
        }
        let previousOffset = previousY * previous.bytesPerRow + previousX * 4
        let currentOffset = currentY * current.bytesPerRow + currentX * 4
        let previousLuma = luma(
            b: previousBase[previousOffset],
            g: previousBase[previousOffset + 1],
            r: previousBase[previousOffset + 2]
        )
        let currentLuma = luma(
            b: currentBase[currentOffset],
            g: currentBase[currentOffset + 1],
            r: currentBase[currentOffset + 2]
        )
        return abs(Int(previousLuma) - Int(currentLuma)) <= 24
    }

    private func luma(b: UInt8, g: UInt8, r: UInt8) -> UInt8 {
        UInt8(clamping: (77 * Int(r) + 150 * Int(g) + 29 * Int(b)) >> 8)
    }
}

private struct Rect: Equatable {
    let x: Int
    let y: Int
    let width: Int
    let height: Int

    var maxX: Int { x + width }
    var maxY: Int { y + height }
}
