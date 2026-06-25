import Foundation
import Testing

@testable import AgentDeskHost

struct ScrollOffsetEstimatorTests {
    // BGRA surface whose luma is a function of row only (b=g=r=rowValue), so a
    // vertical shift is detectable and a wrong offset mismatches.
    private static func verticalSurface(width: Int, height: Int, rowValue: (Int) -> UInt8) -> ScrollDeltaSurface {
        let bytesPerRow = width * 4
        var pixels = Data(count: bytesPerRow * height)
        pixels.withUnsafeMutableBytes { buffer in
            guard let base = buffer.baseAddress else { return }
            for y in 0..<height {
                let v = rowValue(y)
                for x in 0..<width {
                    let offset = y * bytesPerRow + x * 4
                    base.storeBytes(of: v, toByteOffset: offset, as: UInt8.self)
                    base.storeBytes(of: v, toByteOffset: offset + 1, as: UInt8.self)
                    base.storeBytes(of: v, toByteOffset: offset + 2, as: UInt8.self)
                    base.storeBytes(of: UInt8(255), toByteOffset: offset + 3, as: UInt8.self)
                }
            }
        }
        return ScrollDeltaSurface(width: width, height: height, bytesPerRow: bytesPerRow, pixels: pixels)
    }

    // BGRA surface whose luma is a function of column only, for horizontal scroll.
    private static func horizontalSurface(width: Int, height: Int, colValue: (Int) -> UInt8) -> ScrollDeltaSurface {
        let bytesPerRow = width * 4
        var pixels = Data(count: bytesPerRow * height)
        pixels.withUnsafeMutableBytes { buffer in
            guard let base = buffer.baseAddress else { return }
            for y in 0..<height {
                for x in 0..<width {
                    let v = colValue(x)
                    let offset = y * bytesPerRow + x * 4
                    base.storeBytes(of: v, toByteOffset: offset, as: UInt8.self)
                    base.storeBytes(of: v, toByteOffset: offset + 1, as: UInt8.self)
                    base.storeBytes(of: v, toByteOffset: offset + 2, as: UInt8.self)
                    base.storeBytes(of: UInt8(255), toByteOffset: offset + 3, as: UInt8.self)
                }
            }
        }
        return ScrollDeltaSurface(width: width, height: height, bytesPerRow: bytesPerRow, pixels: pixels)
    }

    // Non-linear per-index hash so a wrong offset yields uncorrelated luma; a
    // linear ramp would falsely match nearby offsets.
    private static func pattern(_ i: Int) -> UInt8 {
        var h = UInt32(truncatingIfNeeded: i &+ 1)
        h = h &* 2_654_435_761
        h ^= (h >> 15)
        h = h &* 2_246_822_519
        h ^= (h >> 13)
        return UInt8(truncatingIfNeeded: h >> 24)
    }

    // A different hash for unrelated content.
    private static func pattern2(_ i: Int) -> UInt8 {
        var h = UInt32(truncatingIfNeeded: i &* 3 &+ 7)
        h = h &* 40_503
        h ^= (h >> 11)
        h = h &* 2_654_435_761
        return UInt8(truncatingIfNeeded: h >> 16)
    }

    @Test func measuresVerticalOffsetDown() {
        let dy = 24
        let previous = Self.verticalSurface(width: 640, height: 600, rowValue: Self.pattern)
        let current = Self.verticalSurface(width: 640, height: 600) { Self.pattern($0 - dy) }
        let band = PixelRect(x: 100, y: 50, width: 400, height: 400)

        let result = ScrollOffsetEstimator().measure(
            band: band, previous: previous, current: current, axis: .vertical, sign: 1
        )
        #expect(result == dy)
    }

    @Test func measuresVerticalOffsetUp() {
        let dy = -32
        let previous = Self.verticalSurface(width: 640, height: 600, rowValue: Self.pattern)
        let current = Self.verticalSurface(width: 640, height: 600) { Self.pattern($0 - dy) }
        let band = PixelRect(x: 100, y: 50, width: 400, height: 400)

        let result = ScrollOffsetEstimator().measure(
            band: band, previous: previous, current: current, axis: .vertical, sign: -1
        )
        #expect(result == dy)
    }

    @Test func measuresHorizontalOffset() {
        let dx = 40
        let previous = Self.horizontalSurface(width: 800, height: 400, colValue: Self.pattern)
        let current = Self.horizontalSurface(width: 800, height: 400) { Self.pattern($0 - dx) }
        let band = PixelRect(x: 50, y: 50, width: 600, height: 300)

        let result = ScrollOffsetEstimator().measure(
            band: band, previous: previous, current: current, axis: .horizontal, sign: 1
        )
        #expect(result == dx)
    }

