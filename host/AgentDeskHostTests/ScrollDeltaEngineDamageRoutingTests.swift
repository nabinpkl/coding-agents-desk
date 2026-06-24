import CoreGraphics
import CoreVideo
import ImageIO
import Testing
@testable import AgentDeskHost

// H1: with the damage path on, the two non-scroll classifier outcomes
// (.fullFrame and .tiles) both emit a tile envelope over the reliable
// graphics channel instead of falling back to HEVC. .noChange yields a
// result with no envelope and no fallback flag.
struct ScrollDeltaEngineDamageRoutingTests {
    @Test func fullFrameOutcomeProducesTileEnvelopeNotRejection() throws {
        var engine = ScrollDeltaEngine()
        let width = 256
        let height = 256

        // Prime a solid surface (reset).
        let first = try Self.makeBGRAFrame(width: width, height: height) { _, _ in
            [10, 10, 10, 0xff]
        }
        #expect(engine.evaluate(first).kind == .reset)
        engine.commitPendingSurface()

        // Deliver a frame whose damage covers the whole surface with content
        // that differs everywhere and no scroll hint. The classifier returns
        // .fullFrame, which H1 routes to a tile envelope.
        let full = PixelRect(x: 0, y: 0, width: width, height: height)
        let churned = try Self.makeBGRAFrame(
            width: width,
            height: height,
            damageRects: [full],
            contentRectPixels: full
        ) { x, y in
            let v = UInt8((x * 37 + y * 101) & 0xff)
            return [v, v, v, 0xff]
        }
        let result = engine.evaluate(churned, scrollHint: nil)

        #expect(result.envelope != nil)
        #expect(result.envelope?.commands.contains { $0.kindIsBitmapTile } == true)
        #expect(result.fellBackToHEVC == false)
    }

    // A .fullFrame classification ships ONE lossy JPEG tile bounded to the
    // OS-reported damage union, not the entire surface and not N raw LZFSE cells.
    // Damage limited to the top half (50% coverage, above the small-tiles
    // threshold so the classifier returns .fullFrame) must emit a single jpeg tile
    // covering exactly the top half (height 128), leaving the unchanged bottom
    // half untouched. Per-cell raw LZFSE of a whole-screen change was multi-MB and
    // froze the link on device; one JPEG over the damage region is ~10x smaller.
    @Test func fullFrameEmitsSingleJpegTileBoundedToDamageNotWholeSurface() throws {
        var engine = ScrollDeltaEngine()
        let width = 256
        let height = 256

        let first = try Self.makeBGRAFrame(width: width, height: height) { _, _ in
            [10, 10, 10, 0xff]
        }
        #expect(engine.evaluate(first).kind == .reset)
        engine.commitPendingSurface()

        let topHalf = PixelRect(x: 0, y: 0, width: width, height: 128)
        let full = PixelRect(x: 0, y: 0, width: width, height: height)
        let changed = try Self.makeBGRAFrame(
            width: width,
            height: height,
            damageRects: [topHalf],
            contentRectPixels: full
        ) { x, y in
            if y < 128 {
                let v = UInt8((x * 37 + y * 101) & 0xff)
                return [v, v, v, 0xff]
            }
            // Bottom half is unchanged from the primed surface.
            return [10, 10, 10, 0xff]
        }
        let result = engine.evaluate(changed, scrollHint: nil)

        #expect(result.fellBackToHEVC == false)
        let tiles = result.envelope?.commands.compactMap { command -> (PixelRect, OwnedGraphicsTileCompression)? in
            guard case let .bitmapTile(x, y, w, h, compression, _) = command else { return nil }
            return (PixelRect(x: x, y: y, width: w, height: h), compression)
        } ?? []
        #expect(tiles.count == 1)
        #expect(tiles.first?.0 == topHalf)
        #expect(tiles.first?.1 == .jpeg)
    }

