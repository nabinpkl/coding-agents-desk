import CoreText
@testable import PtyTerminalSwiftTerm
import XCTest

final class PtyTerminalFontTests: XCTestCase {
    func testBundledFontResourceIsThePinnedRegularMonoFace() {
        XCTAssertEqual(
            PtyTerminalFont.resourceURL.lastPathComponent,
            "JetBrainsMonoNerdFontMono-Regular.ttf"
        )
    }

    func testTerminalFontUsesTheBundledPostScriptName() {
        XCTAssertEqual(
            PtyTerminalViewStyle.terminalFont(pointSize: 14).fontName,
            PtyTerminalFont.postScriptName
        )
        XCTAssertEqual(PtyTerminalFont.postScriptName, "JetBrainsMonoNFM-Regular")
    }

    func testBundledFontContainsPowerlineAndNerdPromptGlyphs() throws {
        let descriptors = CTFontManagerCreateFontDescriptorsFromURL(PtyTerminalFont.resourceURL as CFURL)
            as? [CTFontDescriptor]
        let descriptor = try XCTUnwrap(descriptors?.first)
        let font = CTFontCreateWithFontDescriptor(descriptor, 14, nil)
        var characters: [UniChar] = [0xE0B0, 0xF121]
        var glyphs = [CGGlyph](repeating: 0, count: characters.count)

        XCTAssertTrue(CTFontGetGlyphsForCharacters(font, &characters, &glyphs, characters.count))
        XCTAssertFalse(glyphs.contains(0))
    }
}