    // A fast Retina flick moves more than the old 400px search cap in one frame.
    // The projection scans the full band extent, so the large offset is found.
    @Test func measuresLargeOffsetBeyondOldCap() {
        let dy = 600
        let previous = Self.verticalSurface(width: 480, height: 900, rowValue: Self.pattern)
        let current = Self.verticalSurface(width: 480, height: 900) { Self.pattern($0 - dy) }
        let band = PixelRect(x: 40, y: 40, width: 360, height: 800)

        let result = ScrollOffsetEstimator().measure(
            band: band, previous: previous, current: current, axis: .vertical, sign: 1
        )
        #expect(result == dy)
    }

    // The newly-revealed leading strip (rows whose source falls off the surface)
    // is excluded by overlap-only scoring; the offset is still measured.
    @Test func recoversOffsetWithExposedStrip() {
        let dy = 28
        let previous = Self.verticalSurface(width: 640, height: 600, rowValue: Self.pattern)
        // Below dy: scrolled content. Above dy (the exposed strip): brand-new content.
        let current = Self.verticalSurface(width: 640, height: 600) { y in
            y >= dy ? Self.pattern(y - dy) : Self.pattern2(y &* 5 &+ 1)
        }
        let band = PixelRect(x: 0, y: 0, width: 500, height: 460)

        let result = ScrollOffsetEstimator().measure(
            band: band, previous: previous, current: current, axis: .vertical, sign: 1
        )
        #expect(result == dy)
    }

    // A sticky header (top rows identical in both frames) carries no scroll
    // evidence and is excluded as unchanged; the scrolled remainder is measured.
    @Test func measuresThroughStickyHeader() {
        let dy = 36
        let headerHeight = 48
        let previous = Self.verticalSurface(width: 640, height: 600, rowValue: Self.pattern)
        let current = Self.verticalSurface(width: 640, height: 600) { y in
            y < headerHeight ? Self.pattern(y) : Self.pattern(y - dy)
        }
        let band = PixelRect(x: 0, y: 0, width: 500, height: 460)

        let result = ScrollOffsetEstimator().measure(
            band: band, previous: previous, current: current, axis: .vertical, sign: 1
        )
        #expect(result == dy)
    }

    // A full-region repaint unrelated to the previous frame by any shift has no
    // offset that explains the changed pixels: returns nil so the caller tiles.
    @Test func rejectsNonTranslatingRepaint() {
        let previous = Self.verticalSurface(width: 640, height: 600, rowValue: Self.pattern)
        let current = Self.verticalSurface(width: 640, height: 600, rowValue: Self.pattern2)
        let band = PixelRect(x: 100, y: 50, width: 400, height: 400)

        let result = ScrollOffsetEstimator().measure(
            band: band, previous: previous, current: current, axis: .vertical, sign: 1
        )
        #expect(result == nil)
    }

    // Identical frames: nothing changed, so there is no offset to measure.
    @Test func rejectsStaticContent() {
        let surface = Self.verticalSurface(width: 640, height: 600, rowValue: Self.pattern)
        let band = PixelRect(x: 100, y: 50, width: 400, height: 400)

        let result = ScrollOffsetEstimator().measure(
            band: band, previous: surface, current: surface, axis: .vertical, sign: 1
        )
        #expect(result == nil)
    }

    // Searching only the declared sign direction: a downward scroll probed with
    // the wrong sign finds nothing and fails safe to nil (caller tiles) rather
    // than applying a torn copy.
    @Test func rejectsWrongSignSearch() {
        let dy = 30
        let previous = Self.verticalSurface(width: 640, height: 600, rowValue: Self.pattern)
        let current = Self.verticalSurface(width: 640, height: 600) { Self.pattern($0 - dy) }
        let band = PixelRect(x: 100, y: 50, width: 400, height: 400)

        let result = ScrollOffsetEstimator().measure(
            band: band, previous: previous, current: current, axis: .vertical, sign: -1
        )
        #expect(result == nil)
    }

    // Band too small along the axis to be a confident scroll: returns nil.
    @Test func rejectsBandBelowExtentGate() {
        let dy = 8
        let previous = Self.verticalSurface(width: 640, height: 600, rowValue: Self.pattern)
        let current = Self.verticalSurface(width: 640, height: 600) { Self.pattern($0 - dy) }
        let band = PixelRect(x: 10, y: 10, width: 40, height: 40)

        let result = ScrollOffsetEstimator().measure(
            band: band, previous: previous, current: current, axis: .vertical, sign: 1
        )
        #expect(result == nil)
    }
}
