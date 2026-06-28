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
    // Black-flash fix part B (ADR-0022): a drawCachedTile for a slot the client does
    // not hold is non-fatal. It is skipped (pixels left as-is), not rejected, so a
    // cache gap from a dropped frame no longer forces a black-flashing reset; the
    // next periodic heal repaints the surface.
    @Test func drawCachedTileForMissingSlotIsSkipped() throws {
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
        // Must not throw; the missing slot is skipped.
        _ = try compositor.applyGraphicsFrame(badFrame)

        // Surface must not have been modified by the skipped tile.
        #expect(compositor.pixelBytesForDiagnostics() == pixelsBefore)
    }

    // After a surface reset, any previously stored slot is gone; a drawCachedTile of
    // that slot is now skipped (non-fatal), leaving the surface untouched.
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

        let pixelsBefore = compositor.pixelBytesForDiagnostics()

        // drawCachedTile slot 5 is now skipped (the reset cleared the slot table), not
        // rejected. The surface is left untouched.
        let staleFrame = Self.makeDrawCachedTileEnvelope(
            surfaceGeneration: 2,
            frameId: 2,
            slot: 5,
            x: 0,
            y: 0,
            width: 64,
            height: 64
        )
        _ = try compositor.applyGraphicsFrame(staleFrame)
        #expect(compositor.pixelBytesForDiagnostics() == pixelsBefore)
    }

    // The repair path: a drawCachedTile for a missing slot is skipped (surface
    // unchanged), and a later frame that re-sends the content as cacheTile then
    // drawCachedTile paints it correctly. This is what the periodic heal does.
    @Test func missingSlotThenResendRepaints() throws {
        let w = 128, h = 128
        var compositor = OwnedSurfaceCompositor()
        _ = try compositor.applyGraphicsFrame(Self.makeSeedSurfaceEnvelope(
            surfaceGeneration: 1, frameId: 1, width: w, height: h, pixels: Data(count: w * h * 4)
        ))

        // A drawCachedTile for slot 3 the client never received: skipped, no-op.
        let missing = Self.makeDrawCachedTileEnvelope(
            surfaceGeneration: 1, frameId: 2, slot: 3, x: 0, y: 0, width: 64, height: 64
        )
        let pixelsBefore = compositor.pixelBytesForDiagnostics()
        _ = try compositor.applyGraphicsFrame(missing)
        #expect(compositor.pixelBytesForDiagnostics() == pixelsBefore)

        // The host re-sends the content as cacheTile (slot 3), then references it.
        let content = Data(repeating: 0x77, count: 64 * 64 * 4)
        _ = try compositor.applyGraphicsFrame(Self.makeCacheTileEnvelope(
            surfaceGeneration: 1, frameId: 3, slot: 3, x: 0, y: 0, width: 64, height: 64, pixels: content
        ))
        let draw = Self.makeDrawCachedTileEnvelope(
            surfaceGeneration: 1, frameId: 4, slot: 3, x: 64, y: 0, width: 64, height: 64
        )
        _ = try compositor.applyGraphicsFrame(draw)

        // The tile painted at its new position (64,0).
        #expect(Self.pixel(compositor.pixelBytesForDiagnostics(), width: w, x: 96, y: 10) == Data([0x77, 0x77, 0x77, 0x77]))
    }

    // Black-flash fix part A (ADR-0022): a same-dimensions reset keeps the last-good
    // pixels visible (only the cache clears) so the surface does not flash black
    // before the reset stripes or the next heal repaint it.
    @Test func resetSameDimsKeepsPixels() throws {
        let w = 128, h = 128
        var compositor = OwnedSurfaceCompositor()
        let seedPixels = Data(repeating: 0xAB, count: w * h * 4)
        _ = try compositor.applyGraphicsFrame(Self.makeSeedSurfaceEnvelope(surfaceGeneration: 1, frameId: 1, width: w, height: h, pixels: seedPixels))
        #expect(compositor.pixelBytesForDiagnostics().allSatisfy { $0 == 0xAB })

        // A bare reset at the SAME dimensions, new generation. The pixels must remain.
        let reset = OwnedGraphicsFrameEnvelope(
            header: OwnedGraphicsFrameHeader(surfaceGeneration: 2, frameId: 2, capturedAtUptimeNs: 200, commandCount: 1, payloadLength: 0),
            commands: [.resetSurface(surfaceGeneration: 2, width: w, height: h, pixelFormat: .bgra)],
            payload: Data()
        )
        _ = try compositor.applyGraphicsFrame(reset)
        #expect(compositor.pixelBytesForDiagnostics().allSatisfy { $0 == 0xAB }, "a same-dims reset must keep the last-good pixels, not zero them")
    }

    // A genuine resize reset (different dimensions) reallocates and clears to black,
    // because the old pixels no longer fit the new surface.
    @Test func resetChangedDimsZeroesPixels() throws {
        let w = 128, h = 128
        var compositor = OwnedSurfaceCompositor()
        let seedPixels = Data(repeating: 0xAB, count: w * h * 4)
        _ = try compositor.applyGraphicsFrame(Self.makeSeedSurfaceEnvelope(surfaceGeneration: 1, frameId: 1, width: w, height: h, pixels: seedPixels))

        let reset = OwnedGraphicsFrameEnvelope(
            header: OwnedGraphicsFrameHeader(surfaceGeneration: 2, frameId: 2, capturedAtUptimeNs: 200, commandCount: 1, payloadLength: 0),
            commands: [.resetSurface(surfaceGeneration: 2, width: 64, height: 64, pixelFormat: .bgra)],
            payload: Data()
        )
        _ = try compositor.applyGraphicsFrame(reset)
        let after = compositor.pixelBytesForDiagnostics()
        #expect(after.count == 64 * 64 * 4)
        #expect(after.allSatisfy { $0 == 0 }, "a resize reset must reallocate and clear to black")
    }

}
