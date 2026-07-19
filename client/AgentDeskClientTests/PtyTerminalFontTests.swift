import PtyTerminalSwiftTerm
import Testing

struct PtyTerminalFontTests {
    @Test func sharedTerminalRegistersBundledNerdFontOnIOS() {
        let font = PtyTerminalViewStyle.terminalFont(pointSize: 14)

        #expect(font.fontName == "JetBrainsMonoNFM-Regular")
    }
}
