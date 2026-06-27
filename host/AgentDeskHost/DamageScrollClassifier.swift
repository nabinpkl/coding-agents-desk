import CoreGraphics
import Foundation

// Damage-driven scroll classifier (ADR-0021). macOS ScreenCaptureKit hands the
// host a per-frame damage region via SCStreamFrameInfoDirtyRects. A device spike
// confirmed that during a scroll the OS marks the whole scrolled content area as
// one tall band in native pixel space (not a |dy|-height strip). This classifier
// takes that band as the scroll region directly, instead of brute-force scanning
// the frame for it, then verifies the input-hinted offset only inside the band.
//
// The hint's predicted offset and sign are both unreliable (input dy is not
// screen pixels once acceleration applies, and the sign jitters frame to frame
// within one continuous scroll), so the hint contributes the axis only. The
// signed offset is recovered from the surface by a directed coarse-to-fine search
// in both directions over a thin sampled stripe, bounded to the band extent, not
// the whole frame. Trusting the hinted magnitude or sign left copyRect unable to
// fire. The band gate is on the band's own geometry, not relative to the full
// surface, so a narrow windowed scroll on a multi-monitor desktop still qualifies.
// Acceptance has no runner-up margin gate (the structurally-unsatisfiable thing
// that froze the pixel-diff path); the only margin is best-vs-static (offset 0),
// which rejects torn copies on low-detail or repetitive content where any offset
// matches.

struct PixelRect: Equatable, Sendable {
    let x: Int
    let y: Int
    let width: Int
    let height: Int

    var maxX: Int { x + width }
    var maxY: Int { y + height }
    var area: Int { max(0, width) * max(0, height) }

    func union(_ other: PixelRect) -> PixelRect {
        let minX = min(x, other.x)
        let minY = min(y, other.y)
        let unionMaxX = max(maxX, other.maxX)
        let unionMaxY = max(maxY, other.maxY)
        return PixelRect(x: minX, y: minY, width: unionMaxX - minX, height: unionMaxY - minY)
    }

    func clamped(toWidth width: Int, height: Int) -> PixelRect {
        let cx = max(0, x)
        let cy = max(0, y)
        let cMaxX = min(width, maxX)
        let cMaxY = min(height, maxY)
        return PixelRect(x: cx, y: cy, width: max(0, cMaxX - cx), height: max(0, cMaxY - cy))
    }

    static func union(of rects: [PixelRect]) -> PixelRect? {
        guard var accumulated = rects.first else { return nil }
        for rect in rects.dropFirst() {
            accumulated = accumulated.union(rect)
        }
        return accumulated
    }

    // Round a CGRect (e.g. an SCStreamFrameInfo dirty rect) outward to whole
    // pixels, so a partially-covered edge pixel is never dropped, then clamp to
    // the pixel buffer. A null/infinite/empty rect collapses to zero area.
    static func clampedPixels(from rect: CGRect, width: Int, height: Int) -> PixelRect {
        guard !rect.isNull, !rect.isInfinite, !rect.isEmpty else {
            return PixelRect(x: 0, y: 0, width: 0, height: 0)
        }
        let minX = max(0, Int(rect.minX.rounded(.down)))
        let minY = max(0, Int(rect.minY.rounded(.down)))
        let maxX = min(width, Int(rect.maxX.rounded(.up)))
        let maxY = min(height, Int(rect.maxY.rounded(.up)))
        return PixelRect(x: minX, y: minY, width: max(0, maxX - minX), height: max(0, maxY - minY))
    }
}

enum DamageScrollClassification: Equatable {
    case scroll(region: PixelRect, dx: Int, dy: Int)
    case tiles([PixelRect])
    case fullFrame(reason: String)
    case noChange
}

// Honest per-frame trace of the classifier's reasoning, so device logs show
// the real band geometry and match confidences instead of synthetic values.
struct DamageScrollTrace: Equatable {
    let bandWidth: Int
    let bandHeight: Int
    let coverage: Double
    let gatePassed: Bool
    let bestOffset: Int?
    let bestConfidence: Double
    let staticConfidence: Double
    let decision: String

    static let empty = DamageScrollTrace(
        bandWidth: 0, bandHeight: 0, coverage: 0, gatePassed: false,
        bestOffset: nil, bestConfidence: 0, staticConfidence: 0, decision: "none"
    )
}

