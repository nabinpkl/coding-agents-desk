import CoreGraphics
import CoreVideo
import Testing
@testable import AgentDeskHost

// Task 1: per-tile encoding in the rung-3 store path. A rung-3 miss on a
// highly-compressible (texty) cell must emit .lzfse; a rung-3 miss on a
// poorly-compressible (busy/photo-like) cell must emit .jpeg. The threshold
// is Config.hybridTileBusyBytesPerPixel (LZFSE compressed / raw pixel count).
// Both cases still emit cacheTile (not bitmapTile); only the compression field
// and payload differ.
struct HybridTileEncodingTests {

    // A flat solid-color cell is trivially compressible: LZFSE near 0 bytes/pixel.
    // It must emit .lzfse cacheTile, not .jpeg.
    @Test func compressibleTileEmitsLzfse() throws {
        var engine = ScrollDeltaEngine()
        let width = 256
        let height = 256

        let first = try Self.makeBGRAFrame(width: width, height: height) { _, _ in
            [10, 10, 10, 0xff]
        }
        #expect(engine.evaluate(first).kind == .reset)
        engine.commitPendingSurface()

        // A 64x64 tile of a solid flat fill compresses extremely well with LZFSE:
        // well under 1 byte per BGRA pixel, far below the 2.0 bpp threshold.
        let damageRect = PixelRect(x: 0, y: 0, width: 64, height: 64)
        let full = PixelRect(x: 0, y: 0, width: width, height: height)
        let solid = try Self.makeBGRAFrame(
            width: width,
            height: height,
            damageRects: [damageRect],
            contentRectPixels: full
        ) { x, y in
            if x < 64 && y < 64 { return [0x80, 0x80, 0x80, 0xff] }
            return [10, 10, 10, 0xff]
        }
        let result = engine.evaluate(solid)

        // Must emit cacheTile (rung 3), not bitmapTile (rung 0 / non-cache path).
        let cacheTiles = result.envelope?.commands.compactMap { cmd -> OwnedGraphicsTileCompression? in
            guard case let .cacheTile(_, x, y, _, _, compression, _) = cmd, x == 0, y == 0 else { return nil }
            return compression
        } ?? []
        #expect(cacheTiles.count == 1, "expected exactly one cacheTile for the changed cell")
        #expect(cacheTiles.first == .lzfse, "compressible cell must use LZFSE")
    }

    // A per-pixel random noise cell is nearly incompressible with LZFSE: it
    // approaches or exceeds 4 bytes/pixel (the raw BGRA size). It must emit .jpeg.
    @Test func incompressibleTileEmitsJpeg() throws {
        // Override the busy threshold to 2.0 bytes/pixel (the default), so random
        // noise, which LZFSE cannot shrink below 3-4 bpp, reliably crosses it.
        var engine = ScrollDeltaEngine(hybridTileBusyBytesPerPixel: 2.0)
        let width = 256
        let height = 256

        let first = try Self.makeBGRAFrame(width: width, height: height) { _, _ in
            [10, 10, 10, 0xff]
        }
        #expect(engine.evaluate(first).kind == .reset)
        engine.commitPendingSurface()

        // A 64x64 tile of per-pixel pseudorandom noise is effectively
        // incompressible with LZFSE: each pixel is drawn from a PRNG, so LZFSE
        // cannot find runs or patterns and inflates to near-raw size.
        // 64x64 = 4096 pixels in a 256x256 surface = 6.25% coverage, staying
        // under the .fullFrame threshold so the classifier returns .tiles.
        let damageRect = PixelRect(x: 0, y: 0, width: 64, height: 64)
        let full = PixelRect(x: 0, y: 0, width: width, height: height)
        let noisy = try Self.makeBGRAFrame(
            width: width,
            height: height,
            damageRects: [damageRect],
            contentRectPixels: full
        ) { x, y in
            if x >= 64 || y >= 64 { return [10, 10, 10, 0xff] }
            // Simple LCG that produces a full-range value for every pixel position.
            let seed = UInt32(truncatingIfNeeded: x &* 1664525 &+ y &* 1013904223 &+ 42)
            let v = UInt8(truncatingIfNeeded: seed >> 16)
            let v2 = UInt8(truncatingIfNeeded: seed >> 8)
            let v3 = UInt8(truncatingIfNeeded: seed)
            return [v, v2, v3, 0xff]
        }
        let result = engine.evaluate(noisy)

        let cacheTiles = result.envelope?.commands.compactMap { cmd -> OwnedGraphicsTileCompression? in
            guard case let .cacheTile(_, x, y, _, _, compression, _) = cmd, x == 0, y == 0 else { return nil }
            return compression
        } ?? []
        #expect(cacheTiles.count == 1, "expected exactly one cacheTile for the changed cell")
        #expect(cacheTiles.first == .jpeg, "incompressible cell must use JPEG")
    }