    // A fullframe JPEG must be stepped down in quality to fit the wire-byte
    // ceiling, so no single frame can clog the channel and trigger the reset
    // ackTimeout cascade. The same detailed fullframe encoded under a tiny budget
    // must be smaller than under an effectively unlimited one.
    @Test func fullFrameJpegSteppedDownToFitWireBudget() throws {
        func fullframeBytes(maxWireBytes: Int) throws -> Int {
            var engine = ScrollDeltaEngine(fullframeMaxWireBytes: maxWireBytes)
            let width = 256
            let height = 256
            let solid = try Self.makeBGRAFrame(width: width, height: height) { _, _ in [10, 10, 10, 0xff] }
            #expect(engine.evaluate(solid).kind == .reset)
            engine.commitPendingSurface()
            let full = PixelRect(x: 0, y: 0, width: width, height: height)
            let detailed = try Self.makeBGRAFrame(
                width: width,
                height: height,
                damageRects: [full],
                contentRectPixels: full
            ) { x, y in
                // Smooth gradient: representative of real screen content (UI, text,
                // gradients) where lower JPEG quality genuinely shrinks the payload,
                // unlike per-pixel noise which is incompressible at any quality.
                let v = UInt8((x + y) & 0xff)
                return [v, v, v, 0xff]
            }
            let result = engine.evaluate(detailed, scrollHint: nil)
            guard case .bitmapTile(_, _, _, _, .jpeg, _)? = result.envelope?.commands.first else {
                Issue.record("expected a fullframe JPEG tile")
                return 0
            }
            return result.envelope?.payload.count ?? 0
        }

        let unbounded = try fullframeBytes(maxWireBytes: 10_000_000)
        let bounded = try fullframeBytes(maxWireBytes: 3_000)
        #expect(unbounded > 0)
        #expect(bounded > 0)
        #expect(bounded < unbounded)
    }

    // Motion-adaptive quality: a fullframe emitted while a scroll hint is active
    // (mid-flick) must be encoded at the lower motion quality, so its payload is
    // smaller than the same fullframe emitted with no hint (settled/at rest). Both
    // frames carry full-surface damage with content no shift explains, so each
    // classifies fullframe; only the hint presence differs.
    @Test func fullFrameUsesSmallerMotionQualityWhenScrollHintActive() throws {
        func fullframeBytes(withHint: Bool) throws -> Int {
            var engine = ScrollDeltaEngine()
            let width = 256
            let height = 256
            let solid = try Self.makeBGRAFrame(width: width, height: height) { _, _ in [10, 10, 10, 0xff] }
            #expect(engine.evaluate(solid).kind == .reset)
            engine.commitPendingSurface()
            let full = PixelRect(x: 0, y: 0, width: width, height: height)
            let churned = try Self.makeBGRAFrame(
                width: width,
                height: height,
                damageRects: [full],
                contentRectPixels: full
            ) { x, y in
                // A smooth diagonal ramp so JPEG quality visibly changes the size.
                let v = UInt8((x + y) & 0xff)
                return [v, v, v, 0xff]
            }
            let hint: ScrollActivityHint? = withHint
                ? ScrollActivityHint(axis: .vertical, sign: 1, predictedOffsetPx: 40, candidateOffsets: [40], activeUntilUptimeNs: .max, eventCount: 4)
                : nil
            let result = engine.evaluate(churned, scrollHint: hint)
            guard case .bitmapTile(_, _, _, _, .jpeg, _)? = result.envelope?.commands.first else {
                Issue.record("expected a fullframe JPEG tile")
                return 0
            }
            return result.envelope?.payload.count ?? 0
        }

        let motionBytes = try fullframeBytes(withHint: true)
        let restBytes = try fullframeBytes(withHint: false)
        #expect(motionBytes > 0)
        #expect(restBytes > 0)
        #expect(motionBytes < restBytes)
    }

    // Congestion-adaptive quality: when the pump signals it is backed up, a
    // fullframe must encode at the congested floor (smaller than the motion
    // quality) so it drains fast and cadence holds instead of stalling into a
    // freeze. Same fullframe, same active hint; only the congested flag differs.
    @Test func fullFrameUsesCongestedQualityWhenPumpBackedUp() throws {
        func fullframeBytes(congested: Bool) throws -> Int {
            var engine = ScrollDeltaEngine()
            let width = 256
            let height = 256
            let solid = try Self.makeBGRAFrame(width: width, height: height) { _, _ in [10, 10, 10, 0xff] }
            #expect(engine.evaluate(solid).kind == .reset)
            engine.commitPendingSurface()
            let full = PixelRect(x: 0, y: 0, width: width, height: height)
            let churned = try Self.makeBGRAFrame(
                width: width,
                height: height,
                damageRects: [full],
                contentRectPixels: full
            ) { x, y in
                let v = UInt8((x + y) & 0xff)
                return [v, v, v, 0xff]
            }
            let hint = ScrollActivityHint(axis: .vertical, sign: 1, predictedOffsetPx: 40, candidateOffsets: [40], activeUntilUptimeNs: .max, eventCount: 4)
            let result = engine.evaluate(churned, scrollHint: hint, congestionLevel: congested ? 1.0 : 0.0)
            guard case .bitmapTile(_, _, _, _, .jpeg, _)? = result.envelope?.commands.first else {
                Issue.record("expected a fullframe JPEG tile")
                return 0
            }
            return result.envelope?.payload.count ?? 0
        }

        let congestedBytes = try fullframeBytes(congested: true)
        let motionBytes = try fullframeBytes(congested: false)
        #expect(congestedBytes > 0)
        #expect(motionBytes > 0)
        #expect(congestedBytes < motionBytes)
    }

