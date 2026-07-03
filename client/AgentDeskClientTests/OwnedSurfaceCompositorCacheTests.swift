import Compression
import Foundation
import Testing
import AgentDeskWire
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

    // drawCachedTile for a slot the client never cached is non-fatal: it must not throw
    // or force a reset. Per ADR-0034 the cache-miss reverts its region to the live video
    // floor (transparent) rather than leaving stale pixels. Over the already-transparent
    // baseline here that revert is a no-op, so the surface is unchanged.
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

        // The revert is a no-op over the transparent baseline, so the surface is unchanged.
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

    // The repair path: a drawCachedTile for a missing slot reverts its region to video
    // (a no-op over the transparent baseline here), and a later frame that re-sends the
    // content as cacheTile then drawCachedTile paints it correctly.
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

    // ADR-0034: revertTileToVideo must zero its region to transparent (the live video
    // floor shows through there) while leaving the rest of the surface untouched.
    @Test func revertTileToVideoClearsRegionToTransparent() throws {
        let w = 128, h = 128
        var compositor = OwnedSurfaceCompositor()
        let seedPixels = Data(repeating: 0xAB, count: w * h * 4)
        _ = try compositor.applyGraphicsFrame(Self.makeSeedSurfaceEnvelope(surfaceGeneration: 1, frameId: 1, width: w, height: h, pixels: seedPixels))

        let revert = OwnedGraphicsFrameEnvelope(
            header: OwnedGraphicsFrameHeader(surfaceGeneration: 1, frameId: 2, capturedAtUptimeNs: 200, commandCount: 1, payloadLength: 0),
            commands: [.revertTileToVideo(x: 0, y: 0, width: 64, height: 64)],
            payload: Data()
        )
        _ = try compositor.applyGraphicsFrame(revert)

        let after = compositor.pixelBytesForDiagnostics()
        let bytesPerRow = w * 4
        // First pixel inside the reverted 64x64 region is transparent (all zero).
        #expect(after[0] == 0 && after[1] == 0 && after[2] == 0 && after[3] == 0, "reverted region must be cleared to transparent")
        // Last pixel inside the region (row 63, col 63) catches a height/width off-by-one.
        let lastInside = 63 * bytesPerRow + 63 * 4
        #expect(after[lastInside] == 0 && after[lastInside + 3] == 0, "the full reverted region must be cleared, including its last pixel")
        // First column just past the region's right edge (row 0, col 64) must be untouched.
        let rightEdge = 0 * bytesPerRow + 64 * 4
        #expect(after[rightEdge] == 0xAB, "the x-boundary of the cleared region must be exact")
        // First row just past the region's bottom edge (row 64, col 0) must be untouched.
        let bottomEdge = 64 * bytesPerRow + 0 * 4
        #expect(after[bottomEdge] == 0xAB, "the y-boundary of the cleared region must be exact")
        // A pixel far outside the reverted region keeps its seed value.
        let outside = 100 * bytesPerRow + 100 * 4
        #expect(after[outside] == 0xAB, "pixels outside the reverted region must be untouched")
    }

    // ADR-0034 crisp-repair: a drawCachedTile for a slot the client never received (its
    // cacheTile was dropped, e.g. before the sink existed) must leave the region transparent
    // over a fresh reset, so the live video floor shows through there rather than a stale or
    // black tile. Pins that the cache-miss skip stays a "show video" no-op, not a paint.
    @Test func uncachedDrawCachedTileOverFreshResetLeavesRegionTransparent() throws {
        var compositor = OwnedSurfaceCompositor()
        // Fresh reset: a new (larger) generation so the baseline is all-zero (transparent).
        _ = try compositor.applyGraphicsFrame(Self.makeResetSurfaceEnvelope(surfaceGeneration: 2, frameId: 1))
        _ = try compositor.applyGraphicsFrame(Self.makeDrawCachedTileEnvelope(
            surfaceGeneration: 2, frameId: 2, slot: 7, x: 0, y: 0, width: 64, height: 64
        ))

        let after = compositor.pixelBytesForDiagnostics()
        // A pixel inside the skipped region stays fully transparent (video shows through).
        #expect(after[0] == 0 && after[1] == 0 && after[2] == 0 && after[3] == 0,
                "an uncached drawCachedTile must leave its region transparent, not stale or black")
    }

    // ADR-0034 crisp-repair (host/client slot divergence): a drawCachedTile for a slot the
    // client no longer holds must clear its region to the live video floor EVEN when that
    // region currently shows a crisp tile, so prior-desktop content can never persist. Pins
    // the fix for stale rects on a desktop switch: the cache-miss reverts, never leaves stale.
    @Test func uncachedDrawCachedTileOverCrispClearsToVideo() throws {
        let w = 128, h = 128
        var compositor = OwnedSurfaceCompositor()
        _ = try compositor.applyGraphicsFrame(Self.makeSeedSurfaceEnvelope(
            surfaceGeneration: 1, frameId: 1, width: w, height: h, pixels: Data(count: w * h * 4)
        ))
        // Paint a crisp tile at (0,0): slot 3 cached with opaque content.
        let crisp = Data(repeating: 0x99, count: 64 * 64 * 4)
        _ = try compositor.applyGraphicsFrame(Self.makeCacheTileEnvelope(
            surfaceGeneration: 1, frameId: 2, slot: 3, x: 0, y: 0, width: 64, height: 64, pixels: crisp
        ))
        #expect(Self.pixel(compositor.pixelBytesForDiagnostics(), width: w, x: 10, y: 10) == Data([0x99, 0x99, 0x99, 0x99]),
                "precondition: the region shows the crisp tile")

        // A drawCachedTile for an uncached slot (8) over the same region: the client does not
        // hold slot 8, so it must clear to transparent (show video), not keep the stale crisp.
        _ = try compositor.applyGraphicsFrame(Self.makeDrawCachedTileEnvelope(
            surfaceGeneration: 1, frameId: 3, slot: 8, x: 0, y: 0, width: 64, height: 64
        ))
        let after = compositor.pixelBytesForDiagnostics()
        #expect(after[0] == 0 && after[1] == 0 && after[2] == 0 && after[3] == 0,
                "an uncached drawCachedTile over a crisp region must clear to video, not keep the stale tile")
        #expect(Self.pixel(after, width: w, x: 10, y: 10) == Data([0, 0, 0, 0]),
                "the full stale-crisp region must be cleared to transparent")
    }

    // ADR-0034 R2: the revertTileToVideo command must survive a JSON round-trip on the
    // shared OwnedGraphicsCommand (AgentDeskWire) round-trips identically, so host and
    // client cannot drift on this wire shape.
    @Test func revertTileToVideoRoundTrips() throws {
        let command = OwnedGraphicsCommand.revertTileToVideo(x: 128, y: 256, width: 64, height: 64)
        let data = try JSONEncoder().encode(command)
        let decoded = try JSONDecoder().decode(OwnedGraphicsCommand.self, from: data)
        #expect(decoded == command)
        try command.validateForCurrentScope()
    }

}
