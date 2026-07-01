import Compression
import XCTest
@testable import AgentDeskHost

final class OwnedTileCodecTests: XCTestCase {
    func testExtractTileCopiesExactSubRect() throws {
        // 4x2 BGRA surface, stride 16. Tag every channel of every pixel uniquely:
        // pixel (x,y) channel c gets ((y*w + x) * 4 + c), so a channel-stride or
        // row-offset bug is caught, not just the first byte of each pixel.
        let w = 4, h = 2, bpr = w * 4
        var pixels = Data(count: bpr * h)
        for y in 0..<h {
            for x in 0..<w {
                let base = (y * w + x) * 4
                for c in 0..<4 {
                    pixels[y * bpr + x * 4 + c] = UInt8(base + c)
                }
            }
        }
        // Extract the 2x2 tile at (1,0): source pixels (1,0)=idx1 (2,0)=idx2 (1,1)=idx5 (2,1)=idx6.
        let tile = try XCTUnwrap(OwnedTileCodec.extractTile(
            from: pixels, surfaceWidth: w, surfaceHeight: h, bytesPerRow: bpr,
            x: 1, y: 0, width: 2, height: 2
        ))
        XCTAssertEqual(tile.count, 2 * 2 * 4)
        // Full BGRA channels of each tile pixel, in tile row-major order.
        XCTAssertEqual(Array(tile), [4, 5, 6, 7, 8, 9, 10, 11, 20, 21, 22, 23, 24, 25, 26, 27])
    }

    func testExtractTileRejectsOutOfBoundsOrDegenerate() {
        let pixels = Data(count: 16 * 2)
        XCTAssertNil(OwnedTileCodec.extractTile(from: pixels, surfaceWidth: 4, surfaceHeight: 2, bytesPerRow: 16, x: 3, y: 0, width: 2, height: 1))
        XCTAssertNil(OwnedTileCodec.extractTile(from: pixels, surfaceWidth: 4, surfaceHeight: 2, bytesPerRow: 16, x: 0, y: 0, width: 0, height: 1))
        XCTAssertNil(OwnedTileCodec.extractTile(from: Data(count: 4), surfaceWidth: 4, surfaceHeight: 2, bytesPerRow: 16, x: 0, y: 0, width: 1, height: 1))
    }

    func testCompressLZFSERoundTripsLossless() throws {
        let original = Data((0..<4096).map { UInt8($0 % 251) })
        let compressed = try XCTUnwrap(OwnedTileCodec.compressLZFSE(original))
        XCTAssertGreaterThan(compressed.count, 0)
        var decoded = Data(count: original.count)
        let decodedCount = decoded.withUnsafeMutableBytes { dst in
            compressed.withUnsafeBytes { src in
                compression_decode_buffer(
                    dst.bindMemory(to: UInt8.self).baseAddress!, original.count,
                    src.bindMemory(to: UInt8.self).baseAddress!, compressed.count,
                    nil, COMPRESSION_LZFSE
                )
            }
        }
        XCTAssertEqual(decodedCount, original.count)
        XCTAssertEqual(decoded, original)
    }

    func testCompressLZFSERejectsEmpty() {
        XCTAssertNil(OwnedTileCodec.compressLZFSE(Data()))
    }

