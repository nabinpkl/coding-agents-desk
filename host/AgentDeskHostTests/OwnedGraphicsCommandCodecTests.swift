import XCTest
@testable import AgentDeskHost

final class OwnedGraphicsCommandCodecTests: XCTestCase {
    private func roundTrip(_ command: OwnedGraphicsCommand) throws -> OwnedGraphicsCommand {
        let data = try JSONEncoder().encode(command)
        return try JSONDecoder().decode(OwnedGraphicsCommand.self, from: data)
    }

    func testCacheTileRoundTrips() throws {
        let c = OwnedGraphicsCommand.cacheTile(slot: 7, x: 64, y: 128, width: 64, height: 64, compression: .lzfse, byteRange: OwnedGraphicsByteRange(offset: 0, length: 42))
        XCTAssertEqual(try roundTrip(c), c)
        try c.validateForCurrentScope(payloadLength: 42)
    }

    func testDrawCachedTileRoundTrips() throws {
        let c = OwnedGraphicsCommand.drawCachedTile(slot: 7, x: 64, y: 128, width: 64, height: 64)
        XCTAssertEqual(try roundTrip(c), c)
        try c.validateForCurrentScope()
    }

    func testCopyRectRoundTrips() throws {
        let c = OwnedGraphicsCommand.copyRect(srcX: 0, srcY: 64, dstX: 0, dstY: 0, width: 1170, height: 2000)
        XCTAssertEqual(try roundTrip(c), c)
        try c.validateForCurrentScope()
    }

    // The wire shape is the stable contract the client decodes. Pin the JSON keys
    // (sx/sy/dx/dy/w/h, kind=copyRect) so a host encode and a client decode agree.
    func testCopyRectEncodesStableWireKeys() throws {
        let c = OwnedGraphicsCommand.copyRect(srcX: 5, srcY: 64, dstX: 5, dstY: 0, width: 800, height: 600)
        let json = try JSONSerialization.jsonObject(with: try JSONEncoder().encode(c)) as? [String: Any]
        XCTAssertEqual(json?["k"] as? String, "copyRect")
        XCTAssertEqual(json?["sx"] as? Int, 5)
        XCTAssertEqual(json?["sy"] as? Int, 64)
        XCTAssertEqual(json?["dx"] as? Int, 5)
        XCTAssertEqual(json?["dy"] as? Int, 0)
        XCTAssertEqual(json?["w"] as? Int, 800)
        XCTAssertEqual(json?["h"] as? Int, 600)
    }

    func testCopyRectRejectsNegativeCoordinate() throws {
        let c = OwnedGraphicsCommand.copyRect(srcX: 0, srcY: -1, dstX: 0, dstY: 0, width: 100, height: 100)
        XCTAssertThrowsError(try c.validateForCurrentScope()) { error in
            XCTAssertEqual((error as? SessionRejected)?.reason, .malformed)
        }
    }

    func testCopyRectRejectsNonPositiveExtent() throws {
        let c = OwnedGraphicsCommand.copyRect(srcX: 0, srcY: 0, dstX: 0, dstY: 0, width: 100, height: 0)
        XCTAssertThrowsError(try c.validateForCurrentScope()) { error in
            XCTAssertEqual((error as? SessionRejected)?.reason, .malformed)
        }
    }
}
