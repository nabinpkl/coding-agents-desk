import CoreGraphics
import Foundation

// Damage-driven scroll classifier (ADR-0021). macOS ScreenCaptureKit hands the
// host a per-frame damage region via SCStreamFrameInfoDirtyRects. A device spike
// confirmed that during a scroll the OS marks the whole scrolled content area as
// one tall band in native pixel space (not a |dy|-height strip). This classifier
// takes that band as the scroll region directly, instead of brute-force scanning
// the frame for it, then verifies the input-hinted offset only inside the band.
//
// There is no full-frame candidate sweep. The hint's predicted offset is
// approximate (input dy is not screen pixels once acceleration applies), so a
// small bounded neighbourhood around the predicted offset is probed over a thin
// sampled stripe, not the whole band. Acceptance still has no runner-up margin
// gate (the structurally-unsatisfiable thing that froze the pixel-diff path);
// the only margin is best-vs-static (offset 0), which rejects torn copies on
// low-detail or repetitive content where any offset matches.

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

struct DamageScrollClassifierConfig: Equatable, Sendable {
    // Band must span at least this fraction of contentRect width to be a scroll
    // candidate, per the spike (real scroll bands are near full content width).
    let minBandWidthRatio: Double
    let minBandHeight: Int
    let acceptConfidence: Double
    // Shifted match must beat the no-shift (offset 0) match by this margin. This
    // is not the rejected runner-up margin; it is the anti-torn-copy guard.
    let minStaticMargin: Double
    let sampleStep: Int
    let lumaTolerance: Int
    // Cap on how many hinted offsets we probe, closest-to-predicted first.
    let maxCandidateProbes: Int
    // Thin verification stripe extent (band height for vertical, width for
    // horizontal) so verification stays O(stripe), not O(band).
    let verifyExtent: Int
    let maxTileCoverageRatio: Double

    // Provisional defaults. The spike log (/tmp/agentdesk-capture-damage.log)
    // is the data to calibrate these against before they are locked.
    static let `default` = DamageScrollClassifierConfig(
        minBandWidthRatio: 0.6,
        minBandHeight: 80,
        acceptConfidence: 0.9,
        minStaticMargin: 0.15,
        sampleStep: 8,
        lumaTolerance: 24,
        maxCandidateProbes: 5,
        verifyExtent: 256,
        maxTileCoverageRatio: 0.6
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
        guard previous.width == current.width, previous.height == current.height else {
            return .fullFrame(reason: "surface-size-changed")
        }
        let clamped = damageRects
            .map { $0.clamped(toWidth: current.width, height: current.height) }
            .filter { $0.area > 0 }
        guard let union = PixelRect.union(of: clamped), union.area > 0 else {
            // ScreenCaptureKit delivers a frame only when the framebuffer
            // changed, so an absent or degenerate damage region means the
            // change extent is unknown, not that nothing moved. Refresh the
            // whole frame rather than risk leaving a stale screen.
            return .fullFrame(reason: "no-damage-info")
        }

        let contentWidth = contentRect.area > 0 ? contentRect.width : current.width
        if let hint, let offset = scrollOffset(band: union, contentWidth: contentWidth, previous: previous, current: current, hint: hint) {
            return .scroll(region: union, dx: offset.dx, dy: offset.dy)
        }

        // No scroll: tile the damage, fall back to a full frame when the damage
        // covers most of the surface (the graphics tile path would not pay
        // there). Use summed rect area, not the union bounding box, so two small
        // rects in opposite corners are not penalised as if they were one huge
        // rect. Overlap can over-count, so cap the ratio at the surface area.
        let surfaceArea = max(1, current.width * current.height)
        let damageArea = min(surfaceArea, clamped.reduce(0) { $0 + $1.area })
        let coverage = Double(damageArea) / Double(surfaceArea)
        if coverage <= config.maxTileCoverageRatio {
            return .tiles(clamped)
        }
        return .fullFrame(reason: "damage-too-large-no-scroll")
    }

    private func scrollOffset(
        band: PixelRect,
        contentWidth: Int,
        previous: ScrollDeltaSurface,
        current: ScrollDeltaSurface,
        hint: ScrollActivityHint
    ) -> ScrollDeltaOffset? {
        let minBandWidth = Int(Double(contentWidth) * config.minBandWidthRatio)
        guard band.width >= minBandWidth, band.height >= config.minBandHeight else {
            return nil
        }

        // Probe the predicted offset plus its closest hinted neighbours, deduped
        // and bounded, instead of the whole candidate list. The predicted offset
        // leads; ties break toward it.
        var seen = Set<Int>()
        var candidates: [Int] = []
        for candidate in [hint.predictedOffsetPx] + hint.candidateOffsets where candidate != 0 {
            if seen.insert(candidate).inserted { candidates.append(candidate) }
        }
        guard !candidates.isEmpty else { return nil }
        candidates.sort { abs($0 - hint.predictedOffsetPx) < abs($1 - hint.predictedOffsetPx) }
        let probes = candidates.prefix(max(1, config.maxCandidateProbes))

        // Verify over a thin centered stripe, not the whole band.
        let stripe = verifyStripe(band: band, axis: hint.axis)
        let staticConfidence = matchConfidence(region: stripe, previous: previous, current: current, axis: hint.axis, offset: 0)

        var best: (offset: Int, confidence: Double)?
        for candidate in probes {
            let confidence = matchConfidence(region: stripe, previous: previous, current: current, axis: hint.axis, offset: candidate)
            if best == nil || confidence > best!.confidence {
                best = (candidate, confidence)
            }
        }
        guard let best, best.offset != 0,
              best.confidence >= config.acceptConfidence,
              best.confidence - staticConfidence >= config.minStaticMargin else {
            return nil
        }
        switch hint.axis {
        case .vertical: return ScrollDeltaOffset(dx: 0, dy: best.offset)
        case .horizontal: return ScrollDeltaOffset(dx: best.offset, dy: 0)
        }
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
