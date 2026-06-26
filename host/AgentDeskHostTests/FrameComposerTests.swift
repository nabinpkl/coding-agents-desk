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

    @Test func scrollingMotionTilesTheDamageBand() {
        // ADR-0022: there is no offset estimation or copyRect. A declared scroll
        // whose damage is within the coverage ceiling tiles the damage band like
        // any other change; motion only labels the trace.
        let dy = 24
        let previous = Self.verticalSurface(width: 640, height: 480, rowValue: Self.pattern)
        let current = Self.verticalSurface(width: 640, height: 480) { Self.pattern($0 - dy) }
        let band = PixelRect(x: 100, y: 60, width: 400, height: 340)

        let result = FrameComposer().compose(
            damageRects: [band], previous: previous, current: current, motion: Self.vertical
        )
        #expect(result == .tiles([band]))
    }

    @Test func horizontalScrollingMotionTilesTheDamageBand() {
        let dx = 36
        let previous = Self.horizontalSurface(width: 800, height: 400, colValue: Self.pattern)
        let current = Self.horizontalSurface(width: 800, height: 400) { Self.pattern($0 - dx) }
        let band = PixelRect(x: 80, y: 40, width: 600, height: 320)

        let result = FrameComposer().compose(
            damageRects: [band], previous: previous, current: current, motion: Self.horizontal
        )
        #expect(result == .tiles([band]))
    }

    @Test func scrollingMotionAboveCoverageCeilingFullFrames() {
        // ADR-0022: a near-full-surface damage band is a fullFrame regardless of
        // motion, since there is no scroll copy to amortize it. The coverage gate,
        // not a measured offset, governs.
        let dy = 30
        let previous = Self.verticalSurface(width: 640, height: 480, rowValue: Self.pattern)
        let current = Self.verticalSurface(width: 640, height: 480) { Self.pattern($0 - dy) }
        let band = PixelRect(x: 0, y: 0, width: 640, height: 460)

        let result = FrameComposer().compose(
            damageRects: [band], previous: previous, current: current, motion: Self.vertical
        )
        #expect(result == .fullFrame(reason: "damage-too-large"))
    }

    @Test func scrollingMotionThatDoesNotTranslateTilesTheRegion() {
        // Input says scrolling but every change tiles (ADR-0022): the small-coverage
        // band tiles regardless of whether it translated.
        let previous = Self.verticalSurface(width: 640, height: 480, rowValue: Self.pattern)
        let current = Self.verticalSurface(width: 640, height: 480, rowValue: Self.pattern2)
        let band = PixelRect(x: 100, y: 60, width: 240, height: 200)

        let result = FrameComposer().compose(
            damageRects: [band], previous: previous, current: current, motion: Self.vertical
        )
        if case .tiles = result {} else { Issue.record("expected tiles, got \(result)") }
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
