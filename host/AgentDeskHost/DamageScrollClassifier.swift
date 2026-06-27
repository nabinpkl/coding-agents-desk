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
// within one continuous scroll), so the hint contributes the axis only, and even
// that is optional: a bursty scroll whose hint window has lapsed arrives with no
// hint, and the axis is then derived from the band geometry (a scroll band is
// long along the axis of motion). The signed offset is always recovered from the
// surface by a directed coarse-to-fine search
// in both directions over a thin sampled stripe, bounded to the band extent, not
// the whole frame. Trusting the hinted magnitude or sign left copyRect unable to
// fire. The band gate is on the band's own geometry, not relative to the full
// surface, so a narrow windowed scroll on a multi-monitor desktop still qualifies.
// Acceptance scores an offset by the fraction of CHANGED pixels (those differing
// at offset 0) that the shift explains, not a whole-band match. On real desktop
// content a scrolled band is mostly uniform background that matches at any offset,
// so a best-vs-static margin is structurally unsatisfiable (R76: the search found
// bestDy=68 at 0.96 but static was 0.92, every frame rejected to fullFrame, which
// then froze). Restricting to changed pixels excludes the static background, and a
// minimum changed-pixel fraction rejects near-static frames that would otherwise
// accept a coincidental shift.
//
// A clean scroll clears the strict bar on the surface alone. A fast flick does
// not: a large fraction of the band is newly-revealed content (or the shift is
// subpixel), so the surface-best shift explains well under the strict threshold
// even at the true offset, and the frame fell to fullFrame (dropped by the pump).
// When that fallback was suppressed during scroll the screen froze (R74). So a
// second, input-corroborated
// path drives copyRect from the device's own scroll delta: when the strict bar is
// missed, the hint's predicted candidate offsets are scored against the surface
// and the best-explaining one is accepted at a lower bar. The offset applied is
// always the surface-validated candidate, never the raw hint magnitude (R76); the
// input only relaxes acceptance of an offset the surface confirms, so a
// wrong-direction or wrong-axis hint cannot force a torn copy. The exposed
// remainder is carried by the scroll envelope's tile.

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
    // Acceptance is the fraction of CHANGED pixels (those differing at offset 0)
    // that the shift explains. A whole-band match fraction does not discriminate
    // on real desktop content: a scrolled band is mostly uniform background that
    // matches at any offset, so the no-shift match is already ~0.92 and a
    // best-vs-static margin is structurally unsatisfiable (R76: bestDy=68
    // confidence=0.96 static=0.92 rejected). Measuring only the pixels that
    // actually moved excludes the static background by construction.
    let acceptConfidence: Double
    // Relaxed acceptance bar for an offset the input scroll independently
    // corroborates. The strict acceptConfidence rejects fast-flick frames where a
    // large fraction of the band is newly-revealed content (or the shift is
    // subpixel), even though copyRect-plus-exposed-tile is still the right call:
    // those frames fell to fullFrame (dropped by the pump), and when that path was
    // suppressed the screen froze (R74). When the input hint's predicted offset
    // (the device's own scroll
    // delta) explains a clear majority of the changed pixels, a lower bar is
    // trustworthy because the input and the surface agree; the unexplained
    // remainder is the exposed strip the scroll envelope tiles. The offset applied
    // is always the surface-validated one, never the raw hint (R76): the input
    // only relaxes acceptance of an offset the surface confirms.
    let acceptConfidenceWithPrior: Double
    // The band must have at least this fraction of changed pixels to be a
    // confident scroll, so a near-static frame (nothing moved) cannot be accepted
    // on a coincidental shift match.
    let minChangedFraction: Double
    // A near-perfect explanation is a true scroll even when the changed fraction is
    // below minChangedFraction. minChangedFraction exists only to reject a
    // coincidental shift match on a near-static frame; a shift that explains this
    // fraction or more of the changed pixels is not coincidental, it is a slow
    // scroll over low-detail content (a page of mostly-uniform background moved a
    // few pixels). Without this bypass those frames scored confidence ~1.0 yet fell
    // to a ~200KB fullframe (device run: fullframe-scroll-miss confidence=1.000000),
    // when they should have been a few-KB copyRect. The absolute floor below guards
    // against accepting on a handful of noise pixels.
    let certainConfidence: Double
    // Absolute floor of explained changed-pixel samples for the certainConfidence
    // bypass, so a frame where only one or two pixels changed (explainedFraction is
    // statistically meaningless there) cannot be promoted to a copyRect.
    let minCertainExplainedSamples: Int
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

    // Defaults are sourced from Config (env-overridable, AGENTDESK_HYBRID_CLASSIFIER_*).
    // The rationale for each value lives on the matching field above; the
    // calibrated numbers and their env keys live in Config.swift.
    static let `default` = DamageScrollClassifierConfig(
        minScrollExtentPx: Config.hybridClassifierMinScrollExtentPx,
        minCrossExtentPx: Config.hybridClassifierMinCrossExtentPx,
        acceptConfidence: Config.hybridClassifierAcceptConfidence,
        acceptConfidenceWithPrior: Config.hybridClassifierAcceptConfidenceWithPrior,
        minChangedFraction: Config.hybridClassifierMinChangedFraction,
        certainConfidence: Config.hybridClassifierCertainConfidence,
        minCertainExplainedSamples: Config.hybridClassifierMinCertainExplainedSamples,
        sampleStep: Config.hybridClassifierSampleStep,
        lumaTolerance: Config.hybridClassifierLumaTolerance,
        coarseStep: Config.hybridClassifierCoarseStep,
        maxSearchOffsetPx: Config.hybridClassifierMaxSearchOffsetPx,
        verifyExtent: Config.hybridClassifierVerifyExtent,
        maxTileCoverageRatio: Config.hybridClassifierMaxTileCoverageRatio
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

        // The scroll band is the dominant damage, not the bounding box of every
        // rect. Scattered incidental damage (cursor, a clock, a badge elsewhere on
        // the desktop) balloons the union to the whole multi-monitor surface, so a
        // copyRect would shift everything and the verify stripe would mix unrelated
        // regions and fail. Keep only rects that are a significant fraction of the
        // largest and union those.
        let largestArea = clamped.map(\.area).max() ?? 0
        let scrollBand = PixelRect.union(of: clamped.filter { Double($0.area) >= 0.5 * Double(largestArea) }) ?? union

        // Always attempt scroll detection, with or without a hint. This is the
        // Phase C fix: a bursty phone scroll whose hint window (180/600ms) has
        // lapsed arrives with no hint, and previously skipped scroll detection
        // entirely and fell to the coverage gate, misclassifying a regional CLI
        // scroll to fullframe.
        //
        // The band and axis are resolved differently by hint presence:
        //  - With a live hint, the hint supplies the axis and a corroboration path
        //    for sub-threshold flicks, and the band is the dominant-damage union
        //    (existing, device-tuned behavior, unchanged).
        //  - Without a hint there is no input to corroborate, so the geometry path
        //    is deliberately conservative: it searches the single largest damage
        //    rect (not the union of co-equal rects) and only when that rect is
        //    smaller than the full surface. The axis is then the band's aspect (a
        //    scroll band is long along the axis of motion). This rejects two cases
        //    that overlap-only scoring would otherwise accept as a torn copy:
        //    disjoint co-equal blocks (content reverting at A while the same
        //    content reappears at B, a content-cache repeat, where the largest
        //    block alone sits below the extent gate), and an exactly-full-surface
        //    repaint (a fullframe that rides the cache ladder, not a scroll). A
        //    genuine regional scroll is one tall/wide band well inside the surface,
        //    so it is unaffected. Acceptance without a hint is the surface-verified
        //    clean/certain path only (no input trust).
        let axisSource = hint != nil ? "hinted" : "geometry"
        let region: PixelRect
        let search: OffsetSearch
        if let hint {
            region = scrollBand
            search = scrollOffsetSearch(band: scrollBand, previous: previous, current: current, axis: hint.axis, hint: hint)
        } else if let largest = clamped.max(by: { $0.area < $1.area }), largest.area < surfaceArea {
            region = largest
            let axis: ScrollActivityAxis = largest.height >= largest.width ? .vertical : .horizontal
            search = scrollOffsetSearch(band: largest, previous: previous, current: current, axis: axis, hint: nil)
        } else {
            // No hint and no coherent regional band (full-surface or no dominant
            // rect): do not attempt a copy, route through the coverage gate.
            region = scrollBand
            search = OffsetSearch(offset: nil, gatePassed: false, bestOffset: nil, bestConfidence: 0, staticConfidence: 0)
        }
        if let offset = search.offset {
            return (.scroll(region: region, dx: offset.dx, dy: offset.dy),
                    DamageScrollTrace(bandWidth: region.width, bandHeight: region.height, coverage: coverage, gatePassed: search.gatePassed, bestOffset: search.bestOffset, bestConfidence: search.bestConfidence, staticConfidence: search.staticConfidence, decision: "scroll-\(axisSource)"))
        }
        // Scroll attempt failed or was not attempted: tile if small enough, else
        // reject to fullFrame. Carry the real confidences so the device log shows
        // why scroll was rejected.
        if coverage <= config.maxTileCoverageRatio {
            return (.tiles(clamped),
                    DamageScrollTrace(bandWidth: region.width, bandHeight: region.height, coverage: coverage, gatePassed: search.gatePassed, bestOffset: search.bestOffset, bestConfidence: search.bestConfidence, staticConfidence: search.staticConfidence, decision: "tiles-scroll-miss"))
        }
        return (.fullFrame(reason: "damage-too-large-no-scroll"),
                DamageScrollTrace(bandWidth: region.width, bandHeight: region.height, coverage: coverage, gatePassed: search.gatePassed, bestOffset: search.bestOffset, bestConfidence: search.bestConfidence, staticConfidence: search.staticConfidence, decision: "fullframe-scroll-miss"))
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
        axis: ScrollActivityAxis,
        hint: ScrollActivityHint?
    ) -> OffsetSearch {
        // Gate on the band's own geometry, axis-aware: a scroll band is long along
        // the axis of motion and wide enough across it to sample. This is measured
        // on the band, never relative to the full (possibly multi-monitor) surface,
        // so a narrow windowed scroll is not rejected for being a small fraction of
        // the desktop width. The axis is supplied by the caller: the hint when one
        // is live, else derived from the band geometry.
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

        // Verify over a thin centered stripe, not the whole band. Score each
        // offset by the fraction of changed pixels it explains; the offset that
        // best explains the motion wins.
        let stripe = verifyStripe(band: band, axis: axis)

        func match(forOffset offset: Int) -> ShiftMatch {
            shiftExplainsChange(region: stripe, previous: previous, current: current, axis: axis, offset: offset)
        }

        var bestOffset = 0
        var bestExplained = -1.0
        var bestChangedFraction = 0.0
        var bestExplainedCount = 0
        for sign in [1, -1] {
            var magnitude = coarseStep
            while magnitude <= maxMagnitude {
                let m = match(forOffset: sign * magnitude)
                if m.explainedFraction > bestExplained {
                    bestExplained = m.explainedFraction
                    bestChangedFraction = m.changedFraction
                    bestExplainedCount = m.explainedCount
                    bestOffset = sign * magnitude
                }
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
                    let m = match(forOffset: sign * fine)
                    if m.explainedFraction > bestExplained {
                        bestExplained = m.explainedFraction
                        bestChangedFraction = m.changedFraction
                        bestExplainedCount = m.explainedCount
                        bestOffset = sign * fine
                    }
                }
                fine += 1
            }
        }

        guard bestOffset != 0 else {
            return OffsetSearch(offset: nil, gatePassed: true, bestOffset: nil, bestConfidence: 0, staticConfidence: 0)
        }

        // High-confidence path: the surface-best shift cleanly explains the changed
        // pixels on its own, no input corroboration needed (a clean scroll, full
        // overlap). The certainConfidence bypass also accepts a near-perfect
        // explanation whose changed fraction is below minChangedFraction: a slow
        // scroll over low-detail content moves few pixels but the shift still
        // explains essentially all of them, and minChangedFraction (a guard against
        // coincidental matches on near-static frames) wrongly rejected those to a
        // ~200KB fullframe. The absolute explained-sample floor keeps a noise-only
        // frame from passing.
        let cleanScroll = bestExplained >= config.acceptConfidence
            && bestChangedFraction >= config.minChangedFraction
        let certainScroll = bestExplained >= config.certainConfidence
            && bestExplainedCount >= config.minCertainExplainedSamples
        if cleanScroll || certainScroll {
            let resolved = axis == .vertical
                ? ScrollDeltaOffset(dx: 0, dy: bestOffset)
                : ScrollDeltaOffset(dx: bestOffset, dy: 0)
            return OffsetSearch(offset: resolved, gatePassed: true, bestOffset: bestOffset, bestConfidence: bestExplained, staticConfidence: bestChangedFraction)
        }

        // Input-corroborated path: the surface-best shift did not clear the strict
        // bar (fast flick with newly-revealed content, or a subpixel shift). Drive
        // copyRect from the input scroll delta directly: evaluate the hint's
        // predicted candidate offsets (the device's own scroll deltas) against the
        // surface and accept the best-explaining one at the relaxed bar. The offset
        // applied is the surface-validated candidate, not the raw hint magnitude
        // (R76), so a wrong-direction or wrong-axis hint cannot force a torn copy:
        // its candidates simply will not explain the changed pixels. This path runs
        // only with a live hint; without one (geometry axis) there is no input to
        // corroborate, so the strict surface bar above is the only acceptance.
        if let hint {
            var inputBestOffset = 0
            var inputBestExplained = -1.0
            var inputBestChanged = 0.0
            for candidate in hint.candidateOffsets where candidate != 0 && abs(candidate) <= maxMagnitude {
                let m = match(forOffset: candidate)
                if m.explainedFraction > inputBestExplained {
                    inputBestExplained = m.explainedFraction
                    inputBestChanged = m.changedFraction
                    inputBestOffset = candidate
                }
            }
            if inputBestOffset != 0,
               inputBestExplained >= config.acceptConfidenceWithPrior,
               inputBestChanged >= config.minChangedFraction {
                let resolved = axis == .vertical
                    ? ScrollDeltaOffset(dx: 0, dy: inputBestOffset)
                    : ScrollDeltaOffset(dx: inputBestOffset, dy: 0)
                // Trace reflects the accepted input-corroborated offset.
                return OffsetSearch(offset: resolved, gatePassed: true, bestOffset: inputBestOffset, bestConfidence: inputBestExplained, staticConfidence: inputBestChanged)
            }
        }

        // Neither path qualified: reject to fullFrame. Carry the surface-best for the
        // device log. staticConfidence carries the changed-pixel fraction.
        return OffsetSearch(offset: nil, gatePassed: true, bestOffset: bestOffset, bestConfidence: bestExplained, staticConfidence: bestChangedFraction)
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

    struct ShiftMatch {
        // Of the pixels that changed between previous and current (differ at
        // offset 0), the fraction the shift explains (match within tolerance after
        // shifting previous by the offset).
        let explainedFraction: Double
        // Fraction of all sampled pixels that changed, so a near-static frame
        // (little changed) is not accepted on a coincidental shift match.
        let changedFraction: Double
        // Absolute count of changed pixels the shift explained, so the certain-scroll
        // bypass can require a floor of real moved pixels (not just a high fraction
        // over one or two samples).
        let explainedCount: Int

        static let zero = ShiftMatch(explainedFraction: 0, changedFraction: 0, explainedCount: 0)
    }

    // Measure how well shifting previous by the offset explains the pixels that
    // actually changed. A whole-band match fraction is dominated by uniform
    // background that matches at any offset; restricting to changed pixels
    // isolates the moving content, so the metric discriminates real scroll on
    // low-detail desktop content where a best-vs-static margin cannot.
    private func shiftExplainsChange(
        region: PixelRect,
        previous: ScrollDeltaSurface,
        current: ScrollDeltaSurface,
        axis: ScrollActivityAxis,
        offset: Int
    ) -> ShiftMatch {
        let dx = axis == .horizontal ? offset : 0
        let dy = axis == .vertical ? offset : 0
        let step = max(1, config.sampleStep)
        let tolerance = config.lumaTolerance

        return previous.pixels.withUnsafeBytes { previousRaw -> ShiftMatch in
            current.pixels.withUnsafeBytes { currentRaw -> ShiftMatch in
                guard let previousBase = previousRaw.bindMemory(to: UInt8.self).baseAddress,
                      let currentBase = currentRaw.bindMemory(to: UInt8.self).baseAddress else {
                    return .zero
                }
                var changed = 0
                var explained = 0
                var samples = 0
                var y = region.y
                while y < region.maxY {
                    if y >= 0, y < current.height {
                        var x = region.x
                        while x < region.maxX {
                            if x >= 0, x < current.width {
                                let previousX = x - dx
                                let previousY = y - dy
                                // Overlap-only scoring. A pixel whose shift source
                                // falls off the previous surface is in the newly
                                // revealed strip a scroll necessarily produces at the
                                // leading edge. No shift can explain it (the scroll
                                // envelope tiles it separately), so counting it as an
                                // unexplained changed pixel dragged the strict
                                // confidence below the accept bar and rejected real
                                // edge-reveal scrolls to fullframe (the device freeze).
                                // Measure the shift against the overlap region alone by
                                // sampling only pixels whose source is on-surface.
                                if previousX >= 0, previousX < previous.width,
                                   previousY >= 0, previousY < previous.height {
                                    samples += 1
                                    // previous and current share dimensions, so the
                                    // offset-0 read at (x, y) is always in bounds.
                                    let currentLuma = Self.luma(currentBase, currentRow: y, currentColumn: x, bytesPerRow: current.bytesPerRow)
                                    let staticLuma = Self.luma(previousBase, currentRow: y, currentColumn: x, bytesPerRow: previous.bytesPerRow)
                                    if abs(Int(currentLuma) - Int(staticLuma)) > tolerance {
                                        changed += 1
                                        let shiftedLuma = Self.luma(previousBase, currentRow: previousY, currentColumn: previousX, bytesPerRow: previous.bytesPerRow)
                                        if abs(Int(currentLuma) - Int(shiftedLuma)) <= tolerance {
                                            explained += 1
                                        }
                                    }
                                }
                            }
                            x += step
                        }
                    }
                    y += step
                }
                let explainedFraction = changed > 0 ? Double(explained) / Double(changed) : 0
                let changedFraction = samples > 0 ? Double(changed) / Double(samples) : 0
                return ShiftMatch(explainedFraction: explainedFraction, changedFraction: changedFraction, explainedCount: explained)
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
