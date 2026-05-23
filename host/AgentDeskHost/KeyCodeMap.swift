import Carbon.HIToolbox
import CoreGraphics

// R12.1: maps the closed wire string set carried by NormalizedInput.key
// to the macOS virtual key codes Carbon defines in HIToolbox. The client
// owns the character → wire-string mapping (shift, layout, etc.); the
// host stays oblivious to keyboard layout or character semantics and
// just looks up the kVK_* constant for the given wire string.
//
// Wire strings stay stable; renaming requires an ADR (per SPEC §13.1
// domain glossary). New entries are additive and don't need an ADR.
enum KeyCodeMap {
    static func lookup(_ wireCode: String) -> CGKeyCode? {
        table[wireCode]
    }

    private static let table: [String: CGKeyCode] = [
        // Navigation / control keys exposed on the accessory row.
        "escape": CGKeyCode(kVK_Escape),
        "tab":    CGKeyCode(kVK_Tab),
        "return": CGKeyCode(kVK_Return),
        "delete": CGKeyCode(kVK_Delete),
        "space":  CGKeyCode(kVK_Space),
        "left":   CGKeyCode(kVK_LeftArrow),
        "right":  CGKeyCode(kVK_RightArrow),
        "up":     CGKeyCode(kVK_UpArrow),
        "down":   CGKeyCode(kVK_DownArrow),

        // ANSI letters (US layout). The iOS keyboard emits the unshifted
        // wire code plus .shift in modifiers when the user typed a
        // capital, so the host needs only one entry per letter.
        "ansi-A": CGKeyCode(kVK_ANSI_A),
        "ansi-B": CGKeyCode(kVK_ANSI_B),
        "ansi-C": CGKeyCode(kVK_ANSI_C),
        "ansi-D": CGKeyCode(kVK_ANSI_D),
        "ansi-E": CGKeyCode(kVK_ANSI_E),
        "ansi-F": CGKeyCode(kVK_ANSI_F),
        "ansi-G": CGKeyCode(kVK_ANSI_G),
        "ansi-H": CGKeyCode(kVK_ANSI_H),
        "ansi-I": CGKeyCode(kVK_ANSI_I),
        "ansi-J": CGKeyCode(kVK_ANSI_J),
        "ansi-K": CGKeyCode(kVK_ANSI_K),
        "ansi-L": CGKeyCode(kVK_ANSI_L),
        "ansi-M": CGKeyCode(kVK_ANSI_M),
        "ansi-N": CGKeyCode(kVK_ANSI_N),
        "ansi-O": CGKeyCode(kVK_ANSI_O),
        "ansi-P": CGKeyCode(kVK_ANSI_P),
        "ansi-Q": CGKeyCode(kVK_ANSI_Q),
        "ansi-R": CGKeyCode(kVK_ANSI_R),
        "ansi-S": CGKeyCode(kVK_ANSI_S),
        "ansi-T": CGKeyCode(kVK_ANSI_T),
        "ansi-U": CGKeyCode(kVK_ANSI_U),
        "ansi-V": CGKeyCode(kVK_ANSI_V),
        "ansi-W": CGKeyCode(kVK_ANSI_W),
        "ansi-X": CGKeyCode(kVK_ANSI_X),
        "ansi-Y": CGKeyCode(kVK_ANSI_Y),
        "ansi-Z": CGKeyCode(kVK_ANSI_Z),

        // ANSI digits. Shifted forms (!@#$%^&*()) carry .shift in the
        // modifier set and reuse the same wire codes; the host doesn't
        // care which character the user actually intended.
        "ansi-0": CGKeyCode(kVK_ANSI_0),
        "ansi-1": CGKeyCode(kVK_ANSI_1),
        "ansi-2": CGKeyCode(kVK_ANSI_2),
        "ansi-3": CGKeyCode(kVK_ANSI_3),
        "ansi-4": CGKeyCode(kVK_ANSI_4),
        "ansi-5": CGKeyCode(kVK_ANSI_5),
        "ansi-6": CGKeyCode(kVK_ANSI_6),
        "ansi-7": CGKeyCode(kVK_ANSI_7),
        "ansi-8": CGKeyCode(kVK_ANSI_8),
        "ansi-9": CGKeyCode(kVK_ANSI_9),

        // ANSI punctuation. Shift convention identical to the digit row.
        "ansi-comma":        CGKeyCode(kVK_ANSI_Comma),
        "ansi-period":       CGKeyCode(kVK_ANSI_Period),
        "ansi-slash":        CGKeyCode(kVK_ANSI_Slash),
        "ansi-semicolon":    CGKeyCode(kVK_ANSI_Semicolon),
        "ansi-quote":        CGKeyCode(kVK_ANSI_Quote),
        "ansi-leftbracket":  CGKeyCode(kVK_ANSI_LeftBracket),
        "ansi-rightbracket": CGKeyCode(kVK_ANSI_RightBracket),
        "ansi-backslash":    CGKeyCode(kVK_ANSI_Backslash),
        "ansi-minus":        CGKeyCode(kVK_ANSI_Minus),
        "ansi-equal":        CGKeyCode(kVK_ANSI_Equal),
        "ansi-grave":        CGKeyCode(kVK_ANSI_Grave)
    ]
}
