import CoreGraphics
import Foundation

// Composes a frame from the OS damage signal (ADR-0022).
//
// macOS ScreenCaptureKit hands us per-frame dirty rects but no scroll/move vector
// (Apple obsoleted the CGDisplayStream moved-rects API in macOS 15), and no
// production system reconstructs scroll from pixels. So there is no offset
// estimation and no copyRect: every change, scroll or not, routes through the
// damage tile ladder. Input still declares motion (MotionSignal) for the quality
// policy (readable floor while scrolling), but it no longer drives geometry.
//
//  - damage within the coverage ceiling: tile the damage rects through the cache
//    ladder.
//  - damage above the ceiling, or absent/degenerate damage: fullFrame, the safe
//    whole-surface refresh that the tile ladder grids anyway.

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
    let decision: String

    static let empty = DamageScrollTrace(
        bandWidth: 0, bandHeight: 0, coverage: 0, decision: "none"
    )
}

struct FrameComposer {
    // Coverage above which a damage change tiles the whole surface (through the
    // same cache ladder) instead of just the damage rects.
    private let maxTileCoverageRatio: Double

    init(
        maxTileCoverageRatio: Double = Config.hybridClassifierMaxTileCoverageRatio
    ) {
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

        // The dominant damage band, not the bounding box of every rect. Scattered
        // incidental damage (cursor, a clock, a badge elsewhere) balloons the union
        // to the whole multi-monitor surface and inflates the coverage estimate.
        // Keep only rects that are a significant fraction of the largest and union
        // those.
        let largestArea = clamped.map(\.area).max() ?? 0
        let scrollBand = PixelRect.union(of: clamped.filter { Double($0.area) >= 0.5 * Double(largestArea) }) ?? union

        // Tile the damage if it is small enough, else tile the whole surface. Both
        // ride the cache ladder; fullFrame here is a coverage decision. The motion
        // signal only labels the trace (scrolling vs rest) for device logs.
        let phase = motion != nil ? "scrolling" : "rest"
        if coverage <= maxTileCoverageRatio {
            return (.tiles(clamped), trace(band: scrollBand, coverage: coverage, decision: "tiles-\(phase)"))
        }
        return (.fullFrame(reason: "damage-too-large"),
                trace(band: scrollBand, coverage: coverage, decision: "fullframe-\(phase)"))
    }

    private func trace(band: PixelRect? = nil, coverage: Double = 0, decision: String) -> DamageScrollTrace {
        DamageScrollTrace(
            bandWidth: band?.width ?? 0,
            bandHeight: band?.height ?? 0,
            coverage: coverage,
            decision: decision
        )
    }
}
