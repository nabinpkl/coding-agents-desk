import XCTest
@testable import PtyClientSwift

final class PtyFramingTests: XCTestCase {
    func testEncodeFrameUsesFourByteBigEndianLength() throws {
        let frame = try PtyFraming.encodeFrame(Data([0xaa, 0xbb, 0xcc]))

        XCTAssertEqual(Array(frame.prefix(4)), [0, 0, 0, 3])
        XCTAssertEqual(Array(try PtyFraming.decodeFrame(frame)), [0xaa, 0xbb, 0xcc])
    }

    func testDecodeRejectsIncompleteFrame() {
        XCTAssertThrowsError(try PtyFraming.decodeFrame(Data([0, 0, 0, 3, 0xaa])))
    }
}
