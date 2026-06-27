import Foundation

// Damage-driven scroll classifier (ADR-0021). macOS ScreenCaptureKit hands the
// host a per-frame damage region via SCStreamFrameInfoDirtyRects. A device spike
// confirmed that during a scroll the OS marks the whole scrolled content area as
// one tall band in native pixel space. This classifier takes that band as the
// scroll region directly, instead of brute-force scanning the frame for it, then
// verifies the input-hinted offset only inside the band. There is no full-frame
// candidate sweep and no confidence-margin gate.

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
}

enum DamageScrollClassification: Equatable {
    case scroll(region: PixelRect, dx: Int, dy: Int)
    case tiles([PixelRect])
    case fullFrame(reason: String)
    case noChange
}

struct DamageScrollClassifierConfig: Equatable, Sendable {
    let minBandWidth: Int
    let minBandHeight: Int
    let acceptConfidence: Double
    let sampleStep: Int
    let lumaTolerance: Int
    let maxTileCoverageRatio: Double

    static let `default` = DamageScrollClassifierConfig(
        minBandWidth: 200,
        minBandHeight: 80,
        acceptConfidence: 0.9,
        sampleStep: 8,
        lumaTolerance: 24,
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
            return .noChange
        }

        if let hint, let offset = scrollOffset(band: union, previous: previous, current: current, hint: hint) {
            return .scroll(region: union, dx: offset.dx, dy: offset.dy)
        }

        // No scroll: tile small damage, fall back to a full frame when it covers
        // most of the surface (the graphics tile path would not pay there).
        let coverage = Double(union.area) / Double(max(1, current.width * current.height))
        if coverage <= config.maxTileCoverageRatio {
            return .tiles(clamped)
        }
        return .fullFrame(reason: "damage-too-large-no-scroll")
    }

    private func scrollOffset(
        band: PixelRect,
        previous: ScrollDeltaSurface,
        current: ScrollDeltaSurface,
        hint: ScrollActivityHint
    ) -> ScrollDeltaOffset? {
        guard band.width >= config.minBandWidth, band.height >= config.minBandHeight else {
            return nil
        }
        let candidates = hint.candidateOffsets.filter { $0 != 0 }
        guard !candidates.isEmpty else { return nil }

        var best: (offset: Int, confidence: Double)?
        for candidate in candidates {
            let confidence = matchConfidence(band: band, previous: previous, current: current, axis: hint.axis, offset: candidate)
            if best == nil || confidence > best!.confidence {
                best = (candidate, confidence)
            }
        }
        guard let best, best.confidence >= config.acceptConfidence, best.offset != 0 else {
            return nil
        }
        switch hint.axis {
        case .vertical: return ScrollDeltaOffset(dx: 0, dy: best.offset)
        case .horizontal: return ScrollDeltaOffset(dx: best.offset, dy: 0)
        }
    }

    // Fraction of sampled band pixels that match the previous frame after shifting
    // by the candidate offset. The band came from OS damage, so its pixels did
    // change; a high shifted-match therefore means the content translated by the
    // offset (a real scroll) rather than coincidental static overlap.
    private func matchConfidence(
        band: PixelRect,
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
                var y = band.y
                while y < band.maxY {
                    let previousY = y - dy
                    if previousY >= band.y, previousY < band.maxY,
                       previousY >= 0, previousY < previous.height,
                       y >= 0, y < current.height {
                        var x = band.x
                        while x < band.maxX {
                            let previousX = x - dx
                            if previousX >= band.x, previousX < band.maxX,
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
