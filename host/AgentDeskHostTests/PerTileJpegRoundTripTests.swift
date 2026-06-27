import CoreGraphics
import CoreVideo
import ImageIO
import Testing
@testable import AgentDeskHost

// Coverage for the per-tile JPEG path that replaced the deleted whole-frame JPEG
// (Task 2 removed the old fullframe-JPEG orientation and congestion-downscale
// tests; the underlying buildTile .jpeg path is unchanged but was left untested).
// These drive a busy cell through the cacheTile JPEG path and decode it exactly as
// the client does, asserting no vertical flip and a real downscale under congestion.
struct PerTileJpegRoundTripTests {

    // A busy cell encoded as a JPEG cacheTile must survive the round trip without a
    // vertical flip. The cell's top rows are bright and bottom rows dark; after the
    // client-style decode the top must stay bright and the bottom dark. A flipped
    // encode would swap them, tearing every JPEG tile on device.
    @Test func busyCellJpegCacheTileRoundTripPreservesOrientation() throws {
        // Force JPEG on the changed cell with a near-zero busy threshold.
        var engine = ScrollDeltaEngine(hybridTileBusyBytesPerPixel: 0.001)
        let width = 256
        let height = 256
        let full = PixelRect(x: 0, y: 0, width: width, height: height)

        let first = try Self.makeBGRAFrame(width: width, height: height) { _, _ in
            [10, 10, 10, 0xff]
        }
        #expect(engine.evaluate(first).kind == .reset)
        engine.commitPendingSurface()

        // A single 64x64 changed cell at (0,0): top half bright, bottom half dark.
        // Gray so channel order is irrelevant.
        let damageRect = PixelRect(x: 0, y: 0, width: 64, height: 64)
        let changed = try Self.makeBGRAFrame(
            width: width, height: height,
            damageRects: [damageRect], contentRectPixels: full
        ) { x, y in
            if x < 64 && y < 64 {
                let v: UInt8 = y < 32 ? 240 : 16
                return [v, v, v, 0xff]
            }
            return [10, 10, 10, 0xff]
        }
        let result = engine.evaluate(changed, scrollHint: nil, congestionLevel: 0)

        guard case let .cacheTile(_, _, _, tileWidth, tileHeight, compression, byteRange)? =
                result.envelope?.commands.first(where: { if case .cacheTile = $0 { return true }; return false }),
              let payload = result.envelope?.payload else {
            Issue.record("expected a JPEG cacheTile for the busy cell")
            return
        }
        #expect(compression == .jpeg)

        let jpeg = Data(payload[byteRange.offset..<(byteRange.offset + byteRange.length)])
        let decoded = try Self.decodeJPEGForTest(jpeg, width: tileWidth, height: tileHeight)
        let topLuma = Self.luma(decoded, x: 8, y: 8, width: tileWidth)
        let bottomLuma = Self.luma(decoded, x: 8, y: tileHeight - 8, width: tileWidth)
        #expect(topLuma > 180)
        #expect(bottomLuma < 80)
    }

    // Under congestion, the per-tile JPEG is encoded at a fraction of the cell's
    // destination resolution (the client upscales it). The cacheTile still carries
    // the full destination size; only the embedded JPEG's own pixel dimensions
    // shrink. A non-congested JPEG tile stays full resolution.
    @Test func congestedBusyCellJpegDownscalesEncodedBelowDestination() throws {
        func encodedWidth(congested: Bool) throws -> (destination: Int, encoded: Int) {
            var engine = ScrollDeltaEngine(hybridTileBusyBytesPerPixel: 0.001)
            let width = 256
            let height = 256
            let full = PixelRect(x: 0, y: 0, width: width, height: height)

            let first = try Self.makeBGRAFrame(width: width, height: height) { _, _ in
                [10, 10, 10, 0xff]
            }
            #expect(engine.evaluate(first).kind == .reset)
            engine.commitPendingSurface()

            // A 128x128 busy noise cell so the downscale is observable.
            let damageRect = PixelRect(x: 0, y: 0, width: 128, height: 128)
            let changed = try Self.makeBGRAFrame(
                width: width, height: height,
                damageRects: [damageRect], contentRectPixels: full
            ) { x, y in
                if x < 128 && y < 128 {
                    let seed = UInt32(truncatingIfNeeded: x &* 1664525 &+ y &* 1013904223 &+ 7)
                    return [UInt8(truncatingIfNeeded: seed >> 16), UInt8(truncatingIfNeeded: seed >> 8), UInt8(truncatingIfNeeded: seed), 0xff]
                }
                return [10, 10, 10, 0xff]
            }
            let result = engine.evaluate(changed, scrollHint: nil, congestionLevel: congested ? 1.0 : 0.0)
            guard case let .cacheTile(_, _, _, tileWidth, _, .jpeg, byteRange)? =
                    result.envelope?.commands.first(where: { if case .cacheTile = $0 { return true }; return false }),
                  let payload = result.envelope?.payload else {
                Issue.record("expected a JPEG cacheTile")
                return (0, 0)
            }
            let jpeg = Data(payload[byteRange.offset..<(byteRange.offset + byteRange.length)])
            guard let encoded = Self.jpegPixelWidth(jpeg) else {
                Issue.record("could not read JPEG pixel size")
                return (0, 0)
            }
            return (tileWidth, encoded)
        }

        let congested = try encodedWidth(congested: true)
        let rest = try encodedWidth(congested: false)
        // Destination cell is full size in both; only the encoded JPEG shrinks.
        #expect(congested.destination == 128)
        #expect(rest.destination == 128)
        #expect(rest.encoded == 128)
        #expect(congested.encoded < 128)
        // Default congested scale is 0.5, so ~64 px wide.
        #expect(congested.encoded <= 66)
    }

    private static func jpegPixelWidth(_ data: Data) -> Int? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return nil }
        return image.width
    }

    // Mirrors the client's OwnedMediaVideoSink JPEG decode so the host test
    // validates the exact round trip the device runs (top-down BGRA, upscale to fill).
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
            context.interpolationQuality = .medium
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