struct DamageScrollClassifierConfig: Equatable, Sendable {
    // A scroll band is long along the axis of motion (the scrolled content forms
    // one tall strip for a vertical scroll) and wide enough across that axis to
    // sample reliably. These are measured on the damage band itself, not relative
    // to the full surface: a windowed scroll on a multi-monitor surface produces a
    // narrow-but-tall band (e.g. 606x2298 on a 3600px-wide surface), so a
    // surface-relative width gate rejected every windowed scroll. R76 confirmed.
    let minScrollExtentPx: Int
    let minCrossExtentPx: Int
    let acceptConfidence: Double
    // Shifted match must beat the no-shift (offset 0) match by this margin. This
    // is not the rejected runner-up margin; it is the anti-torn-copy guard.
    let minStaticMargin: Double
    let sampleStep: Int
    let lumaTolerance: Int
    // Directed offset search: probe magnitudes at this stride (coarse), then
    // refine +/-(coarseStep-1) around the winner at stride 1. The input hint
    // contributes the axis only; its magnitude and sign are both unreliable
    // (input dy is not screen pixels once acceleration applies, and the sign jitters
    // frame to frame), so the true signed pixel offset is recovered from the
    // surface by searching both directions, not trusted from the hint.
    let coarseStep: Int
    let maxSearchOffsetPx: Int
    // Thin verification stripe extent (band height for vertical, width for
    // horizontal) so verification stays O(stripe), not O(band).
    let verifyExtent: Int
    let maxTileCoverageRatio: Double

    // Provisional defaults. The spike log (/tmp/agentdesk-capture-damage.log)
    // is the data to calibrate these against before they are locked.
    //
    // maxTileCoverageRatio is deliberately small: an un-scrolled tile is a raw
    // LZFSE bitmap sent over the RELIABLE graphics channel, so a near-full-frame
    // tile (~600KB) saturates the single-unacked-frame fence and freezes the
    // pump. Anything bigger than this fraction must go to HEVC instead, which is
    // built for full-frame motion. R75 device run confirmed 0.6 froze.
    static let `default` = DamageScrollClassifierConfig(
        minScrollExtentPx: 120,
        minCrossExtentPx: 64,
        acceptConfidence: 0.9,
        minStaticMargin: 0.15,
        sampleStep: 8,
        lumaTolerance: 24,
        coarseStep: 8,
        maxSearchOffsetPx: 200,
        verifyExtent: 256,
        maxTileCoverageRatio: 0.15
    )
}

struct DamageScrollClassifier {
    private let config: DamageScrollClassifierConfig

    init(config: DamageScrollClassifierConfig = .default) {
        self.config = config
    }

    func classify(
        damageRects: [PixelRect],
        contentRect: PixelRect,
        previous: ScrollDeltaSurface,
        current: ScrollDeltaSurface,
        hint: ScrollActivityHint?
    ) -> DamageScrollClassification {
        classifyTraced(damageRects: damageRects, contentRect: contentRect, previous: previous, current: current, hint: hint).0
    }

