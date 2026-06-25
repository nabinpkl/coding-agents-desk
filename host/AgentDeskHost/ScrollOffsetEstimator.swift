import Foundation

// Measures the exact pixel offset of a scroll that input has already DECLARED.
//
// Input tells the host that a scroll is happening and on which axis (the phone
// caused it); this unit measures the signed magnitude. The search is a 1-D
// projection correlation along the declared axis, scanning the full band extent
// in both directions. There is no offset cap: a fast Retina flick of more than
// 400 native px per frame is found here where the old brute-force probe (capped
// at 400) could not. The direction is recovered from the surface rather than
// trusted from the input delta, whose mapping to on-screen content direction
// depends on the OS scroll-direction setting; the verify floor below makes the
// both-direction search safe, so a wrong direction simply fails to verify.
//
// The projection nominates the most likely offsets; a thin 2-D overlap verify
// disposes of them. A non-translating repaint, or two regions moving
// differently, produces no offset that explains the changed pixels on the verify
// stripe, so measure() returns nil and the caller tiles the region (still
// readable) instead of applying a torn copy. Static or uniform content also
// returns nil: with nothing changed, the explained fraction is zero.
//
// Scoring is overlap-only and changed-pixel-only, the same principle proven in
// the previous classifier: a scrolled band is mostly uniform background that
// matches at any offset, and the newly-revealed leading strip has no on-surface
// source, so both are excluded and only the moved content drives the measurement.
// Tuning for ScrollOffsetEstimator. Top-level (not nested) to avoid shadowing the
// global Config from which its defaults are sourced.
struct ScrollOffsetEstimatorConfig: Equatable, Sendable {
    // Band geometry gates, measured on the band itself (never relative to the
    // full, possibly multi-monitor surface): a scroll band is long along the
    // axis of motion and wide enough across it to sample.
    let minScrollExtentPx: Int
    let minCrossExtentPx: Int
    // Per-sample luma match tolerance.
    let lumaTolerance: Int
    // Thin 2-D verify stripe extent (band height for vertical, width for
    // horizontal) so verification stays O(stripe), not O(band).
    let verifyExtent: Int
    // Minimum fraction of the stripe's changed pixels a candidate offset must
    // explain to be accepted. The single correctness gate that replaced the
    // old confidence-knob cluster.
    let verifyFloor: Double

    static let `default` = ScrollOffsetEstimatorConfig(
        minScrollExtentPx: Config.hybridClassifierMinScrollExtentPx,
        minCrossExtentPx: Config.hybridClassifierMinCrossExtentPx,
        lumaTolerance: Config.hybridClassifierLumaTolerance,
        verifyExtent: Config.hybridClassifierVerifyExtent,
        verifyFloor: Config.hybridScrollOffsetVerifyFloor
    )
}

struct ScrollOffsetEstimator {
    // Column/row stride for the 1-D projection. The projection only nominates
    // candidates that a full 2-D stripe then verifies, so a coarse stride keeps it
    // cheap without affecting correctness.
    private static let projectionStep = 4
    // Number of top projection peaks handed to the 2-D verify. The projection's
    // column averaging can blur the true peak by a row or two; verifying the few
    // best candidates recovers it. The first to clear the floor wins.
    private static let candidateCount = 3
    // Floor on verify-stripe changed samples, so a stripe where almost nothing
    // moved cannot accept an offset on a handful of coincidental matches.
    private static let minVerifyChangedSamples = 8

    private let config: ScrollOffsetEstimatorConfig

    init(config: ScrollOffsetEstimatorConfig = .default) {
        self.config = config
    }

    // Returns the signed pixel offset (dy for vertical, dx for horizontal) of the
    // scroll, or nil when no offset explains the change well enough to copy.
    func measure(
        band: PixelRect,
        previous: ScrollDeltaSurface,
        current: ScrollDeltaSurface,
        axis: ScrollActivityAxis
    ) -> Int? {
        guard previous.width == current.width, previous.height == current.height else { return nil }
        let clamped = band.clamped(toWidth: current.width, height: current.height)
        let alongExtent = axis == .vertical ? clamped.height : clamped.width
        let crossExtent = axis == .vertical ? clamped.width : clamped.height
        guard alongExtent >= config.minScrollExtentPx, crossExtent >= config.minCrossExtentPx else { return nil }

        let candidates = projectionCandidates(band: clamped, previous: previous, current: current, axis: axis)
        for candidate in candidates {
            if verify(offset: candidate, band: clamped, previous: previous, current: current, axis: axis) {
                return candidate
            }
        }
        return nil
    }

