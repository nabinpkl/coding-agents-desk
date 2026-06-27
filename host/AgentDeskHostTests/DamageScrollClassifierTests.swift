import CoreGraphics
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

    @Test func fullFrameWhenDamageEmpty() {
        let previous = Self.surface(width: 320, height: 240, rowValue: Self.rowPattern)
        let current = previous
        let classifier = DamageScrollClassifier()

        // Empty damage means the OS gave no usable change geometry for a frame
        // it nonetheless delivered, so the safe action is a full refresh, not a
        // skipped (stale) frame.
        let result = classifier.classify(
            damageRects: [],
            contentRect: PixelRect(x: 0, y: 0, width: 320, height: 240),
            previous: previous,
            current: current,
            hint: nil
        )

        #expect(result == .fullFrame(reason: "no-damage-info"))
    }

    @Test func rejectsScrollOnLowDetailContentWhereAnyOffsetMatches() {
        // Constant-luma content: every offset (including no shift) matches, so a
        // naive absolute-confidence accept would emit a torn copy. The
        // best-vs-static margin must reject it.
        let width = 640
        let height = 480
        let flat = Self.surface(width: width, height: height) { _ in 128 }
        let band = PixelRect(x: 100, y: 100, width: 480, height: 360)
        let classifier = DamageScrollClassifier()

        let result = classifier.classify(
            damageRects: [band],
            contentRect: PixelRect(x: 0, y: 0, width: width, height: height),
            previous: flat,
            current: flat,
            hint: Self.verticalHint(candidateOffsets: [24], sign: 1)
        )

        if case .scroll = result {
            Issue.record("must not accept a scroll on content that matches at every offset")
        }
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

    @Test func findsTrueVerticalOffsetWhenHintMagnitudeIsWrong() {
        let width = 640
        let height = 480
        let dy = 24
        let previous = Self.surface(width: width, height: height, rowValue: Self.rowPattern)
        let current = Self.surface(width: width, height: height) { Self.rowPattern($0 - dy) }
        let band = PixelRect(x: 100, y: 100, width: 400, height: 300)
        let classifier = DamageScrollClassifier()

        // The input hint carries the correct sign but wrong magnitudes (input dy
        // is not screen pixels once acceleration applies). The directed search
        // must recover the true offset (24) from the surface anyway, instead of
        // only trusting the hinted candidates. This is the whole point of the
        // damage path: copyRect fires even when the hint magnitude is off.
        let result = classifier.classify(
            damageRects: [band],
            contentRect: PixelRect(x: 0, y: 0, width: width, height: height),
            previous: previous,
            current: current,
            hint: Self.verticalHint(candidateOffsets: [4, 8, 12], sign: 1)
        )

        #expect(result == .scroll(region: band, dx: 0, dy: dy))
    }

    @Test func findsTrueVerticalOffsetWhenHintSignIsWrong() {
        let width = 640
        let height = 480
        let dy = 24
        let previous = Self.surface(width: width, height: height, rowValue: Self.rowPattern)
        // Content scrolled down (+24), but the hint claims an upward scroll. The
        // input sign jitters frame to frame, so the search probes both directions
        // and must still recover the true +24 offset.
        let current = Self.surface(width: width, height: height) { Self.rowPattern($0 - dy) }
        let band = PixelRect(x: 100, y: 100, width: 400, height: 300)
        let classifier = DamageScrollClassifier()

        let result = classifier.classify(
            damageRects: [band],
            contentRect: PixelRect(x: 0, y: 0, width: width, height: height),
            previous: previous,
            current: current,
            hint: Self.verticalHint(candidateOffsets: [16, 24, 32], sign: -1)
        )

        #expect(result == .scroll(region: band, dx: 0, dy: dy))
    }

    @Test func rejectsScrollWhenHintAxisContradictsContent() {
        let width = 640
        let height = 480
        let dy = 24
        let previous = Self.surface(width: width, height: height, rowValue: Self.rowPattern)
        // Content scrolled vertically, but the hint claims a horizontal scroll.
        let current = Self.surface(width: width, height: height) { Self.rowPattern($0 - dy) }
        let band = PixelRect(x: 100, y: 100, width: 400, height: 300)
        let classifier = DamageScrollClassifier()

        // The axis is the one reliable part of the hint; searching the wrong axis
        // finds no aligned offset, so the frame must not become a torn copy.
        let horizontalHint = ScrollActivityHint(
            axis: .horizontal,
            sign: 1,
            predictedOffsetPx: 24,
            candidateOffsets: [16, 24, 32],
            activeUntilUptimeNs: .max,
            eventCount: 4
        )
        let result = classifier.classify(
            damageRects: [band],
            contentRect: PixelRect(x: 0, y: 0, width: width, height: height),
            previous: previous,
            current: current,
            hint: horizontalHint
        )

        if case .scroll = result {
            Issue.record("must not accept a scroll on the wrong axis")
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

    @Test func captureDamagePixelRectRoundsOutwardAndClamps() {
        // Sub-pixel rect rounds outward: floor the origin, ceil the far edge, so
        // a partially-covered edge pixel is never dropped.
        let rounded = PixelRect.clampedPixels(
            from: CGRect(x: 10.4, y: 20.6, width: 100.1, height: 50.2), width: 200, height: 200
        )
        #expect(rounded == PixelRect(x: 10, y: 20, width: 101, height: 51))
        // An oversized rect clamps to the pixel buffer.
        let clamped = PixelRect.clampedPixels(
            from: CGRect(x: -5, y: -5, width: 400, height: 400), width: 200, height: 150
        )
        #expect(clamped == PixelRect(x: 0, y: 0, width: 200, height: 150))
        // A null rect collapses to zero area.
        #expect(PixelRect.clampedPixels(from: .null, width: 200, height: 200).area == 0)
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
