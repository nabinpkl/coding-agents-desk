import Foundation
import Testing

@testable import AgentDeskHost

struct DamageScrollClassifierTests {
    // BGRA surface whose luma is a function of row only, so a vertical shift is
    // detectable and wrong offsets mismatch. With b=g=r=v the weighted luma is v.
    private static func surface(width: Int, height: Int, rowValue: (Int) -> UInt8) -> ScrollDeltaSurface {
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

    private static func verticalHint(candidateOffsets: [Int], sign: Int) -> ScrollActivityHint {
        ScrollActivityHint(
            axis: .vertical,
            sign: sign,
            predictedOffsetPx: candidateOffsets.first ?? sign,
            candidateOffsets: candidateOffsets,
            activeUntilUptimeNs: .max,
            eventCount: 4
        )
    }

    // Non-linear per-row hash: a wrong offset yields uncorrelated luma (low match),
    // only the exact offset aligns identical rows. A linear ramp would falsely
    // match nearby offsets and is unsuitable for testing offset discrimination.
    private static func rowPattern(_ y: Int) -> UInt8 {
        var h = UInt32(truncatingIfNeeded: y &+ 1)
        h = h &* 2_654_435_761
        h ^= (h >> 15)
        h = h &* 2_246_822_519
        h ^= (h >> 13)
        return UInt8(truncatingIfNeeded: h >> 24)
    }

    @Test func acceptsVerticalScrollWithinDamageBand() {
        let width = 640
        let height = 480
        let dy = 24
        let previous = Self.surface(width: width, height: height, rowValue: Self.rowPattern)
        // Current = previous content shifted down by dy.
        let current = Self.surface(width: width, height: height) { Self.rowPattern($0 - dy) }
        let band = PixelRect(x: 100, y: 100, width: 400, height: 300)
        let classifier = DamageScrollClassifier()

        let result = classifier.classify(
            damageRects: [band],
            contentRect: PixelRect(x: 0, y: 0, width: width, height: height),
            previous: previous,
            current: current,
            hint: Self.verticalHint(candidateOffsets: [16, 24, 32], sign: 1)
        )

        #expect(result == .scroll(region: band, dx: 0, dy: dy))
    }

    @Test func noChangeWhenDamageEmpty() {
        let previous = Self.surface(width: 320, height: 240, rowValue: Self.rowPattern)
        let current = previous
        let classifier = DamageScrollClassifier()

        let result = classifier.classify(
            damageRects: [],
            contentRect: PixelRect(x: 0, y: 0, width: 320, height: 240),
            previous: previous,
            current: current,
            hint: nil
        )

        #expect(result == .noChange)
    }

    @Test func tilesSmallDamageWithoutScrollHint() {
        let previous = Self.surface(width: 640, height: 480, rowValue: Self.rowPattern)
        let current = Self.surface(width: 640, height: 480) { Self.rowPattern($0 &+ 1) }
        let smallDamage = PixelRect(x: 10, y: 10, width: 40, height: 40)
        let classifier = DamageScrollClassifier()

        let result = classifier.classify(
            damageRects: [smallDamage],
            contentRect: PixelRect(x: 0, y: 0, width: 640, height: 480),
            previous: previous,
            current: current,
            hint: nil
        )

        #expect(result == .tiles([smallDamage]))
    }

    @Test func fullFrameWhenLargeDamageWithoutScroll() {
        let width = 640
        let height = 480
        let previous = Self.surface(width: width, height: height, rowValue: Self.rowPattern)
        let current = Self.surface(width: width, height: height) { Self.rowPattern($0 &+ 1) }
        let bigDamage = PixelRect(x: 0, y: 0, width: width, height: height)
        let classifier = DamageScrollClassifier()

        let result = classifier.classify(
            damageRects: [bigDamage],
            contentRect: PixelRect(x: 0, y: 0, width: width, height: height),
            previous: previous,
            current: current,
            hint: nil
        )

        #expect(result == .fullFrame(reason: "damage-too-large-no-scroll"))
    }

    @Test func rejectsScrollWhenHintOffsetDoesNotMatchContent() {
        let width = 640
        let height = 480
        let dy = 24
        let previous = Self.surface(width: width, height: height, rowValue: Self.rowPattern)
        let current = Self.surface(width: width, height: height) { Self.rowPattern($0 - dy) }
        let band = PixelRect(x: 100, y: 100, width: 400, height: 300)
        let classifier = DamageScrollClassifier()

        // Hint candidates do not include the true offset (24), so verification
        // fails and the band is treated as tiles, not a torn scroll copy.
        let result = classifier.classify(
            damageRects: [band],
            contentRect: PixelRect(x: 0, y: 0, width: width, height: height),
            previous: previous,
            current: current,
            hint: Self.verticalHint(candidateOffsets: [4, 8, 12], sign: 1)
        )

        if case .scroll = result {
            Issue.record("must not accept a scroll offset that was not verified")
        }
    }

    @Test func fullFrameOnSurfaceSizeChange() {
        let previous = Self.surface(width: 320, height: 240, rowValue: Self.rowPattern)
        let current = Self.surface(width: 400, height: 240, rowValue: Self.rowPattern)
        let classifier = DamageScrollClassifier()

        let result = classifier.classify(
            damageRects: [PixelRect(x: 0, y: 0, width: 320, height: 240)],
            contentRect: PixelRect(x: 0, y: 0, width: 320, height: 240),
            previous: previous,
            current: current,
            hint: nil
        )

        #expect(result == .fullFrame(reason: "surface-size-changed"))
    }

    @Test func pixelRectUnionCoversAllRects() {
        let rects = [
            PixelRect(x: 10, y: 20, width: 30, height: 40),
            PixelRect(x: 100, y: 5, width: 20, height: 200)
        ]
        let union = PixelRect.union(of: rects)
        // minY=5, maxY=max(60,205)=205, so height=200.
        #expect(union == PixelRect(x: 10, y: 5, width: 110, height: 200))
    }
}
