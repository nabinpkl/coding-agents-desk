import AppKit
import PtyTerminalSwiftTerm
import SwiftTerm

final class PtyManagerTerminalView: TerminalView {
    private let pasteboard: NSPasteboard

    init(frame: CGRect, font: NSFont?, pasteboard: NSPasteboard = .general) {
        self.pasteboard = pasteboard
        super.init(frame: frame, font: font)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("PtyManagerTerminalView does not support Interface Builder")
    }

    override func paste(_ sender: Any) {
        guard let text = pasteboard.string(forType: .string) else { return }
        let bytes = PtyTerminalPaste.bytes(for: text, bracketed: terminal.bracketedPasteMode)
        terminalDelegate?.send(source: self, data: bytes[...])
    }
}
