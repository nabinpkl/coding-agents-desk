import Foundation

// Proposes the dominant integer offset of a scroll that input has already
// DECLARED, by row/column content-hash matching (ADR-0024).
//
// Input tells the host a scroll is happening and on which axis (the phone caused
// it); this unit proposes its signed magnitude. There is no verify floor and no
// luma tolerance: the predict-and-correct engine applies the proposed shift as a
// copyRect and then tiles the residual (the pixels that still differ against the
// shifted surface), so an imperfect proposal is corrected, not rejected. This
// unit's only job is to name the shift a copyRect should try.
//
// Method: hash each band row (vertical axis) or column (horizontal axis) of both
// surfaces over the band's cross extent, with the same FNV-1a the slot cache uses.
// For a vertical scroll of dy, a row that merely moved is byte-identical, so the
// current row i equals the previous row i-dy; the offset that makes the most rows
// hash-equal over their overlap is the dominant shift. An integer-pixel scroll
// keeps interior rows byte-identical, so the true offset wins by a wide margin
// while sub-pixel-changed rows simply do not vote (and the residual corrects
// them). The direction is recovered from the surface, not trusted from the input
// delta, whose mapping to on-screen content direction depends on the OS
// scroll-direction setting: both signs are searched and the real translation wins.
//
// Returns nil when no offset dominates: a non-translating repaint, static or
// uniform content, or two regions moving differently leave no offset that makes a
// majority of overlapping bands hash-equal, so the caller tiles the band instead
// of copying a shift that explains nothing.
//
// Top-level (not nested) to avoid shadowing the global Config from which its
// defaults are sourced.
struct ScrollOffsetEstimatorConfig: Equatable, Sendable {
    // Band geometry gates, measured on the band itself (never relative to the
    // full, possibly multi-monitor surface): a scroll band is long along the
    // axis of motion and wide enough across it to sample.
    let minScrollExtentPx: Int
    let minCrossExtentPx: Int

    static let `default` = ScrollOffsetEstimatorConfig(
        minScrollExtentPx: Config.hybridClassifierMinScrollExtentPx,
        minCrossExtentPx: Config.hybridClassifierMinCrossExtentPx
    )
}

struct ScrollOffsetEstimator {
    // A proposed offset must make at least this many bands hash-equal: an absolute
    // floor against coincidental hash collisions, so a large offset whose overlap is
    // a handful of bands cannot nominate a shift on a few accidental matches.
    private static let minMatchedBands = 8
    // ...and at least this fraction of the offset's overlapping bands. An
    // integer-pixel scroll keeps the interior byte-identical, so the real offset
    // clears a wide majority while collision noise sits near zero. This structural
    // majority is the only acceptance gate; it does not need tuning because the
    // residual corrects whatever the shift leaves behind.
    private static let dominanceRatio = 0.5

    // FNV-1a 64-bit, the same hash TileContentCache uses for slot content. Inlined
    // over the pixel pointer here to hash each band row/column without allocating a
    // Data slice per band.
    private static let fnvOffset: UInt64 = 0xcbf29ce484222325
    private static let fnvPrime: UInt64 = 0x00000100000001B3

    private let config: ScrollOffsetEstimatorConfig

    init(config: ScrollOffsetEstimatorConfig = .default) {
        self.config = config
    }

    // Returns the signed pixel offset (dy for vertical, dx for horizontal) of the
    // scroll, or nil when no offset dominates the row/column hash vote.
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

        let previousHashes = bandHashes(band: clamped, surface: previous, axis: axis)
        let currentHashes = bandHashes(band: clamped, surface: current, axis: axis)
        let n = previousHashes.count
        guard n > 1, currentHashes.count == n else { return nil }

        // Vote every signed offset that keeps some overlap, scoring exact band-hash
        // matches. The true shift matches nearly the whole overlap; every other
        // offset matches only at the collision floor.
        var bestOffset = 0
        var bestMatched = 0
        var bestOverlap = 0
        for sign in [1, -1] {
            for magnitude in 1..<n {
                let offset = sign * magnitude
                let lo = max(0, offset)
                let hi = min(n, n + offset)
                guard lo < hi else { continue }
                var matched = 0
                var i = lo
                while i < hi {
                    if currentHashes[i] == previousHashes[i - offset] { matched += 1 }
                    i += 1
                }
                let overlap = hi - lo
                // Prefer more matches; break a tie toward the smaller-magnitude shift.
                if matched > bestMatched || (matched == bestMatched && abs(offset) < abs(bestOffset)) {
                    bestMatched = matched
                    bestOffset = offset
                    bestOverlap = overlap
                }
            }
        }

        guard bestMatched >= Self.minMatchedBands,
              Double(bestMatched) >= Self.dominanceRatio * Double(bestOverlap) else {
            return nil
        }
        return bestOffset
    }

    // FNV-1a over each band row (vertical) or column (horizontal), across the band's
    // cross extent, hashing all four BGRA channels so the comparison is exact-pixel.
    private func bandHashes(band: PixelRect, surface: ScrollDeltaSurface, axis: ScrollActivityAxis) -> [UInt64] {
        surface.pixels.withUnsafeBytes { raw -> [UInt64] in
            guard let base = raw.bindMemory(to: UInt8.self).baseAddress else { return [] }
            switch axis {
            case .vertical:
                // Each row is a contiguous byte run, so the hash walks it directly.
                var result = [UInt64](repeating: 0, count: band.height)
                for row in 0..<band.height {
                    let rowStart = (band.y + row) * surface.bytesPerRow + band.x * 4
                    let rowEnd = rowStart + band.width * 4
                    var h = Self.fnvOffset
                    var i = rowStart
                    while i < rowEnd {
                        h = (h ^ UInt64(base[i])) &* Self.fnvPrime
                        i += 1
                    }
                    result[row] = h
                }
                return result
            case .horizontal:
                // Each column strides bytesPerRow between its pixels.
                var result = [UInt64](repeating: 0, count: band.width)
                for col in 0..<band.width {
                    let colStart = band.y * surface.bytesPerRow + (band.x + col) * 4
                    var h = Self.fnvOffset
                    var y = 0
                    while y < band.height {
                        let p = colStart + y * surface.bytesPerRow
                        h = (h ^ UInt64(base[p])) &* Self.fnvPrime
                        h = (h ^ UInt64(base[p + 1])) &* Self.fnvPrime
                        h = (h ^ UInt64(base[p + 2])) &* Self.fnvPrime
                        h = (h ^ UInt64(base[p + 3])) &* Self.fnvPrime
                        y += 1
                    }
                    result[col] = h
                }
                return result
            }
        }
    }
}
