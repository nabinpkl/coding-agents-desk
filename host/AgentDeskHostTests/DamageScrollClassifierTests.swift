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

    // Per-pixel hash so a wrong offset yields uncorrelated luma. Varying in both x
    // and y gives ~1250 samples across the band, so the explained fraction
    // concentrates tightly (8-bit luma within tolerance matches ~19% of random
    // pairs by chance; a row-only pattern has too few samples to average that out
    // and the strict bar then accepts a partial scroll the relaxed test needs to
    // sit below).
    private static func pixelPattern(_ x: Int, _ y: Int) -> UInt8 {
        var h = UInt32(truncatingIfNeeded: (y &* 73_856_093) ^ (x &* 19_349_663))
        h ^= (h >> 15)
        h = h &* 2_246_822_519
        h ^= (h >> 13)
        return UInt8(truncatingIfNeeded: h >> 24)
    }

    private static func surface2D(width: Int, height: Int, value: (Int, Int) -> UInt8) -> ScrollDeltaSurface {
        let bytesPerRow = width * 4
        var pixels = Data(count: bytesPerRow * height)
        pixels.withUnsafeMutableBytes { buffer in
            guard let base = buffer.baseAddress else { return }
            for y in 0..<height {
                for x in 0..<width {
                    let v = value(x, y)
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

    // Current surface: inside the band the top dy rows are newly-revealed content
    // (unshiftable) and the rest is previous shifted down by dy. With dy half the
    // band height, the true offset explains ~0.6 of the changed pixels: below the
    // strict 0.7 bar but above the relaxed 0.55 input-corroborated bar. Outside the
    // band the content is unchanged.
    private static func partialOverlapCurrent(width: Int, height: Int, band: PixelRect, dy: Int) -> ScrollDeltaSurface {
        Self.surface2D(width: width, height: height) { x, y in
            guard y >= band.y, y < band.maxY else { return Self.pixelPattern(x, y) }
            let local = y - band.y
            return local < dy ? Self.pixelPattern(x, y &+ 100_000) : Self.pixelPattern(x, y - dy)
        }
    }

    @Test func acceptsPartialOverlapScrollWhenInputCorroborates() {
        // A fast flick: only ~60% of the band is a clean shift, the rest is
        // newly-revealed content, so the surface-best shift scores below the strict
        // bar. Because the input hint's predicted offset corroborates the true
        // offset, copyRect must still fire (the exposed remainder is tiled) instead
        // of falling to HEVC, which froze when suppressed (R74).
        let width = 640
        let height = 480
        let dy = 100
        let band = PixelRect(x: 100, y: 100, width: 400, height: 200)
        let previous = Self.surface2D(width: width, height: height, value: Self.pixelPattern)
        let current = Self.partialOverlapCurrent(width: width, height: height, band: band, dy: dy)
        let classifier = DamageScrollClassifier()

        let result = classifier.classify(
            damageRects: [band],
            contentRect: PixelRect(x: 0, y: 0, width: width, height: height),
            previous: previous,
            current: current,
            hint: Self.verticalHint(candidateOffsets: [92, 100, 108], sign: 1)
        )

        #expect(result == .scroll(region: band, dx: 0, dy: dy))
    }

    @Test func rejectsPartialOverlapScrollWhenInputDisagrees() {
        // Same partial-overlap surface (the surface clearly shifted down by 24),
        // but the input hint points the wrong way. The relaxed bar must require
        // input corroboration: when the device's own scroll delta disagrees with
        // the surface, the frame is not copyRect'd (it falls to the HEVC floor),
        // so a contradictory hint can never force a torn copy.
        let width = 640
        let height = 480
        let dy = 100
        let band = PixelRect(x: 100, y: 100, width: 400, height: 200)
        let previous = Self.surface2D(width: width, height: height, value: Self.pixelPattern)
        let current = Self.partialOverlapCurrent(width: width, height: height, band: band, dy: dy)
        let classifier = DamageScrollClassifier()

        let result = classifier.classify(
            damageRects: [band],
            contentRect: PixelRect(x: 0, y: 0, width: width, height: height),
            previous: previous,
            current: current,
            hint: Self.verticalHint(candidateOffsets: [-92, -100, -108], sign: -1)
        )

        if case .scroll = result {
            Issue.record("must not accept a partial-overlap scroll the input contradicts")
        }
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

    // Real scroll-down: content moves down by dy and a dy-tall strip of brand-new
    // content appears at the TOP surface edge. The reveal strip's source is off the
    // previous surface, so it can never be explained by a shift; scoring it against
    // the changed pixels dragged the strict confidence below the bar even though the
    // overlap is a clean shift, and the frame fell to fullframe (the device freeze:
    // 119 scroll-miss frames at 460-707KB each). The classifier must score the
    // OVERLAP only (the reveal strip is tiled by the scroll envelope) and copyRect.
    @Test func acceptsEdgeRevealScrollWhereRevealStripDilutesStrictScore() {
        let width = 640
        let height = 480
        // Reveal is 80 of the 150-row band (53%), so the legacy whole-stripe metric
        // scored the true offset at ~0.47 (below both the 0.7 strict and 0.55
        // relaxed bars) and rejected to fullframe. dy is a multiple of the coarse
        // search step so the surface search lands on it directly; the hint's
        // candidates deliberately exclude it, proving acceptance comes from the
        // overlap-only surface score, not a matching candidate.
        let dy = 80
        let band = PixelRect(x: 0, y: 0, width: width, height: 150)
        let previous = Self.surface2D(width: width, height: height, value: Self.pixelPattern)
        let current = Self.surface2D(width: width, height: height) { x, y in
            guard y >= band.y, y < band.maxY else { return Self.pixelPattern(x, y) }
            // Top dy rows are newly revealed at the surface edge; the rest is
            // previous shifted down by dy.
            return y < dy ? Self.pixelPattern(x, y &+ 500_000) : Self.pixelPattern(x, y - dy)
        }
        let classifier = DamageScrollClassifier()

        let result = classifier.classify(
            damageRects: [band],
            contentRect: PixelRect(x: 0, y: 0, width: width, height: height),
            previous: previous,
            current: current,
            hint: Self.verticalHint(candidateOffsets: [8, 16], sign: 1)
        )

        #expect(result == .scroll(region: band, dx: 0, dy: dy))
    }

    // A fast momentum flick scrolls more than the legacy 200px search cap in one
    // frame (scroll acceleration amplifies the input delta past the input range).
    // The directed search must reach the true offset; capping it lower finds only a
    // wrong partial offset and the frame wrongly falls to fullframe.
    @Test func recoversFastFlickOffsetBeyondLegacySearchCap() {
        let width = 640
        let height = 640
        let dy = 260
        let band = PixelRect(x: 0, y: 0, width: width, height: height)
        let previous = Self.surface2D(width: width, height: height, value: Self.pixelPattern)
        let current = Self.surface2D(width: width, height: height) { x, y in
            y < dy ? Self.pixelPattern(x, y &+ 500_000) : Self.pixelPattern(x, y - dy)
        }
        let classifier = DamageScrollClassifier()

        let result = classifier.classify(
            damageRects: [band],
            contentRect: PixelRect(x: 0, y: 0, width: width, height: height),
            previous: previous,
            current: current,
            hint: Self.verticalHint(candidateOffsets: [240, 260, 280], sign: 1)
        )

        #expect(result == .scroll(region: band, dx: 0, dy: dy))
    }

    // Config identical to the production default except the two fields under test,
    // so the A/B pair isolates the certainConfidence bypass from every other gate.
    private static func config(minChangedFraction: Double, certainConfidence: Double) -> DamageScrollClassifierConfig {
        DamageScrollClassifierConfig(
            minScrollExtentPx: 120,
            minCrossExtentPx: 64,
            acceptConfidence: 0.7,
            acceptConfidenceWithPrior: 0.55,
            minChangedFraction: minChangedFraction,
            certainConfidence: certainConfidence,
            minCertainExplainedSamples: 24,
            sampleStep: 8,
            lumaTolerance: 24,
            coarseStep: 8,
            maxSearchOffsetPx: 400,
            verifyExtent: 256,
            maxTileCoverageRatio: 0.15
        )
    }

    // A slow scroll over mostly-uniform content: a thin feature band shifts down by
    // dy while the rest of the surface is flat. The shift explains essentially all of
    // the (few) changed pixels, so confidence is ~1.0, but the changed FRACTION is
    // small. The minChangedFraction gate, meant only to reject coincidental matches
    // on near-static frames, wrongly rejected these to a ~200KB fullframe on device
    // (decision=fullframe-scroll-miss confidence=1.000000). With the certainConfidence
    // bypass, a near-perfect explanation over a floor of moved pixels is accepted as a
    // copyRect even though the changed fraction is below minChangedFraction.
    @Test func acceptsHighConfidenceScrollBelowChangedFractionViaCertainBypass() {
        let width = 640
        let height = 320
        let dy = 8
        let feature = 128..<144
        let previous = Self.surface(width: width, height: height) { feature.contains($0) ? Self.rowPattern($0) : 100 }
        let current = Self.surface(width: width, height: height) { feature.contains($0 - dy) ? Self.rowPattern($0 - dy) : 100 }
        let band = PixelRect(x: 0, y: 0, width: width, height: height)
        // minChangedFraction 0.30 is above this frame's changed fraction, so the clean
        // and input-corroborated paths cannot accept; only the certain bypass can.
        let classifier = DamageScrollClassifier(config: Self.config(minChangedFraction: 0.30, certainConfidence: 0.95))

        let result = classifier.classify(
            damageRects: [band],
            contentRect: band,
            previous: previous,
            current: current,
            hint: Self.verticalHint(candidateOffsets: [dy], sign: 1)
        )

        #expect(result == .scroll(region: band, dx: 0, dy: dy))
    }

    // Control: same frame, bypass disabled (certainConfidence unreachable). With the
    // changed fraction below minChangedFraction and no certain bypass, the frame falls
    // to the whole-surface fallback, the exact behavior the bypass exists to fix.
    @Test func rejectsHighConfidenceLowChangeScrollWhenCertainBypassDisabled() {
        let width = 640
        let height = 320
        let dy = 8
        let feature = 128..<144
        let previous = Self.surface(width: width, height: height) { feature.contains($0) ? Self.rowPattern($0) : 100 }
        let current = Self.surface(width: width, height: height) { feature.contains($0 - dy) ? Self.rowPattern($0 - dy) : 100 }
        let band = PixelRect(x: 0, y: 0, width: width, height: height)
        let classifier = DamageScrollClassifier(config: Self.config(minChangedFraction: 0.30, certainConfidence: 1.5))

        let result = classifier.classify(
            damageRects: [band],
            contentRect: band,
            previous: previous,
            current: current,
            hint: Self.verticalHint(candidateOffsets: [dy], sign: 1)
        )

        if case .scroll = result {
            Issue.record("bypass disabled must not accept a sub-threshold scroll, got \(result)")
        }
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