    // INVARIANT: extractTileWithHash must produce a hash bit-identical to the
    // two-step path extractTile + TileContentCache.hash. Several input shapes are
    // tested so an off-by-one in the row offset, stride, or FNV accumulation is
    // caught before it silently diverges the cache-dedup path.
    func testExtractWithHashMatchesTwoStepForSeveralInputs() throws {
        // Helper: build a deterministic BGRA surface where every byte is unique.
        func makeSurface(w: Int, h: Int) -> (pixels: Data, bpr: Int) {
            let bpr = w * 4
            var pixels = Data(count: bpr * h)
            for row in 0..<h {
                for col in 0..<(w * 4) {
                    pixels[row * bpr + col] = UInt8((row * w * 4 + col) % 256)
                }
            }
            return (pixels, bpr)
        }

        // Case 1: full-surface tile (stride == width).
        let (pixels1, bpr1) = makeSurface(w: 4, h: 3)
        let tileA = try XCTUnwrap(OwnedTileCodec.extractTile(
            from: pixels1, surfaceWidth: 4, surfaceHeight: 3, bytesPerRow: bpr1,
            x: 0, y: 0, width: 4, height: 3))
        let (tileB, hashFused1) = try XCTUnwrap(OwnedTileCodec.extractTileWithHash(
            from: pixels1, surfaceWidth: 4, surfaceHeight: 3, bytesPerRow: bpr1,
            x: 0, y: 0, width: 4, height: 3))
        XCTAssertEqual(tileA, tileB)
        XCTAssertEqual(TileContentCache.hash(tileA), hashFused1,
            "fused hash diverges from two-step hash on case 1 (full surface)")

        // Case 2: sub-rect tile (stride > width, exercises row-offset path).
        let (pixels2, bpr2) = makeSurface(w: 8, h: 6)
        let tileC = try XCTUnwrap(OwnedTileCodec.extractTile(
            from: pixels2, surfaceWidth: 8, surfaceHeight: 6, bytesPerRow: bpr2,
            x: 2, y: 1, width: 4, height: 3))
        let (tileD, hashFused2) = try XCTUnwrap(OwnedTileCodec.extractTileWithHash(
            from: pixels2, surfaceWidth: 8, surfaceHeight: 6, bytesPerRow: bpr2,
            x: 2, y: 1, width: 4, height: 3))
        XCTAssertEqual(tileC, tileD)
        XCTAssertEqual(TileContentCache.hash(tileC), hashFused2,
            "fused hash diverges from two-step hash on case 2 (interior sub-rect)")

        // Case 3: 1x1 single-pixel tile.
        let (pixels3, bpr3) = makeSurface(w: 4, h: 4)
        let tileE = try XCTUnwrap(OwnedTileCodec.extractTile(
            from: pixels3, surfaceWidth: 4, surfaceHeight: 4, bytesPerRow: bpr3,
            x: 3, y: 3, width: 1, height: 1))
        let (tileF, hashFused3) = try XCTUnwrap(OwnedTileCodec.extractTileWithHash(
            from: pixels3, surfaceWidth: 4, surfaceHeight: 4, bytesPerRow: bpr3,
            x: 3, y: 3, width: 1, height: 1))
        XCTAssertEqual(tileE, tileF)
        XCTAssertEqual(TileContentCache.hash(tileE), hashFused3,
            "fused hash diverges from two-step hash on case 3 (1x1 corner pixel)")

        // Case 4: wider stride than pixel width (simulates real IOSurface layout where
        // bytesPerRow is rounded up to a cache-line multiple).
        let w4 = 4, h4 = 2, bpr4 = 32  // padded stride (32 bytes, 8 pixels wide)
        var pixels4 = Data(count: bpr4 * h4)
        for row in 0..<h4 { for col in 0..<(w4 * 4) { pixels4[row * bpr4 + col] = UInt8((row * 16 + col) % 256) } }
        let tileG = try XCTUnwrap(OwnedTileCodec.extractTile(
            from: pixels4, surfaceWidth: w4, surfaceHeight: h4, bytesPerRow: bpr4,
            x: 0, y: 0, width: w4, height: h4))
        let (tileH, hashFused4) = try XCTUnwrap(OwnedTileCodec.extractTileWithHash(
            from: pixels4, surfaceWidth: w4, surfaceHeight: h4, bytesPerRow: bpr4,
            x: 0, y: 0, width: w4, height: h4))
        XCTAssertEqual(tileG, tileH)
        XCTAssertEqual(TileContentCache.hash(tileG), hashFused4,
            "fused hash diverges from two-step hash on case 4 (padded stride)")
    }

    func testExtractWithHashRejectsOutOfBoundsOrDegenerate() {
        let pixels = Data(count: 16 * 2)
        XCTAssertNil(OwnedTileCodec.extractTileWithHash(from: pixels, surfaceWidth: 4, surfaceHeight: 2, bytesPerRow: 16, x: 3, y: 0, width: 2, height: 1))
        XCTAssertNil(OwnedTileCodec.extractTileWithHash(from: pixels, surfaceWidth: 4, surfaceHeight: 2, bytesPerRow: 16, x: 0, y: 0, width: 0, height: 1))
        XCTAssertNil(OwnedTileCodec.extractTileWithHash(from: Data(count: 4), surfaceWidth: 4, surfaceHeight: 2, bytesPerRow: 16, x: 0, y: 0, width: 1, height: 1))
    }
}