    func classifyTraced(
        damageRects: [PixelRect],
        contentRect: PixelRect,
        previous: ScrollDeltaSurface,
        current: ScrollDeltaSurface,
        hint: ScrollActivityHint?
    ) -> (DamageScrollClassification, DamageScrollTrace) {
        guard previous.width == current.width, previous.height == current.height else {
            return (.fullFrame(reason: "surface-size-changed"),
                    DamageScrollTrace(bandWidth: 0, bandHeight: 0, coverage: 0, gatePassed: false, bestOffset: nil, bestConfidence: 0, staticConfidence: 0, decision: "size-changed"))
        }
        let clamped = damageRects
            .map { $0.clamped(toWidth: current.width, height: current.height) }
            .filter { $0.area > 0 }
        guard let union = PixelRect.union(of: clamped), union.area > 0 else {
            // ScreenCaptureKit delivers a frame only when the framebuffer
            // changed, so an absent or degenerate damage region means the
            // change extent is unknown, not that nothing moved. Refresh the
            // whole frame rather than risk leaving a stale screen.
            return (.fullFrame(reason: "no-damage-info"),
                    DamageScrollTrace(bandWidth: 0, bandHeight: 0, coverage: 0, gatePassed: false, bestOffset: nil, bestConfidence: 0, staticConfidence: 0, decision: "no-damage-info"))
        }

        let surfaceArea = max(1, current.width * current.height)
        let damageArea = min(surfaceArea, clamped.reduce(0) { $0 + $1.area })
        let coverage = Double(damageArea) / Double(surfaceArea)

        if let hint {
            let search = scrollOffsetSearch(band: union, previous: previous, current: current, hint: hint)
            if let offset = search.offset {
                return (.scroll(region: union, dx: offset.dx, dy: offset.dy),
                        DamageScrollTrace(bandWidth: union.width, bandHeight: union.height, coverage: coverage, gatePassed: search.gatePassed, bestOffset: search.bestOffset, bestConfidence: search.bestConfidence, staticConfidence: search.staticConfidence, decision: "scroll"))
            }
            // Scroll attempt failed: tile if small enough, else HEVC. Carry the
            // real confidences so the device log shows why scroll was rejected.
            if coverage <= config.maxTileCoverageRatio {
                return (.tiles(clamped),
                        DamageScrollTrace(bandWidth: union.width, bandHeight: union.height, coverage: coverage, gatePassed: search.gatePassed, bestOffset: search.bestOffset, bestConfidence: search.bestConfidence, staticConfidence: search.staticConfidence, decision: "tiles-scroll-miss"))
            }
            return (.fullFrame(reason: "damage-too-large-no-scroll"),
                    DamageScrollTrace(bandWidth: union.width, bandHeight: union.height, coverage: coverage, gatePassed: search.gatePassed, bestOffset: search.bestOffset, bestConfidence: search.bestConfidence, staticConfidence: search.staticConfidence, decision: "fullframe-scroll-miss"))
        }

        // No hint: tile small damage, else HEVC. Summed rect area (not the union
        // bounding box) so scattered rects are not penalised; capped at surface.
        if coverage <= config.maxTileCoverageRatio {
            return (.tiles(clamped),
                    DamageScrollTrace(bandWidth: union.width, bandHeight: union.height, coverage: coverage, gatePassed: false, bestOffset: nil, bestConfidence: 0, staticConfidence: 0, decision: "tiles-no-hint"))
        }
        return (.fullFrame(reason: "damage-too-large-no-scroll"),
                DamageScrollTrace(bandWidth: union.width, bandHeight: union.height, coverage: coverage, gatePassed: false, bestOffset: nil, bestConfidence: 0, staticConfidence: 0, decision: "fullframe-no-hint"))
    }

    struct OffsetSearch {
        let offset: ScrollDeltaOffset?
        let gatePassed: Bool
        let bestOffset: Int?
        let bestConfidence: Double
        let staticConfidence: Double
    }

    private func scrollOffsetSearch(
        band: PixelRect,
        previous: ScrollDeltaSurface,
        current: ScrollDeltaSurface,
        hint: ScrollActivityHint
    ) -> OffsetSearch {
        // Gate on the band's own geometry, axis-aware: a scroll band is long along
        // the axis of motion and wide enough across it to sample. This is measured
        // on the band, never relative to the full (possibly multi-monitor) surface,
        // so a narrow windowed scroll is not rejected for being a small fraction of
        // the desktop width.
        let axis = hint.axis
        let alongExtent = axis == .vertical ? band.height : band.width
        let crossExtent = axis == .vertical ? band.width : band.height
        guard alongExtent >= config.minScrollExtentPx, crossExtent >= config.minCrossExtentPx else {
            return OffsetSearch(offset: nil, gatePassed: false, bestOffset: nil, bestConfidence: 0, staticConfidence: 0)
        }

        // The hint contributes the axis only. Search the signed offset directly
        // against the surface in both directions (the input sign jitters frame to
        // frame): coarse stride across the plausible range each way, then refine
        // around the winner. An offset larger than the band cannot have produced
        // it, so the range is capped at the band extent along the axis of motion.
        let maxMagnitude = min(config.maxSearchOffsetPx, max(1, alongExtent - 1))
        let coarseStep = max(1, config.coarseStep)

        // Verify over a thin centered stripe, not the whole band.
        let stripe = verifyStripe(band: band, axis: axis)
        let staticConfidence = matchConfidence(region: stripe, previous: previous, current: current, axis: axis, offset: 0)

        func confidence(forOffset offset: Int) -> Double {
            matchConfidence(region: stripe, previous: previous, current: current, axis: axis, offset: offset)
        }

        var bestOffset = 0
        var bestConfidence = -1.0
        for sign in [1, -1] {
            var magnitude = coarseStep
            while magnitude <= maxMagnitude {
                let c = confidence(forOffset: sign * magnitude)
                if c > bestConfidence { bestConfidence = c; bestOffset = sign * magnitude }
                magnitude += coarseStep
            }
        }
        // Refine at unit stride within +/-(coarseStep-1) of the coarse winner, on
        // the winning side. Adjacent coarse points are coarseStep apart and each
        // refine window reaches coarseStep-1, so the windows tile without gaps.
        if bestOffset != 0 {
            let sign = bestOffset > 0 ? 1 : -1
            let bestMagnitude = abs(bestOffset)
            let lo = max(1, bestMagnitude - (coarseStep - 1))
            let hi = min(maxMagnitude, bestMagnitude + (coarseStep - 1))
            var fine = lo
            while fine <= hi {
                if fine % coarseStep != 0 {
                    let c = confidence(forOffset: sign * fine)
                    if c > bestConfidence { bestConfidence = c; bestOffset = sign * fine }
                }
                fine += 1
            }
        }

        guard bestOffset != 0 else {
            return OffsetSearch(offset: nil, gatePassed: true, bestOffset: nil, bestConfidence: 0, staticConfidence: staticConfidence)
        }
        let accepted = bestConfidence >= config.acceptConfidence
            && bestConfidence - staticConfidence >= config.minStaticMargin
        let resolved: ScrollDeltaOffset? = accepted
            ? (axis == .vertical ? ScrollDeltaOffset(dx: 0, dy: bestOffset) : ScrollDeltaOffset(dx: bestOffset, dy: 0))
            : nil
        return OffsetSearch(offset: resolved, gatePassed: true, bestOffset: bestOffset, bestConfidence: bestConfidence, staticConfidence: staticConfidence)
    }

