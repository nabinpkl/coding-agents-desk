import Compression
import XCTest
@testable import AgentDeskHost

final class OwnedTileCodecTests: XCTestCase {
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


    // The fused extract+hash is the crisp path's only tile extractor, and the hash it
    // produces MUST equal TileContentCache.hash of the bytes it returns -- that equality is
    // what lets the slot cache dedup a tile it has already sent. The old cross-check used
    // OwnedTileCodec.extractTile as its reference; that function had no production caller
    // left and went with the ScrollDeltaEngine deletion, so the reference is inlined here
    // instead of keeping a shipped function alive only for its test.
    private func referenceExtract(
        from pixels: Data, bytesPerRow: Int, x: Int, y: Int, width: Int, height: Int
    ) -> Data {
        var tile = Data(capacity: width * height * 4)
        for row in 0..<height {
            let start = (y + row) * bytesPerRow + x * 4
            tile.append(pixels[start..<(start + width * 4)])
        }
        return tile
    }

    func testExtractWithHashMatchesReferenceForSeveralInputs() throws {
        // A deterministic BGRA surface where every byte is unique, so an off-by-one in the
        // row offset, the stride, or the FNV accumulation shows up as a mismatch.
        func makeSurface(w: Int, h: Int, bpr: Int? = nil) -> (pixels: Data, bpr: Int) {
            let stride = bpr ?? w * 4
            var pixels = Data(count: stride * h)
            for row in 0..<h {
                for col in 0..<(w * 4) {
                    pixels[row * stride + col] = UInt8((row * w * 4 + col) % 256)
                }
            }
            return (pixels, stride)
        }

        // (label, width, height, x, y, tileWidth, tileHeight, paddedStride)
        let cases: [(String, Int, Int, Int, Int, Int, Int, Int?)] = [
            ("full surface", 4, 3, 0, 0, 4, 3, nil),
            ("interior sub-rect", 8, 6, 2, 1, 4, 3, nil),
            ("1x1 corner pixel", 4, 4, 3, 3, 1, 1, nil),
            // Padded stride: real IOSurface layouts round bytesPerRow up past the pixel width.
            ("padded stride", 4, 2, 0, 0, 4, 2, 32),
        ]
        for (label, w, h, x, y, tw, th, padded) in cases {
            let (pixels, bpr) = makeSurface(w: w, h: h, bpr: padded)
            let expected = referenceExtract(
                from: pixels, bytesPerRow: bpr, x: x, y: y, width: tw, height: th)
            let (tile, fusedHash) = try XCTUnwrap(OwnedTileCodec.extractTileWithHash(
                from: pixels, surfaceWidth: w, surfaceHeight: h, bytesPerRow: bpr,
                x: x, y: y, width: tw, height: th))
            XCTAssertEqual(tile, expected, "extracted bytes differ on case: \(label)")
            XCTAssertEqual(TileContentCache.hash(tile), fusedHash,
                "fused hash diverges from TileContentCache.hash on case: \(label)")
        }
    }

    func testExtractWithHashRejectsOutOfBoundsOrDegenerate() {
        let pixels = Data(count: 16 * 2)
        XCTAssertNil(OwnedTileCodec.extractTileWithHash(from: pixels, surfaceWidth: 4, surfaceHeight: 2, bytesPerRow: 16, x: 3, y: 0, width: 2, height: 1))
        XCTAssertNil(OwnedTileCodec.extractTileWithHash(from: pixels, surfaceWidth: 4, surfaceHeight: 2, bytesPerRow: 16, x: 0, y: 0, width: 0, height: 1))
        XCTAssertNil(OwnedTileCodec.extractTileWithHash(from: Data(count: 4), surfaceWidth: 4, surfaceHeight: 2, bytesPerRow: 16, x: 0, y: 0, width: 1, height: 1))
    }
}
