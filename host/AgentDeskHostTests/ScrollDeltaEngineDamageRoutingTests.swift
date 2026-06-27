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
