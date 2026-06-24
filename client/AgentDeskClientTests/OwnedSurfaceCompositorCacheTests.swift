import Compression
import Foundation
import Testing
@testable import AgentDeskClient

// Tests for the slot-bitmap cache added by Task 9:
// cacheTile stores decoded pixels under a slot, drawCachedTile blits them,
// and reset clears the slot table.
struct OwnedSurfaceCompositorCacheTests {

    // Build a seed envelope: reset + one LZFSE bitmapTile covering the full surface.
    private static func makeSeedSurfaceEnvelope(
        surfaceGeneration: UInt32,
        frameId: UInt64,
        width: Int,
        height: Int,
        pixels: Data
    ) throws -> OwnedGraphicsFrameEnvelope {
        let payload = try compressLZFSE(pixels)
        return OwnedGraphicsFrameEnvelope(
            header: OwnedGraphicsFrameHeader(
                surfaceGeneration: surfaceGeneration,
                frameId: frameId,
                capturedAtUptimeNs: frameId * 100,
                commandCount: 2,
                payloadLength: payload.count
            ),
            commands: [
                .resetSurface(
                    surfaceGeneration: surfaceGeneration,
                    width: width,
                    height: height,
                    pixelFormat: .bgra
                ),
                .bitmapTile(
                    x: 0,
                    y: 0,
                    width: width,
                    height: height,
                    compression: .lzfse,
                    byteRange: OwnedGraphicsByteRange(offset: 0, length: payload.count)
                )
            ],
            payload: payload
        )
    }

    // Build an envelope containing a resetSurface command only.
    private static func makeResetSurfaceEnvelope(
        surfaceGeneration: UInt32,
        frameId: UInt64
    ) -> OwnedGraphicsFrameEnvelope {
        OwnedGraphicsFrameEnvelope(
            header: OwnedGraphicsFrameHeader(
                surfaceGeneration: surfaceGeneration,
                frameId: frameId,
                capturedAtUptimeNs: frameId * 100,
                commandCount: 1,
                payloadLength: 0
            ),
            commands: [
                .resetSurface(
                    surfaceGeneration: surfaceGeneration,
                    width: 128,
                    height: 128,
                    pixelFormat: .bgra
                )
            ],
            payload: Data()
        )
    }

    // Build a plain LZFSE cacheTile envelope (no surface reset).
    private static func makeCacheTileEnvelope(
        surfaceGeneration: UInt32,
        frameId: UInt64,
        slot: UInt16,
        x: Int,
        y: Int,
        width: Int,
        height: Int,
        pixels: Data
    ) throws -> OwnedGraphicsFrameEnvelope {
        let payload = try compressLZFSE(pixels)
        return OwnedGraphicsFrameEnvelope(
            header: OwnedGraphicsFrameHeader(
                surfaceGeneration: surfaceGeneration,
                frameId: frameId,
                capturedAtUptimeNs: frameId * 100,
                commandCount: 1,
                payloadLength: payload.count
            ),
            commands: [
                .cacheTile(
                    slot: slot,
                    x: x,
                    y: y,
                    width: width,
                    height: height,
                    compression: .lzfse,
                    byteRange: OwnedGraphicsByteRange(offset: 0, length: payload.count)
                )
            ],
            payload: payload
        )
    }

    // Build a drawCachedTile envelope.
    private static func makeDrawCachedTileEnvelope(
        surfaceGeneration: UInt32,
        frameId: UInt64,
        slot: UInt16,
        x: Int,
        y: Int,
        width: Int,
        height: Int
    ) -> OwnedGraphicsFrameEnvelope {
        OwnedGraphicsFrameEnvelope(
            header: OwnedGraphicsFrameHeader(
                surfaceGeneration: surfaceGeneration,
                frameId: frameId,
                capturedAtUptimeNs: frameId * 100,
                commandCount: 1,
                payloadLength: 0
            ),
            commands: [
                .drawCachedTile(
                    slot: slot,
                    x: x,
                    y: y,
                    width: width,
                    height: height
                )
            ],
            payload: Data()
        )
    }

    private static func compressLZFSE(_ data: Data) throws -> Data {
        var outputSize = max(data.count + 1024, 1024)
        while outputSize <= max(data.count * 8, 4096) {
            var output = Data(count: outputSize)
            let encodedCount = output.withUnsafeMutableBytes { outputBytes in
                data.withUnsafeBytes { inputBytes in
                    compression_encode_buffer(
                        outputBytes.bindMemory(to: UInt8.self).baseAddress!,
                        outputSize,
                        inputBytes.bindMemory(to: UInt8.self).baseAddress!,
                        data.count,
                        nil,
                        COMPRESSION_LZFSE
                    )
                }
            }
            if encodedCount > 0 {
                output.removeSubrange(encodedCount..<output.count)
                return output
            }
            outputSize *= 2
        }
        throw SessionRejected(reason: .malformed)
    }

    private static func pixel(_ pixels: Data, width: Int, x: Int, y: Int) -> Data {
        let offset = (y * width + x) * 4
        return pixels.subdata(in: offset..<(offset + 4))
    }