    // Setting the threshold to an extremely high value must force all rung-3 cells
    // to LZFSE regardless of content, because no real LZFSE output exceeds the
    // threshold when it is set to the raw pixel size (4 bpp = max possible).
    @Test func veryHighThresholdForcesAllLzfse() throws {
        var engine = ScrollDeltaEngine(hybridTileBusyBytesPerPixel: 99.0)
        let width = 256
        let height = 256

        let first = try Self.makeBGRAFrame(width: width, height: height) { _, _ in
            [10, 10, 10, 0xff]
        }
        #expect(engine.evaluate(first).kind == .reset)
        engine.commitPendingSurface()

        let damageRect = PixelRect(x: 0, y: 0, width: 64, height: 64)
        let full = PixelRect(x: 0, y: 0, width: width, height: height)
        let noisy = try Self.makeBGRAFrame(
            width: width,
            height: height,
            damageRects: [damageRect],
            contentRectPixels: full
        ) { x, y in
            if x >= 64 || y >= 64 { return [10, 10, 10, 0xff] }
            let seed = UInt32(truncatingIfNeeded: x &* 1664525 &+ y &* 1013904223 &+ 99)
            let v = UInt8(truncatingIfNeeded: seed >> 16)
            let v2 = UInt8(truncatingIfNeeded: seed >> 8)
            let v3 = UInt8(truncatingIfNeeded: seed)
            return [v, v2, v3, 0xff]
        }
        let result = engine.evaluate(noisy)

        for cmd in result.envelope?.commands ?? [] {
            if case let .cacheTile(_, _, _, _, _, compression, _) = cmd {
                #expect(compression == .lzfse, "high threshold must keep all cache tiles LZFSE")
            }
        }
    }

    // Setting the threshold to near zero must force all rung-3 cells to JPEG,
    // because even a flat-fill cell's LZFSE output exceeds 0.001 bpp.
    @Test func nearZeroThresholdForcesAllJpeg() throws {
        var engine = ScrollDeltaEngine(hybridTileBusyBytesPerPixel: 0.001)
        let width = 256
        let height = 256

        let first = try Self.makeBGRAFrame(width: width, height: height) { _, _ in
            [10, 10, 10, 0xff]
        }
        #expect(engine.evaluate(first).kind == .reset)
        engine.commitPendingSurface()

        let damageRect = PixelRect(x: 0, y: 0, width: 64, height: 64)
        let full = PixelRect(x: 0, y: 0, width: width, height: height)
        let solid = try Self.makeBGRAFrame(
            width: width,
            height: height,
            damageRects: [damageRect],
            contentRectPixels: full
        ) { x, y in
            if x < 64 && y < 64 { return [0x60, 0x60, 0x60, 0xff] }
            return [10, 10, 10, 0xff]
        }
        let result = engine.evaluate(solid)

        for cmd in result.envelope?.commands ?? [] {
            if case let .cacheTile(_, _, _, _, _, compression, _) = cmd {
                #expect(compression == .jpeg, "near-zero threshold must force all cache tiles JPEG")
            }
        }
    }

    // The cache slot is always keyed and verified on SOURCE bytes (the BGRA
    // tile before any encoding). After a JPEG cacheTile is sent and committed,
    // the same source tile appearing again must hit rung 2 (drawCachedTile),
    // not re-encode. This confirms that TileContentCache.assign still stores
    // source bytes regardless of the chosen encoding.
    @Test func jpegCachedCellHitsRung2OnSecondAppearance() throws {
        var engine = ScrollDeltaEngine(hybridTileBusyBytesPerPixel: 0.001)
        let width = 256
        let height = 256

        let first = try Self.makeBGRAFrame(width: width, height: height) { _, _ in
            [10, 10, 10, 0xff]
        }
        #expect(engine.evaluate(first).kind == .reset)
        engine.commitPendingSurface()

        let full = PixelRect(x: 0, y: 0, width: width, height: height)

        // First appearance of 0xCC solid at (0,0): rung 3, forced JPEG by low threshold.
        let damage1 = PixelRect(x: 0, y: 0, width: 64, height: 64)
        let f1 = try Self.makeBGRAFrame(
            width: width, height: height,
            damageRects: [damage1], contentRectPixels: full
        ) { x, y in
            if x < 64 && y < 64 { return [0xCC, 0xCC, 0xCC, 0xff] }
            return [10, 10, 10, 0xff]
        }
        let r1 = engine.evaluate(f1)
        // Must be a cacheTile (rung 3, JPEG in this case).
        let r1HasCacheTile = r1.envelope?.commands.contains {
            if case .cacheTile = $0 { return true }; return false
        } ?? false
        #expect(r1HasCacheTile, "first appearance must be a cacheTile")
        engine.commitPendingSurface()

        // Second appearance of 0xCC at (128,128); (0,0) reverts to background.
        let damage2a = PixelRect(x: 0, y: 0, width: 64, height: 64)
        let damage2b = PixelRect(x: 128, y: 128, width: 64, height: 64)
        let f2 = try Self.makeBGRAFrame(
            width: width, height: height,
            damageRects: [damage2a, damage2b], contentRectPixels: full
        ) { x, y in
            if x >= 128 && x < 192 && y >= 128 && y < 192 { return [0xCC, 0xCC, 0xCC, 0xff] }
            return [10, 10, 10, 0xff]
        }
        let r2 = engine.evaluate(f2)
        let r2HasDrawCachedTile = r2.envelope?.commands.contains {
            if case .drawCachedTile = $0 { return true }; return false
        } ?? false
        #expect(r2HasDrawCachedTile,
                "second appearance of same source must hit rung 2 (drawCachedTile), confirming cache is keyed on source bytes not encoded output")
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
