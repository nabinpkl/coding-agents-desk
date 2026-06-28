import Compression
import Foundation
import Testing
@testable import AgentDeskClient

// Slice 2 of the revived scroll fast path: the client applies a copyRect by
// shifting an already-painted region of its surface in place, overlap-safe, so a
// scroll moves the stable band with one blit instead of re-sending its pixels.
struct OwnedSurfaceCompositorCopyRectTests {

    // A surface where every pixel of row r carries the byte value r in all four
    // channels. After a shift, a torn copy (wrong row order under overlap) smears one
    // source row across the destination band, which these row values detect.
    private static func rowStampedPixels(width: Int, height: Int) -> Data {
        var data = Data(count: width * height * 4)
        for y in 0..<height {
            let value = UInt8(y & 0xff)
            for x in 0..<(width * 4) {
                data[y * width * 4 + x] = value
            }
        }
        return data
    }

    // Seed a surface (reset + full-surface bitmapTile) with the given pixels.
    private static func makeSeedEnvelope(width: Int, height: Int, pixels: Data) throws -> OwnedGraphicsFrameEnvelope {
        let payload = try compressLZFSE(pixels)
        return OwnedGraphicsFrameEnvelope(
            header: OwnedGraphicsFrameHeader(
                surfaceGeneration: 1,
                frameId: 1,
                capturedAtUptimeNs: 100,
                commandCount: 2,
                payloadLength: payload.count
            ),
            commands: [
                .resetSurface(surfaceGeneration: 1, width: width, height: height, pixelFormat: .bgra),
                .bitmapTile(x: 0, y: 0, width: width, height: height, compression: .lzfse, byteRange: OwnedGraphicsByteRange(offset: 0, length: payload.count))
            ],
            payload: payload
        )
    }

    private static func makeCopyRectEnvelope(
        frameId: UInt64,
        srcX: Int, srcY: Int, dstX: Int, dstY: Int, width: Int, height: Int
    ) -> OwnedGraphicsFrameEnvelope {
        OwnedGraphicsFrameEnvelope(
            header: OwnedGraphicsFrameHeader(
                surfaceGeneration: 1,
                frameId: frameId,
                capturedAtUptimeNs: frameId * 100,
                commandCount: 1,
                payloadLength: 0
            ),
            commands: [
                .copyRect(srcX: srcX, srcY: srcY, dstX: dstX, dstY: dstY, width: width, height: height)
            ],
            payload: Data()
        )
    }

    private static func rowValue(_ pixels: Data, width: Int, x: Int, y: Int) -> UInt8 {
        pixels[y * width * 4 + x * 4]
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

    // A sub-width shift down (width < surface width, so the row-by-row path runs).
    // dstY > srcY, so the copy must run bottom-up; the destination band ends up
    // holding the original source rows, not a smear of the topmost row.
    @Test func subWidthShiftDownIsNotTorn() throws {
        let width = 8, height = 8
        var compositor = OwnedSurfaceCompositor()
        _ = try compositor.applyGraphicsFrame(try Self.makeSeedEnvelope(width: width, height: height, pixels: Self.rowStampedPixels(width: width, height: height)))

        // Move rows 0..5 (cols 0..3) down by 2 to rows 2..7.
        _ = try compositor.applyGraphicsFrame(Self.makeCopyRectEnvelope(frameId: 2, srcX: 0, srcY: 0, dstX: 0, dstY: 2, width: 4, height: 6))
        let out = compositor.pixelBytesForDiagnostics()

        // Destination column 0 now holds the original source rows (0..5 -> 2..7).
        for srcRow in 0..<6 {
            #expect(Self.rowValue(out, width: width, x: 0, y: srcRow + 2) == UInt8(srcRow))
        }
        // The untouched right half (col 4) still carries its own row stamp.
        for y in 0..<height {
            #expect(Self.rowValue(out, width: width, x: 4, y: y) == UInt8(y))
        }
    }

    // A sub-width shift up. dstY < srcY, so the copy must run top-down; the
    // destination band holds the original source rows, not a smear of the bottom row.
    @Test func subWidthShiftUpIsNotTorn() throws {
        let width = 8, height = 8
        var compositor = OwnedSurfaceCompositor()
        _ = try compositor.applyGraphicsFrame(try Self.makeSeedEnvelope(width: width, height: height, pixels: Self.rowStampedPixels(width: width, height: height)))

        // Move rows 2..7 (cols 0..3) up by 2 to rows 0..5.
        _ = try compositor.applyGraphicsFrame(Self.makeCopyRectEnvelope(frameId: 2, srcX: 0, srcY: 2, dstX: 0, dstY: 0, width: 4, height: 6))
        let out = compositor.pixelBytesForDiagnostics()

        for srcRow in 2..<8 {
            #expect(Self.rowValue(out, width: width, x: 0, y: srcRow - 2) == UInt8(srcRow))
        }
    }

    // A full-width shift goes through the single-memmove fast path. It must produce
    // the same result a correct row-by-row shift would: the whole band moves intact.
    @Test func fullWidthShiftUsesFastPathCorrectly() throws {
        let width = 8, height = 8
        var compositor = OwnedSurfaceCompositor()
        _ = try compositor.applyGraphicsFrame(try Self.makeSeedEnvelope(width: width, height: height, pixels: Self.rowStampedPixels(width: width, height: height)))

        // Full-width move of rows 0..5 down by 2.
        _ = try compositor.applyGraphicsFrame(Self.makeCopyRectEnvelope(frameId: 2, srcX: 0, srcY: 0, dstX: 0, dstY: 2, width: width, height: 6))
        let out = compositor.pixelBytesForDiagnostics()

        for srcRow in 0..<6 {
            for x in 0..<width {
                #expect(Self.rowValue(out, width: width, x: x, y: srcRow + 2) == UInt8(srcRow))
            }
        }
    }

    // A destination rect that runs off the surface is malformed and rejected before
    // any pixels move.
    @Test func outOfBoundsDestinationIsRejected() throws {
        let width = 8, height = 8
        var compositor = OwnedSurfaceCompositor()
        _ = try compositor.applyGraphicsFrame(try Self.makeSeedEnvelope(width: width, height: height, pixels: Self.rowStampedPixels(width: width, height: height)))

        let bad = Self.makeCopyRectEnvelope(frameId: 2, srcX: 0, srcY: 0, dstX: 0, dstY: 4, width: 8, height: 6)
        #expect(throws: SessionRejected(reason: .malformed)) {
            _ = try compositor.applyGraphicsFrame(bad)
        }
    }
}