    // The fullframe JPEG must survive the round trip without a vertical flip. Prime
    // a surface, deliver a fullframe whose top half is bright and bottom half dark,
    // then decode the emitted JPEG exactly as the client does (CGImageSource into a
    // top-down BGRA context). The decoded top must stay bright and the bottom dark:
    // a flipped encode would swap them, tearing every fullframe on device.
    @Test func fullFrameJpegRoundTripPreservesOrientation() throws {
        var engine = ScrollDeltaEngine()
        let width = 256
        let height = 256

        let first = try Self.makeBGRAFrame(width: width, height: height) { _, _ in
            [10, 10, 10, 0xff]
        }
        #expect(engine.evaluate(first).kind == .reset)
        engine.commitPendingSurface()

        let full = PixelRect(x: 0, y: 0, width: width, height: height)
        let gradient = try Self.makeBGRAFrame(
            width: width,
            height: height,
            damageRects: [full],
            contentRectPixels: full
        ) { _, y in
            // Gray, so channel order is irrelevant: top half white, bottom black.
            let v: UInt8 = y < height / 2 ? 240 : 16
            return [v, v, v, 0xff]
        }
        let result = engine.evaluate(gradient, scrollHint: nil)

        guard case let .bitmapTile(_, _, tileWidth, tileHeight, compression, byteRange)? =
                result.envelope?.commands.first(where: { $0.kindIsBitmapTile }),
              let payload = result.envelope?.payload else {
            Issue.record("fullframe must emit a bitmap tile")
            return
        }
        #expect(compression == .jpeg)

        let jpeg = payload[byteRange.offset..<(byteRange.offset + byteRange.length)]
        let decoded = try Self.decodeJPEGForTest(Data(jpeg), width: tileWidth, height: tileHeight)
        let topLuma = Self.luma(decoded, x: 8, y: 8, width: tileWidth)
        let bottomLuma = Self.luma(decoded, x: 8, y: tileHeight - 8, width: tileWidth)
        #expect(topLuma > 180)
        #expect(bottomLuma < 80)
    }

    // Congestion downscale: when the pump is backed up, the fullframe JPEG is
    // encoded at a fraction of the destination resolution (the client upscales it),
    // because on a thin link JPEG quality alone bottoms out and only fewer encoded
    // pixels drops the wire bytes. The bitmap tile still carries the full destination
    // size; only the JPEG's own pixel dimensions shrink. A non-congested fullframe
    // stays full resolution.
    @Test func congestedFullframeDownscalesEncodedJpegBelowDestination() throws {
        func sizes(congested: Bool) throws -> (destination: Int, encoded: Int) {
            var engine = ScrollDeltaEngine()
            let width = 256
            let height = 256
            let solid = try Self.makeBGRAFrame(width: width, height: height) { _, _ in [10, 10, 10, 0xff] }
            #expect(engine.evaluate(solid).kind == .reset)
            engine.commitPendingSurface()
            let full = PixelRect(x: 0, y: 0, width: width, height: height)
            let churned = try Self.makeBGRAFrame(
                width: width,
                height: height,
                damageRects: [full],
                contentRectPixels: full
            ) { x, y in
                let v = UInt8((x &* 37 &+ y &* 101) & 0xff)
                return [v, v, v, 0xff]
            }
            let hint = ScrollActivityHint(axis: .vertical, sign: 1, predictedOffsetPx: 40, candidateOffsets: [40], activeUntilUptimeNs: .max, eventCount: 4)
            let result = engine.evaluate(churned, scrollHint: hint, congestionLevel: congested ? 1.0 : 0.0)
            guard case let .bitmapTile(_, _, tileWidth, _, .jpeg, byteRange)? =
                    result.envelope?.commands.first(where: { $0.kindIsBitmapTile }),
                  let payload = result.envelope?.payload else {
                Issue.record("expected a fullframe JPEG tile")
                return (0, 0)
            }
            let jpeg = Data(payload[byteRange.offset..<(byteRange.offset + byteRange.length)])
            guard let encoded = Self.jpegPixelWidth(jpeg) else {
                Issue.record("could not read JPEG pixel size")
                return (0, 0)
            }
            return (tileWidth, encoded)
        }

        let congested = try sizes(congested: true)
        let rest = try sizes(congested: false)
        // Destination tile is full size in both; only the encoded JPEG shrinks.
        #expect(congested.destination == 256)
        #expect(rest.destination == 256)
        #expect(rest.encoded == 256)
        #expect(congested.encoded < 256)
        // Default congested scale is 0.5, so ~128 px wide.
        #expect(congested.encoded <= 130)
    }

