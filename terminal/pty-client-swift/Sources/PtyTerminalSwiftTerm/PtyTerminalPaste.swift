import SwiftTerm

public enum PtyTerminalPaste {
    public static func bytes(for text: String, bracketed: Bool) -> [UInt8] {
        let payload = Array(text.utf8)
        guard bracketed else { return payload }
        return EscapeSequences.bracketedPasteStart + payload + EscapeSequences.bracketedPasteEnd
    }
}