    // Build the 1-D luma projection of the band along the axis for both surfaces,
    // then score every offset in BOTH directions by the fraction of CHANGED
    // projection rows the shift explains. Returns the top signed offsets by score
    // (descending), at most candidateCount, which the 2-D verify then confirms.
    private func projectionCandidates(
        band: PixelRect,
        previous: ScrollDeltaSurface,
        current: ScrollDeltaSurface,
        axis: ScrollActivityAxis
    ) -> [Int] {
        let previousProjection = projection(band: band, surface: previous, axis: axis)
        let currentProjection = projection(band: band, surface: current, axis: axis)
        let n = previousProjection.count
        guard n > 1, currentProjection.count == n else { return [] }
        let tolerance = config.lumaTolerance

        // Indices that changed at offset 0: only these carry scroll evidence. An
        // unchanged projection row is background or a sticky header and is excluded.
        var changed = [Int]()
        changed.reserveCapacity(n)
        for i in 0..<n where abs(Int(currentProjection[i]) - Int(previousProjection[i])) > tolerance {
            changed.append(i)
        }
        guard !changed.isEmpty else { return [] }

        let maxShift = n - 1
        let minOverlap = max(2, changed.count / 4)
        var scored = [(offset: Int, score: Double)]()
        scored.reserveCapacity(2 * maxShift)
        for sign in [1, -1] {
            for magnitude in 1...maxShift {
                let signedOffset = sign * magnitude
                var total = 0
                var matched = 0
                for i in changed {
                    let source = i - signedOffset
                    guard source >= 0, source < n else { continue }
                    total += 1
                    if abs(Int(currentProjection[i]) - Int(previousProjection[source])) <= tolerance {
                        matched += 1
                    }
                }
                // Require a non-trivial overlap so a 1-row coincidence cannot win.
                guard total >= minOverlap else { continue }
                scored.append((signedOffset, Double(matched) / Double(total)))
            }
        }
        return scored
            .sorted { $0.score > $1.score }
            .prefix(Self.candidateCount)
            .map(\.offset)
    }

    // Mean luma per row (vertical) or per column (horizontal) across the band,
    // sampled at projectionStep, as UInt8. Pixels are BGRA.
    private func projection(band: PixelRect, surface: ScrollDeltaSurface, axis: ScrollActivityAxis) -> [UInt8] {
        let step = Self.projectionStep
        return surface.pixels.withUnsafeBytes { raw -> [UInt8] in
            guard let base = raw.bindMemory(to: UInt8.self).baseAddress else { return [] }
            switch axis {
            case .vertical:
                var result = [UInt8](repeating: 0, count: band.height)
                for row in 0..<band.height {
                    let y = band.y + row
                    var sum = 0
                    var count = 0
                    var x = band.x
                    while x < band.maxX {
                        sum += Int(Self.luma(base, row: y, column: x, bytesPerRow: surface.bytesPerRow))
                        count += 1
                        x += step
                    }
                    result[row] = count > 0 ? UInt8(clamping: sum / count) : 0
                }
                return result
            case .horizontal:
                var result = [UInt8](repeating: 0, count: band.width)
                for col in 0..<band.width {
                    let x = band.x + col
                    var sum = 0
                    var count = 0
                    var y = band.y
                    while y < band.maxY {
                        sum += Int(Self.luma(base, row: y, column: x, bytesPerRow: surface.bytesPerRow))
                        count += 1
                        y += step
                    }
                    result[col] = count > 0 ? UInt8(clamping: sum / count) : 0
                }
                return result
            }
        }
    }

