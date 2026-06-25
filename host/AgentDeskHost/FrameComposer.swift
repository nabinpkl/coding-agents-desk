import CoreGraphics
import Foundation

// Composes a frame from input-DECLARED motion (ADR-0021, redesigned).
//
// The previous model inspected pixels to GUESS whether a scroll happened, then a
// cluster of confidence/search knobs adjudicated the guess, with the offset search
// capped at 400px. That left fast Retina flicks (more than 400px/frame)
// unrecoverable, so they fell to whole-region tile repaints and the screen could
// not keep up. macOS gives no OS scroll order to lean on, but the phone CAUSES
// every scroll, so the host is simply told the axis and that a scroll is active
// (MotionSignal). Composition is then deterministic:
//
//  - scrolling: measure the exact offset with ScrollOffsetEstimator (no cap, both
//    directions, one verify floor). On a measured offset the frame is a copyRect
//    over the band plus a tiled exposed strip; the moved content rides the copy at
//    full fidelity. If the band does not actually translate, the estimator returns
//    nil and the frame tiles the region (still readable), never a torn copy.
//  - rest, or a scroll that did not translate: tile the damage rects through the
//    cache ladder, or, above the coverage ceiling, tile the whole surface.
//
// fullFrame is no longer a scroll fallback: it is only the safe whole-surface
// refresh when the OS gave no usable damage, or a high-coverage non-scroll repaint
// that the tile ladder grids anyway.

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

// Per-frame trace for device logs: the band geometry, coverage, the measured
// offset, and the decision string, so a device run shows why each frame composed
// the way it did.
struct DamageScrollTrace: Equatable {
    let bandWidth: Int
    let bandHeight: Int
    let coverage: Double
    let measuredOffset: Int?
    let decision: String

    static let empty = DamageScrollTrace(
        bandWidth: 0, bandHeight: 0, coverage: 0, measuredOffset: nil, decision: "none"
    )
}

struct FrameComposer {
    private let estimator: ScrollOffsetEstimator
    // Coverage above which a non-scroll change tiles the whole surface (through the
    // same cache ladder) instead of just the damage rects.
    private let maxTileCoverageRatio: Double

    init(
        estimator: ScrollOffsetEstimator = ScrollOffsetEstimator(),
        maxTileCoverageRatio: Double = Config.hybridClassifierMaxTileCoverageRatio
    ) {
        self.estimator = estimator
        self.maxTileCoverageRatio = maxTileCoverageRatio
    }

    func compose(
        damageRects: [PixelRect],
        previous: ScrollDeltaSurface,
        current: ScrollDeltaSurface,
        motion: MotionSignal?
    ) -> DamageScrollClassification {
        composeTraced(damageRects: damageRects, previous: previous, current: current, motion: motion).0
    }

    func composeTraced(
        damageRects: [PixelRect],
        previous: ScrollDeltaSurface,
        current: ScrollDeltaSurface,
        motion: MotionSignal?
    ) -> (DamageScrollClassification, DamageScrollTrace) {
        guard previous.width == current.width, previous.height == current.height else {
            return (.fullFrame(reason: "surface-size-changed"), trace(decision: "size-changed"))
        }
        let clamped = damageRects
            .map { $0.clamped(toWidth: current.width, height: current.height) }
            .filter { $0.area > 0 }
        guard let union = PixelRect.union(of: clamped), union.area > 0 else {
            // ScreenCaptureKit delivers a frame only when the framebuffer changed,
            // so an absent or degenerate damage region means the change extent is
            // unknown, not that nothing moved. Refresh the whole frame rather than
            // risk leaving a stale screen.
            return (.fullFrame(reason: "no-damage-info"), trace(decision: "no-damage-info"))
        }

        let surfaceArea = max(1, current.width * current.height)
        let damageArea = min(surfaceArea, clamped.reduce(0) { $0 + $1.area })
        let coverage = Double(damageArea) / Double(surfaceArea)

        // The scroll band is the dominant damage, not the bounding box of every
        // rect. Scattered incidental damage (cursor, a clock, a badge elsewhere)
        // balloons the union to the whole multi-monitor surface, so a copyRect would
        // shift everything. Keep only rects that are a significant fraction of the
        // largest and union those.
        let largestArea = clamped.map(\.area).max() ?? 0
        let scrollBand = PixelRect.union(of: clamped.filter { Double($0.area) >= 0.5 * Double(largestArea) }) ?? union

        // Input declares a scroll: measure the exact offset. The estimator returns
        // nil when the band does not actually translate, in which case the frame
        // falls through to the tile path (still readable), never a torn copy.
        if let motion,
           let offset = estimator.measure(band: scrollBand, previous: previous, current: current, axis: motion.axis) {
            let dx = motion.axis == .horizontal ? offset : 0
            let dy = motion.axis == .vertical ? offset : 0
            return (.scroll(region: scrollBand, dx: dx, dy: dy),
                    trace(band: scrollBand, coverage: coverage, measuredOffset: offset, decision: "scroll"))
        }

        // Not a scroll (rest, or a scroll the surface did not confirm): tile the
        // damage if it is small enough, else tile the whole surface. Both ride the
        // cache ladder; fullFrame here is a coverage decision, not a scroll miss.
        let missDecision = motion != nil ? "scroll-miss" : "rest"
        if coverage <= maxTileCoverageRatio {
            return (.tiles(clamped), trace(band: scrollBand, coverage: coverage, decision: "tiles-\(missDecision)"))
        }
        return (.fullFrame(reason: "damage-too-large-no-scroll"),
                trace(band: scrollBand, coverage: coverage, decision: "fullframe-\(missDecision)"))
    }

    private func trace(band: PixelRect? = nil, coverage: Double = 0, measuredOffset: Int? = nil, decision: String) -> DamageScrollTrace {
        DamageScrollTrace(
            bandWidth: band?.width ?? 0,
            bandHeight: band?.height ?? 0,
            coverage: coverage,
            measuredOffset: measuredOffset,
            decision: decision
        )
    }
}