    // A downscaled congested fullframe must still survive the round trip without a
    // vertical flip: vImage downscale on the host plus the client's CGContext upscale
    // must preserve orientation. Top half bright, bottom half dark; after a 0.5
    // downscale and full-size decode the top must stay bright and the bottom dark.
    @Test func congestedDownscaledFullframeRoundTripPreservesOrientation() throws {
        var engine = ScrollDeltaEngine()
        let width = 256
        let height = 256

        let first = try Self.makeBGRAFrame(width: width, height: height) { _, _ in [10, 10, 10, 0xff] }
        #expect(engine.evaluate(first).kind == .reset)
        engine.commitPendingSurface()

        let full = PixelRect(x: 0, y: 0, width: width, height: height)
        let gradient = try Self.makeBGRAFrame(
            width: width,
            height: height,
            damageRects: [full],
            contentRectPixels: full
        ) { _, y in
            let v: UInt8 = y < height / 2 ? 240 : 16
            return [v, v, v, 0xff]
        }
        let hint = ScrollActivityHint(axis: .vertical, sign: 1, predictedOffsetPx: 40, candidateOffsets: [40], activeUntilUptimeNs: .max, eventCount: 4)
        let result = engine.evaluate(gradient, scrollHint: hint, congestionLevel: 1.0)

        guard case let .bitmapTile(_, _, tileWidth, tileHeight, compression, byteRange)? =
                result.envelope?.commands.first(where: { $0.kindIsBitmapTile }),
              let payload = result.envelope?.payload else {
            Issue.record("fullframe must emit a bitmap tile")
            return
        }
        #expect(compression == .jpeg)

        let jpeg = payload[byteRange.offset..<(byteRange.offset + byteRange.length)]
        // Decode into the FULL destination size, exactly as the client upscales it.
        let decoded = try Self.decodeJPEGForTest(Data(jpeg), width: tileWidth, height: tileHeight)
        let topLuma = Self.luma(decoded, x: 8, y: 8, width: tileWidth)
        let bottomLuma = Self.luma(decoded, x: 8, y: tileHeight - 8, width: tileWidth)
        #expect(topLuma > 180)
        #expect(bottomLuma < 80)
    }

    // The congestion ramp replaces the binary congested cliff: quality drops
    // smoothly from the rest/motion baseline to the congested floor as the level
    // climbs, and resolution stays full until a mid threshold before ramping to the
    // floor. Neither ever crosses the working-version-11 floor (q0.15, scale 0.5).
    @Test func congestionQualityRampIsMonotonicBaselineToFloor() {
        let engine = ScrollDeltaEngine()
        let rest = engine.fullframeQuality(forLevel: 0, motion: false)
        let mid = engine.fullframeQuality(forLevel: 0.5, motion: false)
        let full = engine.fullframeQuality(forLevel: 1, motion: false)
        #expect(rest > mid)
        #expect(mid > full)
        #expect(abs(full - 0.15) < 1e-9)            // exactly the congested floor
        #expect(abs(rest - 0.65) < 1e-9)            // exactly the rest baseline
    }

    @Test func congestionScaleStaysFullUntilThresholdThenRampsToFloor() {
        let engine = ScrollDeltaEngine()
        #expect(engine.fullframeScale(forLevel: 0) == 1.0)
        #expect(engine.fullframeScale(forLevel: 0.5) == 1.0)   // at threshold, still full
        let mid = engine.fullframeScale(forLevel: 0.75)
        #expect(mid < 1.0 && mid > 0.5)                         // ramping
        #expect(abs(engine.fullframeScale(forLevel: 1) - 0.5) < 1e-9)  // floor, never below
    }

