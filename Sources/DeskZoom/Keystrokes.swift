import Carbon.HIToolbox
import CoreGraphics
import Foundation

/// A key with its modifiers, spelled the way a script says it: `return`, `cmd+a`, `cmd+shift+z`.
struct KeyChord: Equatable {
    let keyCode: CGKeyCode
    let flags: CGEventFlags

    static func parse(_ text: String) -> KeyChord? {
        let parts = text.lowercased().split(separator: "+").map(String.init)
        guard let name = parts.last, let code = Self.keyCodes[name] else { return nil }
        var flags: CGEventFlags = []
        for modifier in parts.dropLast() {
            guard let flag = Self.modifiers[modifier] else { return nil }
            flags.insert(flag)
        }
        return KeyChord(keyCode: CGKeyCode(code), flags: flags)
    }

    static let modifiers: [String: CGEventFlags] = [
        "cmd": .maskCommand, "command": .maskCommand,
        "shift": .maskShift,
        "alt": .maskAlternate, "option": .maskAlternate, "opt": .maskAlternate,
        "ctrl": .maskControl, "control": .maskControl,
    ]

    /// Virtual key codes are positions on the keyboard, not characters, so this is the US layout.
    /// Text goes through `Keystrokes.type`, which carries the characters themselves; this table is
    /// for the keys that mean an action rather than a character.
    static let keyCodes: [String: Int] = [
        "a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D, "e": kVK_ANSI_E,
        "f": kVK_ANSI_F, "g": kVK_ANSI_G, "h": kVK_ANSI_H, "i": kVK_ANSI_I, "j": kVK_ANSI_J,
        "k": kVK_ANSI_K, "l": kVK_ANSI_L, "m": kVK_ANSI_M, "n": kVK_ANSI_N, "o": kVK_ANSI_O,
        "p": kVK_ANSI_P, "q": kVK_ANSI_Q, "r": kVK_ANSI_R, "s": kVK_ANSI_S, "t": kVK_ANSI_T,
        "u": kVK_ANSI_U, "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X, "y": kVK_ANSI_Y,
        "z": kVK_ANSI_Z,
        "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3, "4": kVK_ANSI_4,
        "5": kVK_ANSI_5, "6": kVK_ANSI_6, "7": kVK_ANSI_7, "8": kVK_ANSI_8, "9": kVK_ANSI_9,
        "return": kVK_Return, "enter": kVK_Return, "tab": kVK_Tab, "space": kVK_Space,
        "delete": kVK_Delete, "backspace": kVK_Delete, "forward-delete": kVK_ForwardDelete,
        "escape": kVK_Escape, "esc": kVK_Escape,
        "up": kVK_UpArrow, "down": kVK_DownArrow, "left": kVK_LeftArrow, "right": kVK_RightArrow,
        "home": kVK_Home, "end": kVK_End, "page-up": kVK_PageUp, "page-down": kVK_PageDown,
        "period": kVK_ANSI_Period, "comma": kVK_ANSI_Comma, "minus": kVK_ANSI_Minus, "equal": kVK_ANSI_Equal,
        "slash": kVK_ANSI_Slash, "backslash": kVK_ANSI_Backslash, "semicolon": kVK_ANSI_Semicolon,
        "quote": kVK_ANSI_Quote, "grave": kVK_ANSI_Grave,
        "left-bracket": kVK_ANSI_LeftBracket, "right-bracket": kVK_ANSI_RightBracket,
        "f1": kVK_F1, "f2": kVK_F2, "f3": kVK_F3, "f4": kVK_F4, "f5": kVK_F5, "f6": kVK_F6,
        "f7": kVK_F7, "f8": kVK_F8, "f9": kVK_F9, "f10": kVK_F10, "f11": kVK_F11, "f12": kVK_F12,
    ]

}

/// Keyboard input delivered straight to a process. Posting to a pid bypasses the window server, so
/// it needs no pointer and does not activate the target, which is exactly what the fake cursor wants.
/// Mouse events sent the same way are ignored by AppKit; keyboard events are not. Measured 2026-09-04:
/// text and plain keys land in an inactive TextEdit, and command chords do not, because key equivalents
/// and menu actions go down the responder chain of the key window, which an inactive app has none of.
/// Pressing the menu item through Accessibility instead reports success and does the same nothing.
enum Keystrokes {
    /// Types text. Each character rides on its own key event as a Unicode string, so what arrives is
    /// the character itself, independent of keyboard layout. Newlines are typed as return.
    static func type(_ text: String, into pid: pid_t) {
        for character in text {
            if character.isNewline {
                press(KeyChord(keyCode: CGKeyCode(kVK_Return), flags: []), in: pid)
                continue
            }
            var units = Array(String(character).utf16)
            for down in [true, false] {
                guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down) else { continue }
                event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
                event.postToPid(pid)
            }
        }
    }

    static func press(_ chord: KeyChord, in pid: pid_t) {
        for down in [true, false] {
            guard let event = CGEvent(keyboardEventSource: nil, virtualKey: chord.keyCode, keyDown: down) else { continue }
            event.flags = chord.flags
            event.postToPid(pid)
        }
    }
}