    // A thin stripe centered in the band along the axis of motion. Verifying a
    // capped stripe keeps cost O(stripe) while still spanning enough of the
    // moved content to be representative.
    private func verifyStripe(band: PixelRect, axis: ScrollActivityAxis) -> PixelRect {
        switch axis {
        case .vertical:
            guard band.height > config.verifyExtent else { return band }
            let y = band.y + (band.height - config.verifyExtent) / 2
            return PixelRect(x: band.x, y: y, width: band.width, height: config.verifyExtent)
        case .horizontal:
            guard band.width > config.verifyExtent else { return band }
            let x = band.x + (band.width - config.verifyExtent) / 2
            return PixelRect(x: x, y: band.y, width: config.verifyExtent, height: band.height)
        }
    }

    // Fraction of sampled region pixels that match the previous frame after
    // shifting by the candidate offset. The region came from OS damage, so its
    // pixels did change; a high shifted-match therefore means the content
    // translated by the offset (a real scroll) rather than coincidental static
    // overlap.
    private func matchConfidence(
        region: PixelRect,
        previous: ScrollDeltaSurface,
        current: ScrollDeltaSurface,
        axis: ScrollActivityAxis,
        offset: Int
    ) -> Double {
        let dx = axis == .horizontal ? offset : 0
        let dy = axis == .vertical ? offset : 0
        let step = max(1, config.sampleStep)
        let tolerance = config.lumaTolerance

        return previous.pixels.withUnsafeBytes { previousRaw -> Double in
            current.pixels.withUnsafeBytes { currentRaw -> Double in
                guard let previousBase = previousRaw.bindMemory(to: UInt8.self).baseAddress,
                      let currentBase = currentRaw.bindMemory(to: UInt8.self).baseAddress else {
                    return 0
                }
                var matches = 0
                var samples = 0
                var y = region.y
                while y < region.maxY {
                    let previousY = y - dy
                    if previousY >= region.y, previousY < region.maxY,
                       previousY >= 0, previousY < previous.height,
                       y >= 0, y < current.height {
                        var x = region.x
                        while x < region.maxX {
                            let previousX = x - dx
                            if previousX >= region.x, previousX < region.maxX,
                               previousX >= 0, previousX < previous.width,
                               x >= 0, x < current.width {
                                let currentLuma = Self.luma(currentBase, currentRow: y, currentColumn: x, bytesPerRow: current.bytesPerRow)
                                let previousLuma = Self.luma(previousBase, currentRow: previousY, currentColumn: previousX, bytesPerRow: previous.bytesPerRow)
                                if abs(Int(currentLuma) - Int(previousLuma)) <= tolerance {
                                    matches += 1
                                }
                                samples += 1
                            }
                            x += step
                        }
                    }
                    y += step
                }
                return samples == 0 ? 0 : Double(matches) / Double(samples)
            }
        }
    }

    private static func luma(_ base: UnsafePointer<UInt8>, currentRow row: Int, currentColumn column: Int, bytesPerRow: Int) -> UInt8 {
        let offset = row * bytesPerRow + column * 4
        let b = Int(base[offset])
        let g = Int(base[offset + 1])
        let r = Int(base[offset + 2])
        return UInt8(clamping: (77 * r + 150 * g + 29 * b) >> 8)
    }
}
