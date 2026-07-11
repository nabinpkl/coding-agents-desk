import AppKit

enum KeyboardActivation {
    static func matches(_ event: NSEvent) -> Bool {
        guard event.type == .keyDown else { return false }
        let characters = event.charactersIgnoringModifiers ?? event.characters ?? ""
        return characters == " " || characters == "\r" || characters == "\u{3}"
    }
}
