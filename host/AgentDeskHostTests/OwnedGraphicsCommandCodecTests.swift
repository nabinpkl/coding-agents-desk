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

    func testRevertTileToVideoRoundTrips() throws {
        let c = OwnedGraphicsCommand.revertTileToVideo(x: 128, y: 256, width: 64, height: 64)
        XCTAssertEqual(try roundTrip(c), c)
        try c.validateForCurrentScope()
    }

    func testRevertTileToVideoRejectsNonPositiveExtent() {
        let bad = OwnedGraphicsCommand.revertTileToVideo(x: 0, y: 0, width: 0, height: 64)
        XCTAssertThrowsError(try bad.validateForCurrentScope())
    }

}
