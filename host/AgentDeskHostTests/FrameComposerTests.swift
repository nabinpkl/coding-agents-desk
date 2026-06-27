import Foundation
import Testing

@testable import AgentDeskHost

struct FrameComposerTests {
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

    private static func pattern(_ i: Int) -> UInt8 {
        var h = UInt32(truncatingIfNeeded: i &+ 1)
        h = h &* 2_654_435_761
        h ^= (h >> 15)
        h = h &* 2_246_822_519
        h ^= (h >> 13)
        return UInt8(truncatingIfNeeded: h >> 24)
    }

    private static func pattern2(_ i: Int) -> UInt8 {
        var h = UInt32(truncatingIfNeeded: i &* 3 &+ 7)
        h = h &* 40_503
        h ^= (h >> 11)
        h = h &* 2_654_435_761
        return UInt8(truncatingIfNeeded: h >> 16)
    }

    private static let vertical = MotionSignal(axis: .vertical, sign: 1)
    private static let horizontal = MotionSignal(axis: .horizontal, sign: 1)

    @Test func sizeChangeReturnsFullFrame() {
        let previous = Self.verticalSurface(width: 320, height: 240, rowValue: Self.pattern)
        let current = Self.verticalSurface(width: 640, height: 480, rowValue: Self.pattern)
        let result = FrameComposer().compose(
            damageRects: [PixelRect(x: 0, y: 0, width: 320, height: 240)],
            previous: previous, current: current, motion: nil
        )
        #expect(result == .fullFrame(reason: "surface-size-changed"))
    }

    @Test func emptyDamageReturnsFullFrame() {
        let surface = Self.verticalSurface(width: 320, height: 240, rowValue: Self.pattern)
        let result = FrameComposer().compose(
            damageRects: [], previous: surface, current: surface, motion: nil
        )
        #expect(result == .fullFrame(reason: "no-damage-info"))
    }

    @Test func scrollingMotionTilesTheBand() {
        // The composer no longer measures an offset: a declared scroll within the
        // coverage ceiling tiles its damage band. The HEVC video carrier intercepts a
        // real scroll upstream of the composer, so here motion only labels the trace.
        let dy = 24
        let previous = Self.verticalSurface(width: 640, height: 480, rowValue: Self.pattern)
        let current = Self.verticalSurface(width: 640, height: 480) { Self.pattern($0 - dy) }
        let band = PixelRect(x: 100, y: 60, width: 400, height: 340)

        let result = FrameComposer().compose(
            damageRects: [band], previous: previous, current: current, motion: Self.vertical
        )
        #expect(result == .tiles([band]))
    }

    @Test func horizontalScrollingMotionTilesTheBand() {
        let dx = 36
        let previous = Self.horizontalSurface(width: 800, height: 400, colValue: Self.pattern)
        let current = Self.horizontalSurface(width: 800, height: 400) { Self.pattern($0 - dx) }
        let band = PixelRect(x: 80, y: 40, width: 600, height: 320)

        let result = FrameComposer().compose(
            damageRects: [band], previous: previous, current: current, motion: Self.horizontal
        )
        #expect(result == .tiles([band]))
    }

    @Test func motionBandAboveCoverageCeilingReturnsFullFrame() {
        // A near-full-surface motion band exceeds the coverage ceiling and tiles the
        // whole surface (fullFrame); there is no offset measurement to amortize it.
        let dy = 30
        let previous = Self.verticalSurface(width: 640, height: 480, rowValue: Self.pattern)
        let current = Self.verticalSurface(width: 640, height: 480) { Self.pattern($0 - dy) }
        let band = PixelRect(x: 0, y: 0, width: 640, height: 460)

        let result = FrameComposer().compose(
            damageRects: [band], previous: previous, current: current, motion: Self.vertical
        )
        #expect(result == .fullFrame(reason: "damage-too-large"))
    }

    @Test func scrollingMotionUnrelatedRepaintTilesTheRegion() {
        // A small-coverage motion band tiles regardless of whether it translated; the
        // composer no longer distinguishes a real shift from an unrelated repaint.
        let previous = Self.verticalSurface(width: 640, height: 480, rowValue: Self.pattern)
        let current = Self.verticalSurface(width: 640, height: 480, rowValue: Self.pattern2)
        let band = PixelRect(x: 100, y: 60, width: 240, height: 200)

        let result = FrameComposer().compose(
            damageRects: [band], previous: previous, current: current, motion: Self.vertical
        )
        if case .tiles = result {} else { Issue.record("expected tiles, got \(result)") }
    }

    @Test func scatteredMotionDamageTilesEveryRect() {
        // A dominant band plus small scattered damage (a cursor, a clock) under motion
        // tiles every damage rect through the cache ladder.
        let dy = 20
        let previous = Self.verticalSurface(width: 640, height: 480, rowValue: Self.pattern)
        let current = Self.verticalSurface(width: 640, height: 480) { Self.pattern($0 - dy) }
        let band = PixelRect(x: 80, y: 60, width: 400, height: 340)
        let speck = PixelRect(x: 600, y: 10, width: 16, height: 16)

        let result = FrameComposer().compose(
            damageRects: [band, speck], previous: previous, current: current, motion: Self.vertical
        )
        #expect(result == .tiles([band, speck]))
    }

    @Test func restSmallDamageReturnsTiles() {
        let previous = Self.verticalSurface(width: 640, height: 480, rowValue: Self.pattern)
        let current = Self.verticalSurface(width: 640, height: 480) { Self.pattern($0 &+ 1) }
        let damage = PixelRect(x: 10, y: 10, width: 40, height: 40)

        let result = FrameComposer().compose(
            damageRects: [damage], previous: previous, current: current, motion: nil
        )
        if case .tiles = result {} else { Issue.record("expected tiles, got \(result)") }
    }

    @Test func restHugeDamageReturnsFullFrame() {
        // Damage above the coverage ceiling tiles the whole surface (fullFrame).
        let previous = Self.verticalSurface(width: 640, height: 480, rowValue: Self.pattern)
        let current = Self.verticalSurface(width: 640, height: 480, rowValue: Self.pattern2)
        let damage = PixelRect(x: 0, y: 0, width: 600, height: 360)

        let result = FrameComposer().compose(
            damageRects: [damage], previous: previous, current: current, motion: nil
        )
        #expect(result == .fullFrame(reason: "damage-too-large"))
    }
}