    // cacheTile stores decoded pixels then drawCachedTile blits the same pixels
    // to a different position. The destination region must match the source tile;
    // the untouched region must not change.
    @Test func cacheTileStoresThenDrawCachedTileBlits() throws {
        let surfaceWidth = 128
        let surfaceHeight = 128
        let tileW = 64
        let tileH = 64

        // Seed the surface with a known pattern.
        var seedPixels = Data(count: surfaceWidth * surfaceHeight * 4)
        for i in 0..<(surfaceWidth * surfaceHeight) {
            let base = i * 4
            seedPixels[base] = UInt8(i & 0xff)
            seedPixels[base + 1] = UInt8((i >> 8) & 0xff)
            seedPixels[base + 2] = 0x42
            seedPixels[base + 3] = 0xff
        }
        var compositor = OwnedSurfaceCompositor()
        _ = try compositor.applyGraphicsFrame(Self.makeSeedSurfaceEnvelope(
            surfaceGeneration: 1,
            frameId: 1,
            width: surfaceWidth,
            height: surfaceHeight,
            pixels: seedPixels
        ))

        // Build a solid-color tile that differs visually from the seed.
        var tilePixels = Data(count: tileW * tileH * 4)
        for i in 0..<(tileW * tileH) {
            let base = i * 4
            tilePixels[base] = 0xAA
            tilePixels[base + 1] = 0xBB
            tilePixels[base + 2] = 0xCC
            tilePixels[base + 3] = 0xff
        }

        // cacheTile at (0, 0), slot 3.
        let cacheStats = try compositor.applyGraphicsFrame(Self.makeCacheTileEnvelope(
            surfaceGeneration: 1,
            frameId: 2,
            slot: 3,
            x: 0,
            y: 0,
            width: tileW,
            height: tileH,
            pixels: tilePixels
        ))
        #expect(cacheStats.tileBytes == tileW * tileH * 4)

        // drawCachedTile slot 3 to (64, 64).
        let drawStats = try compositor.applyGraphicsFrame(Self.makeDrawCachedTileEnvelope(
            surfaceGeneration: 1,
            frameId: 3,
            slot: 3,
            x: 64,
            y: 64,
            width: tileW,
            height: tileH
        ))
        _ = drawStats

        let result = compositor.pixelBytesForDiagnostics()

        // Destination region (64, 64) to (127, 127) must equal the cached tile pixels.
        for row in 0..<tileH {
            for col in 0..<tileW {
                let srcOffset = (row * tileW + col) * 4
                let dstPx = Self.pixel(result, width: surfaceWidth, x: 64 + col, y: 64 + row)
                let srcPx = tilePixels.subdata(in: srcOffset..<(srcOffset + 4))
                #expect(dstPx == srcPx)
            }
        }

        // Top-left region (0, 0) to (63, 63) was painted by the cacheTile command
        // (it paints AND stores), so those pixels equal tilePixels too.
        #expect(Self.pixel(result, width: surfaceWidth, x: 0, y: 0) ==
                tilePixels.subdata(in: 0..<4))

        // The bottom-left region (0, 64) is still the seed pixels.
        let seedPx = Self.pixel(seedPixels, width: surfaceWidth, x: 0, y: 64)
        #expect(Self.pixel(result, width: surfaceWidth, x: 0, y: 64) == seedPx)
    }

    // drawCachedTile for a slot that was never cached must be rejected (drives
    // the client reset path) and must not modify the surface.
    @Test func drawCachedTileForMissingSlotIsRejected() throws {
        var compositor = OwnedSurfaceCompositor()
        _ = try compositor.applyGraphicsFrame(Self.makeResetSurfaceEnvelope(
            surfaceGeneration: 1,
            frameId: 1
        ))
        let pixelsBefore = compositor.pixelBytesForDiagnostics()

        let badFrame = Self.makeDrawCachedTileEnvelope(
            surfaceGeneration: 1,
            frameId: 2,
            slot: 9,
            x: 0,
            y: 0,
            width: 64,
            height: 64
        )
        #expect(throws: SessionRejected(reason: .malformed)) {
            _ = try compositor.applyGraphicsFrame(badFrame)
        }

        // Surface must not have been modified.
        #expect(compositor.pixelBytesForDiagnostics() == pixelsBefore)
    }

    // After a surface reset, any previously stored slot must be gone; a
    // drawCachedTile of that slot must be rejected.
    @Test func resetClearsSlots() throws {
        var compositor = OwnedSurfaceCompositor()

        // Seed on generation 1.
        let tilePixels = Data(repeating: 0x55, count: 64 * 64 * 4)
        _ = try compositor.applyGraphicsFrame(Self.makeSeedSurfaceEnvelope(
            surfaceGeneration: 1,
            frameId: 1,
            width: 128,
            height: 128,
            pixels: Data(count: 128 * 128 * 4)
        ))

        // Cache a tile under slot 5.
        _ = try compositor.applyGraphicsFrame(Self.makeCacheTileEnvelope(
            surfaceGeneration: 1,
            frameId: 2,
            slot: 5,
            x: 0,
            y: 0,
            width: 64,
            height: 64,
            pixels: tilePixels
        ))

        // Reset to generation 2, wiping the slot table.
        _ = try compositor.applyGraphicsFrame(Self.makeSeedSurfaceEnvelope(
            surfaceGeneration: 2,
            frameId: 1,
            width: 128,
            height: 128,
            pixels: Data(count: 128 * 128 * 4)
        ))

        // drawCachedTile slot 5 must now be rejected.
        let badFrame = Self.makeDrawCachedTileEnvelope(
            surfaceGeneration: 2,
            frameId: 2,
            slot: 5,
            x: 0,
            y: 0,
            width: 64,
            height: 64
        )
        #expect(throws: SessionRejected(reason: .malformed)) {
            _ = try compositor.applyGraphicsFrame(badFrame)
        }
    }
}