    // Per-row luma hash so a vertical shift is detectable and a scroll classifies
    // cleanly (mirrors the classifier test surfaces).
    private static func scrollRowValue(_ y: Int) -> UInt8 {
        var h = UInt32(truncatingIfNeeded: y &+ 1)
        h = h &* 2_654_435_761; h ^= (h >> 15); h = h &* 2_246_822_519; h ^= (h >> 13)
        return UInt8(truncatingIfNeeded: h >> 24)
    }

    // Drive a real downward scroll through the engine so the classifier returns
    // .scroll and makeScrollEnvelope runs, then report the exposed strip tile's
    // compression.
    private static func stripCompressionForDownScroll(dy: Int, width: Int, height: Int, congestionLevel: Double) throws -> OwnedGraphicsTileCompression {
        var engine = ScrollDeltaEngine()
        let first = try makeBGRAFrame(width: width, height: height) { _, y in
            let v = scrollRowValue(y); return [v, v, v, 0xff]
        }
        #expect(engine.evaluate(first).kind == .reset)
        engine.commitPendingSurface()
        let band = PixelRect(x: 0, y: 0, width: width, height: height)
        let scrolled = try makeBGRAFrame(width: width, height: height, damageRects: [band], contentRectPixels: band) { _, y in
            let v = scrollRowValue(y - dy); return [v, v, v, 0xff]
        }
        let hint = ScrollActivityHint(axis: .vertical, sign: 1, predictedOffsetPx: dy, candidateOffsets: [dy], activeUntilUptimeNs: .max, eventCount: 4)
        let result = engine.evaluate(scrolled, scrollHint: hint, congestionLevel: congestionLevel)
        guard let strip = result.envelope?.commands.first(where: { $0.kindIsBitmapTile }),
              case let .bitmapTile(_, _, _, _, compression, _) = strip else {
            Issue.record("expected a scroll strip bitmap tile, acceptedBy=\(String(describing: result.diagnostics?.acceptedBy))")
            return .lzfse
        }
        return compression
    }

    // A fast flick reveals a tall band: 640*240*4 = 614400 bytes >= the 524288
    // threshold, so the strip ships lossy JPEG instead of a large lossless blob.
    @Test func largeFlickScrollStripIsLossyJpeg() throws {
        let compression = try Self.stripCompressionForDownScroll(dy: 240, width: 640, height: 480, congestionLevel: 0)
        #expect(compression == .jpeg)
    }

    // A slow scroll on a calm link reveals a thin strip (640*8*4 = 20480 bytes, well
    // under threshold) and stays lossless so revealed text is crisp.
    @Test func slowCalmScrollStripStaysLossless() throws {
        let compression = try Self.stripCompressionForDownScroll(dy: 8, width: 640, height: 480, congestionLevel: 0)
        #expect(compression == .lzfse)
    }

    // The same small strip goes lossy when the link is congested.
    @Test func congestedSmallScrollStripIsLossyJpeg() throws {
        let compression = try Self.stripCompressionForDownScroll(dy: 8, width: 640, height: 480, congestionLevel: 1.0)
        #expect(compression == .jpeg)
    }

