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
}