    // Verify a candidate offset on a thin centered 2-D stripe: of the pixels that
    // changed at offset 0, the fraction the shift explains must clear verifyFloor.
    // Overlap-only (a pixel whose shift source is off-surface is the newly-revealed
    // strip and is excluded). Static content yields zero changed pixels and so
    // never passes.
    private func verify(
        offset: Int,
        band: PixelRect,
        previous: ScrollDeltaSurface,
        current: ScrollDeltaSurface,
        axis: ScrollActivityAxis
    ) -> Bool {
        let stripe = verifyStripe(band: band, axis: axis, offset: offset, surfaceWidth: current.width, surfaceHeight: current.height)
        let dx = axis == .horizontal ? offset : 0
        let dy = axis == .vertical ? offset : 0
        let tolerance = config.lumaTolerance

        return previous.pixels.withUnsafeBytes { previousRaw -> Bool in
            current.pixels.withUnsafeBytes { currentRaw -> Bool in
                guard let previousBase = previousRaw.bindMemory(to: UInt8.self).baseAddress,
                      let currentBase = currentRaw.bindMemory(to: UInt8.self).baseAddress else {
                    return false
                }
                var changed = 0
                var explained = 0
                var y = stripe.y
                while y < stripe.maxY {
                    if y >= 0, y < current.height {
                        var x = stripe.x
                        while x < stripe.maxX {
                            if x >= 0, x < current.width {
                                let sourceX = x - dx
                                let sourceY = y - dy
                                if sourceX >= 0, sourceX < previous.width,
                                   sourceY >= 0, sourceY < previous.height {
                                    let currentLuma = Self.luma(currentBase, row: y, column: x, bytesPerRow: current.bytesPerRow)
                                    let staticLuma = Self.luma(previousBase, row: y, column: x, bytesPerRow: previous.bytesPerRow)
                                    if abs(Int(currentLuma) - Int(staticLuma)) > tolerance {
                                        changed += 1
                                        let shiftedLuma = Self.luma(previousBase, row: sourceY, column: sourceX, bytesPerRow: previous.bytesPerRow)
                                        if abs(Int(currentLuma) - Int(shiftedLuma)) <= tolerance {
                                            explained += 1
                                        }
                                    }
                                }
                            }
                            x += 1
                        }
                    }
                    y += 1
                }
                guard changed >= Self.minVerifyChangedSamples else { return false }
                return Double(explained) / Double(changed) >= config.verifyFloor
            }
        }
    }

    // A thin stripe centered in the band's OVERLAP region for this offset, not its
    // geometric center. At a large offset the geometric center can fall entirely
    // inside the newly-exposed strip (no on-surface source), leaving the verify
    // with zero overlap samples. Centering on the overlap interval keeps the
    // verify on the moved content for any offset up to the band extent.
    private func verifyStripe(band: PixelRect, axis: ScrollActivityAxis, offset: Int, surfaceWidth: Int, surfaceHeight: Int) -> PixelRect {
        switch axis {
        case .vertical:
            let lo = max(band.y, max(0, offset))
            let hi = min(band.maxY, surfaceHeight + min(0, offset))
            let overlap = max(0, hi - lo)
            let extent = min(config.verifyExtent, overlap)
            let y = lo + (overlap - extent) / 2
            return PixelRect(x: band.x, y: y, width: band.width, height: extent)
        case .horizontal:
            let lo = max(band.x, max(0, offset))
            let hi = min(band.maxX, surfaceWidth + min(0, offset))
            let overlap = max(0, hi - lo)
            let extent = min(config.verifyExtent, overlap)
            let x = lo + (overlap - extent) / 2
            return PixelRect(x: x, y: band.y, width: extent, height: band.height)
        }
    }

    private static func luma(_ base: UnsafePointer<UInt8>, row: Int, column: Int, bytesPerRow: Int) -> UInt8 {
        let offset = row * bytesPerRow + column * 4
        let b = Int(base[offset])
        let g = Int(base[offset + 1])
        let r = Int(base[offset + 2])
        return UInt8(clamping: (77 * r + 150 * g + 29 * b) >> 8)
    }
}