    // Pins the LZFSE tile path before the buildTile seam refactor (Task 4 TDD
    // anchor). A .tiles classification must emit one .lzfse bitmapTile per grid
    // cell with a byteRange whose length equals the tile's slice of the payload.
    // If buildTile changes the encoding or breaks byteRange accounting, this
    // test fails before the wire contract changes.
    @Test func tilesPathEmitsLzfseTilesWithCorrectByteRanges() throws {
        var engine = ScrollDeltaEngine()
        let width = 256
        let height = 256

        let first = try Self.makeBGRAFrame(width: width, height: height) { _, _ in
            [10, 10, 10, 0xff]
        }
        #expect(engine.evaluate(first).kind == .reset)
        engine.commitPendingSurface()

        // Change a small region so the damage classifier returns .tiles (small,
        // non-scroll, below the fullFrame threshold). A single 64x64 rect in a
        // 256x256 surface is 6.25% coverage; the classifier treats this as .tiles.
        let damageRect = PixelRect(x: 0, y: 0, width: 64, height: 64)
        let full = PixelRect(x: 0, y: 0, width: width, height: height)
        let changed = try Self.makeBGRAFrame(
            width: width,
            height: height,
            damageRects: [damageRect],
            contentRectPixels: full
        ) { x, y in
            if x < 64 && y < 64 {
                let v = UInt8((x * 13 + y * 7) & 0xff)
                return [v, v, v, 0xff]
            }
            return [10, 10, 10, 0xff]
        }
        let result = engine.evaluate(changed, scrollHint: nil)

        #expect(result.fellBackToHEVC == false)
        guard let envelope = result.envelope else {
            Issue.record("expected a tile envelope from the .tiles path")
            return
        }
        // All tiles that carry pixels (bitmapTile or cacheTile) must be LZFSE.
        // drawCachedTile carries no payload so it is excluded from byteRange checks.
        let tiles = envelope.commands.compactMap { cmd -> (PixelRect, OwnedGraphicsByteRange)? in
            switch cmd {
            case let .bitmapTile(x, y, w, h, compression, range):
                #expect(compression == .lzfse, "bitmapTile at (\(x),\(y)) must be lzfse, got \(compression)")
                return (PixelRect(x: x, y: y, width: w, height: h), range)
            case let .cacheTile(_, x, y, w, h, compression, range):
                #expect(compression == .lzfse, "cacheTile at (\(x),\(y)) must be lzfse, got \(compression)")
                return (PixelRect(x: x, y: y, width: w, height: h), range)
            default:
                return nil
            }
        }
        #expect(!tiles.isEmpty)
        // Each tile's byteRange must slice the real payload without gaps or overlaps.
        var cursor = 0
        for (rect, range) in tiles.sorted(by: { $0.1.offset < $1.1.offset }) {
            #expect(range.offset == cursor, "gap or overlap at tile \(rect): expected offset \(cursor), got \(range.offset)")
            #expect(range.length > 0, "tile \(rect) has zero-length payload")
            #expect(range.offset + range.length <= envelope.payload.count)
            cursor += range.length
        }
        #expect(cursor == envelope.payload.count, "payload has trailing bytes: cursor=\(cursor) payloadCount=\(envelope.payload.count)")
    }

