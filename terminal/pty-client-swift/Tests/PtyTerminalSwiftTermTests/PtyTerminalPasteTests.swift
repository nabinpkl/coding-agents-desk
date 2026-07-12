import PtyTerminalSwiftTerm
import SwiftTerm
import XCTest

final class PtyTerminalPasteTests: XCTestCase {
    func testPlainPasteReturnsUtf8Bytes() {
        XCTAssertEqual(
            PtyTerminalPaste.bytes(for: "hello", bracketed: false),
            Array("hello".utf8)
        )
    }

    func testBracketedPasteWrapsUtf8Bytes() {
        XCTAssertEqual(
            PtyTerminalPaste.bytes(for: "hello", bracketed: true),
            EscapeSequences.bracketedPasteStart + Array("hello".utf8) + EscapeSequences.bracketedPasteEnd
        )
    }
}
