import Compression
import XCTest
@testable import AgentDeskHost

final class OwnedTileCodecTests: XCTestCase {
    func testExtractTileCopiesExactSubRect() throws {
        // 4x2 BGRA surface, stride 16. Tag each pixel's first byte with y*width + x
        // so the extracted rect's bytes are predictable.
        let w = 4, h = 2, bpr = w * 4
        var pixels = Data(count: bpr * h)
        for y in 0..<h {
            for x in 0..<w {
                pixels[y * bpr + x * 4] = UInt8(y * w + x)
            }
        }
        // Extract the 2x2 tile at (1,0): pixels (1,0)=1 (2,0)=2 (1,1)=5 (2,1)=6.
        let tile = try XCTUnwrap(OwnedTileCodec.extractTile(
            from: pixels, surfaceWidth: w, surfaceHeight: h, bytesPerRow: bpr,
            x: 1, y: 0, width: 2, height: 2
        ))
        XCTAssertEqual(tile.count, 2 * 2 * 4)
        XCTAssertEqual(tile[0], 1)
        XCTAssertEqual(tile[4], 2)
        XCTAssertEqual(tile[8], 5)
        XCTAssertEqual(tile[12], 6)
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