    private static func jpegPixelWidth(_ data: Data) -> Int? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return nil }
        return image.width
    }

    // Mirrors the client's OwnedMediaVideoSink JPEG decode so the host test
    // validates the exact round trip the device runs.
    private static func decodeJPEGForTest(_ data: Data, width: Int, height: Int) throws -> Data {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            throw SessionRejected(reason: .malformed)
        }
        let bytesPerRow = width * 4
        var pixels = Data(count: bytesPerRow * height)
        let bitmapInfo = CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
        pixels.withUnsafeMutableBytes { raw in
            guard let base = raw.baseAddress,
                  let context = CGContext(
                    data: base, width: width, height: height,
                    bitsPerComponent: 8, bytesPerRow: bytesPerRow,
                    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: bitmapInfo
                  ) else { return }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        }
        return pixels
    }

    private static func luma(_ bgra: Data, x: Int, y: Int, width: Int) -> Int {
        let offset = y * width * 4 + x * 4
        let b = Int(bgra[offset])
        let g = Int(bgra[offset + 1])
        let r = Int(bgra[offset + 2])
        return (77 * r + 150 * g + 29 * b) >> 8
    }

    // Rung 1 (Task 5): macOS reports the same dirty rect twice in a row, but the
    // pixels equal the retained baseline on the second frame. The engine must
    // omit every tile and return .noChange instead of re-sending the identical
    // bytes and saturating the link.
    @Test func identicalTilesFrameSecondTimeIsNoChange() throws {
        var engine = ScrollDeltaEngine()
        let width = 256
        let height = 256
        let full = PixelRect(x: 0, y: 0, width: width, height: height)

        // Prime with a solid surface (reset path seeds the baseline).
        let first = try Self.makeBGRAFrame(width: width, height: height) { _, _ in
            [0x20, 0x20, 0x20, 0xff]
        }
        #expect(engine.evaluate(first).kind == .reset)
        engine.commitPendingSurface()

        // Deliver a frame with a real change in the top-left 64x64 cell.
        let damageRect = PixelRect(x: 0, y: 0, width: 64, height: 64)
        let changed = try Self.makeBGRAFrame(
            width: width,
            height: height,
            damageRects: [damageRect],
            contentRectPixels: full
        ) { x, y in
            if x < 64 && y < 64 { return [0x80, 0x80, 0x80, 0xff] }
            return [0x20, 0x20, 0x20, 0xff]
        }
        let r1 = engine.evaluate(changed)
        #expect(r1.kind == .accepted)
        engine.commitPendingSurface()

        // Re-send the exact same frame. The OS reports the same dirty rect but
        // the pixels now equal the retained baseline, so nothing should be sent.
        let r2 = engine.evaluate(changed)
        #expect(r2.kind == .noChange)
    }

    // Rung 1 (Task 5): two dirty cells are reported, but only one differs from
    // the retained baseline. The engine must send exactly one bitmapTile command
    // (the truly changed cell) and omit the unchanged cell entirely.
    @Test func partialTilesChangeSendsOnlyChangedCells() throws {
        var engine = ScrollDeltaEngine()
        let width = 256
        let height = 256
        let full = PixelRect(x: 0, y: 0, width: width, height: height)

        // Prime with a solid surface.
        let base = try Self.makeBGRAFrame(width: width, height: height) { _, _ in
            [0x20, 0x20, 0x20, 0xff]
        }
        #expect(engine.evaluate(base).kind == .reset)
        engine.commitPendingSurface()

        // Report two dirty cells, but only the first cell (0,0)-(64,64) actually
        // changes. The second cell (128,128)-(192,192) stays at the baseline fill.
        let cell1 = PixelRect(x: 0, y: 0, width: 64, height: 64)
        let cell2 = PixelRect(x: 128, y: 128, width: 64, height: 64)
        let frame = try Self.makeBGRAFrame(
            width: width,
            height: height,
            damageRects: [cell1, cell2],
            contentRectPixels: full
        ) { x, y in
            if x < 64 && y < 64 { return [0x90, 0x90, 0x90, 0xff] }
            return [0x20, 0x20, 0x20, 0xff]
        }
        let r = engine.evaluate(frame)
        #expect(r.kind == .accepted)
        // Count all commands that carry pixels: bitmapTile or cacheTile (first seen
        // content). drawCachedTile references a slot but sends no pixels; it counts
        // as a tile send for this purpose. Rung 1 must have dropped the unchanged
        // cell at (128,128), so exactly one tile-bearing command must be present.
        let tiles = r.envelope?.commands.filter {
            switch $0 {
            case .bitmapTile, .cacheTile, .drawCachedTile: return true
            default: return false
            }
        } ?? []
        // Only the changed cell at (0,0) must be sent; the unchanged cell at
        // (128,128) is omitted because its pixels equal the retained baseline.
        #expect(tiles.count == 1)
    }

    // Rung 2 (Task 10): content that was seen at (0,0) and cached must be
    // recognized via drawCachedTile when it appears at (128,128). The first
    // appearance must emit cacheTile (sends pixels); the second appearance
    // of the same pixels at a new position must emit drawCachedTile (no pixels).
    @Test func repeatedContentAtNewPositionUsesDrawCachedTile() throws {
        var engine = ScrollDeltaEngine()
        let width = 256
        let height = 256
        let full = PixelRect(x: 0, y: 0, width: width, height: height)

        // Prime a solid background.
        let base = try Self.makeBGRAFrame(width: width, height: height) { _, _ in
            [0x20, 0x20, 0x20, 0xff]
        }
        #expect(engine.evaluate(base).kind == .reset)
        engine.commitPendingSurface()

        // First appearance of 0xAA content at (0,0)-(64,64): must emit cacheTile.
        let damage1 = PixelRect(x: 0, y: 0, width: 64, height: 64)
        let f1 = try Self.makeBGRAFrame(
            width: width, height: height,
            damageRects: [damage1], contentRectPixels: full
        ) { x, y in
            if x < 64 && y < 64 { return [0xAA, 0xAA, 0xAA, 0xff] }
            return [0x20, 0x20, 0x20, 0xff]
        }
        let r1 = engine.evaluate(f1)
        engine.commitPendingSurface()
        #expect(r1.envelope!.commands.contains { if case .cacheTile = $0 { return true }; return false },
                "first appearance must emit cacheTile")

        // Second appearance: same 0xAA content at (128,128)-(192,192); (0,0) reverts.
        // Report both rects as damaged so the engine's grid sees both cells.
        let damage2a = PixelRect(x: 0, y: 0, width: 64, height: 64)
        let damage2b = PixelRect(x: 128, y: 128, width: 64, height: 64)
        let f2 = try Self.makeBGRAFrame(
            width: width, height: height,
            damageRects: [damage2a, damage2b], contentRectPixels: full
        ) { x, y in
            if x >= 128 && x < 192 && y >= 128 && y < 192 { return [0xAA, 0xAA, 0xAA, 0xff] }
            return [0x20, 0x20, 0x20, 0xff]
        }
        let r2 = engine.evaluate(f2)
        engine.commitPendingSurface()
        #expect(r2.envelope!.commands.contains { if case .drawCachedTile = $0 { return true }; return false },
                "second appearance of same content at new position must emit drawCachedTile")
    }

    // Rung 2 (Task 10): after invalidateRetainedSurface the cache must be cleared,
    // forcing the same content to be re-sent as cacheTile, never drawCachedTile.
    @Test func generationResetClearsCache() throws {
        var engine = ScrollDeltaEngine()
        let width = 256
        let height = 256
        let full = PixelRect(x: 0, y: 0, width: width, height: height)

        // Prime and commit a baseline.
        let base = try Self.makeBGRAFrame(width: width, height: height) { _, _ in
            [0x20, 0x20, 0x20, 0xff]
        }
        #expect(engine.evaluate(base).kind == .reset)
        engine.commitPendingSurface()

        // First appearance of 0xAA at (0,0): cached.
        let damage1 = PixelRect(x: 0, y: 0, width: 64, height: 64)
        let f1 = try Self.makeBGRAFrame(
            width: width, height: height,
            damageRects: [damage1], contentRectPixels: full
        ) { x, y in
            if x < 64 && y < 64 { return [0xAA, 0xAA, 0xAA, 0xff] }
            return [0x20, 0x20, 0x20, 0xff]
        }
        _ = engine.evaluate(f1)
        engine.commitPendingSurface()

        // Invalidate: forces a reset on the next evaluate.
        engine.invalidateRetainedSurface()

        // Re-seed after the reset (reset path).
        let reseed = try Self.makeBGRAFrame(width: width, height: height) { _, _ in
            [0x20, 0x20, 0x20, 0xff]
        }
        _ = engine.evaluate(reseed)
        engine.commitPendingSurface()

        // Same 0xAA content now at (128,128): the cache was cleared on reset,
        // so the engine must emit cacheTile, not drawCachedTile.
        let damage2 = PixelRect(x: 128, y: 128, width: 64, height: 64)
        let f2 = try Self.makeBGRAFrame(
            width: width, height: height,
            damageRects: [damage2], contentRectPixels: full
        ) { x, y in
            if x >= 128 && x < 192 && y >= 128 && y < 192 { return [0xAA, 0xAA, 0xAA, 0xff] }
            return [0x20, 0x20, 0x20, 0xff]
        }
        let r = engine.evaluate(f2)
        #expect(!r.envelope!.commands.contains { if case .drawCachedTile = $0 { return true }; return false },
                "after reset, same content must be re-sent as cacheTile, not drawCachedTile")
    }

    private static func makeBGRAFrame(
        width: Int,
        height: Int,
        damageRects: [PixelRect] = [],
        contentRectPixels: PixelRect? = nil,
        pixel: (Int, Int) -> [UInt8]
    ) throws -> CapturedVideoFrame {
        var pixelBuffer: CVPixelBuffer?
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            width,
            height,
            kCVPixelFormatType_32BGRA,
            [
                kCVPixelBufferIOSurfacePropertiesKey: [:],
                kCVPixelBufferCGImageCompatibilityKey: true,
                kCVPixelBufferCGBitmapContextCompatibilityKey: true
            ] as CFDictionary,
            &pixelBuffer
        )
        guard status == kCVReturnSuccess, let pixelBuffer else {
            throw SessionRejected(reason: .malformed)
        }
        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, []) }
        guard let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) else {
            throw SessionRejected(reason: .malformed)
        }
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        for y in 0..<height {
            for x in 0..<width {
                let bytes = pixel(x, y)
                let offset = y * bytesPerRow + x * 4
                baseAddress.storeBytes(of: bytes[0], toByteOffset: offset, as: UInt8.self)
                baseAddress.storeBytes(of: bytes[1], toByteOffset: offset + 1, as: UInt8.self)
                baseAddress.storeBytes(of: bytes[2], toByteOffset: offset + 2, as: UInt8.self)
                baseAddress.storeBytes(of: bytes[3], toByteOffset: offset + 3, as: UInt8.self)
            }
        }
        return CapturedVideoFrame(
            pixelBuffer: pixelBuffer,
            presentationTimeNs: 123_000_000,
            capturedAtUptimeNs: 456_000_000,
            rotation: ._0,
            damageRects: damageRects,
            contentRectPixels: contentRectPixels
        )
    }
}
