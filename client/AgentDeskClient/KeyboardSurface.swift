import UIKit

// R12.2: hidden UIKeyInput surface that turns soft-keyboard typing plus
// accessory-row modifier taps into NormalizedInput.key events. iOS owns
// the visible keyboard; this view is invisible and exists only to be a
// first responder that swallows insertText / deleteBackward and maps
// them onto the wire schema the host already understands.
//
// Modifier composition runs entirely on the client: tap a modifier on
// the accessory row to arm it, double-tap to lock, third tap to clear
// (sticky-tap state machine). When a key fires, armed + locked
// modifiers attach; armed clears, locked persists. The host never sees
// NormalizedInput.modifierArm; iOS-side composition is the locked
// choice per issue #8 and SPEC §3.

@MainActor
protocol KeyboardSurfaceDelegate: AnyObject {
    func keyboardSurface(_ surface: KeyboardSurface, didProduce input: NormalizedInput)
    func keyboardSurfaceDidChangeModifierState(_ surface: KeyboardSurface)
}

extension KeyboardSurfaceDelegate {
    func keyboardSurfaceDidChangeModifierState(_ surface: KeyboardSurface) {}
}

@MainActor
final class KeyboardSurface: UIView, UIKeyInput, UITextInputTraits {
    weak var delegate: KeyboardSurfaceDelegate?

    // MARK: UITextInputTraits
    //
    // Auto-correction, smart punctuation, and capitalisation are off so
    // a code-input field is what reaches the host. Auto-correct would
    // mutate the keystroke stream after the fact (replacing "teh" with
    // "the" silently) and break code typing. ASCII keyboard avoids the
    // numeric-row-only mode and keeps punctuation reachable.
    var autocorrectionType: UITextAutocorrectionType = .no
    var autocapitalizationType: UITextAutocapitalizationType = .none
    var smartDashesType: UITextSmartDashesType = .no
    var smartQuotesType: UITextSmartQuotesType = .no
    var smartInsertDeleteType: UITextSmartInsertDeleteType = .no
    var spellCheckingType: UITextSpellCheckingType = .no
    var keyboardType: UIKeyboardType = .asciiCapable
    var returnKeyType: UIReturnKeyType = .default

    // MARK: Modifier state
    enum ModifierState { case off, armed, locked }

    // Canonical order: cmd, ctrl, option, shift. Stable on the wire so
    // host-side decoding and tests don't have to sort.
    static let modifierOrder: [NormalizedInput.Modifier] = [.cmd, .ctrl, .option, .shift]

    private var modifierStates: [NormalizedInput.Modifier: ModifierState] = [
        .cmd: .off, .ctrl: .off, .option: .off, .shift: .off
    ]

    func state(of mod: NormalizedInput.Modifier) -> ModifierState {
        modifierStates[mod] ?? .off
    }

    // Three-state cycle off → armed → locked → off so a single tap arms
    // the next key, a double tap holds across multiple keys, and a
    // third tap clears. Matches the spec from issue #8.
    func tapModifier(_ mod: NormalizedInput.Modifier) {
        let next: ModifierState
        switch state(of: mod) {
        case .off:    next = .armed
        case .armed:  next = .locked
        case .locked: next = .off
        }
        modifierStates[mod] = next
        delegate?.keyboardSurfaceDidChangeModifierState(self)
    }

    // MARK: First-responder visibility
    override var canBecomeFirstResponder: Bool { true }

    func setVisible(_ visible: Bool) {
        if visible {
            becomeFirstResponder()
        } else {
            resignFirstResponder()
        }
    }

    // MARK: UIKeyInput
    var hasText: Bool { false }

    func insertText(_ text: String) {
        for char in text {
            emitForCharacter(char)
        }
    }

    func deleteBackward() {
        emit(code: "delete")
    }

    // MARK: Internals
    private func emitForCharacter(_ char: Character) {
        if char == "\n" {
            emit(code: "return")
            return
        }
        if char == " " {
            emit(code: "space")
            return
        }
        guard let mapping = CharacterToKey.lookup(char) else {
            // Out-of-table character: drop. The host's KeyCodeMap is the
            // matching closed set; emitting an unknown code wastes a
            // round trip and produces a host-side warning.
            return
        }
        emit(code: mapping.code, extraShift: mapping.shifted)
    }

    private func emit(code: String, extraShift: Bool = false) {
        var active: Set<NormalizedInput.Modifier> = []
        for mod in Self.modifierOrder where state(of: mod) != .off {
            active.insert(mod)
        }
        if extraShift {
            active.insert(.shift)
        }
        let ordered = Self.modifierOrder.filter { active.contains($0) }
        delegate?.keyboardSurface(self, didProduce: .key(code: code, modifiers: ordered))
        clearArmedModifiers()
    }

    private func clearArmedModifiers() {
        var didChange = false
        for mod in Self.modifierOrder where modifierStates[mod] == .armed {
            modifierStates[mod] = .off
            didChange = true
        }
        if didChange {
            delegate?.keyboardSurfaceDidChangeModifierState(self)
        }
    }
}

// MARK: - CharacterToKey

// Maps a user-visible character to the (wire code, needs .shift) pair the
// host expects. The wire codes are stable and match KeyCodeMap.swift on
// the host (per SPEC §13.1: renaming requires an ADR).
enum CharacterToKey {
    struct Mapping {
        let code: String
        let shifted: Bool
    }

    static func lookup(_ char: Character) -> Mapping? {
        table[char]
    }

    private static let table: [Character: Mapping] = {
        var map: [Character: Mapping] = [:]
        // Lowercase letters → ansi-A..ansi-Z, no shift.
        for upper in "ABCDEFGHIJKLMNOPQRSTUVWXYZ" {
            let lower = Character(upper.lowercased())
            map[lower] = Mapping(code: "ansi-\(upper)", shifted: false)
            map[Character(String(upper))] = Mapping(code: "ansi-\(upper)", shifted: true)
        }
        // Digits 0-9, no shift.
        for d in "0123456789" {
            map[d] = Mapping(code: "ansi-\(d)", shifted: false)
        }
        // Shifted digit row punctuation.
        let shiftedDigitRow: [(Character, String)] = [
            ("!", "ansi-1"), ("@", "ansi-2"), ("#", "ansi-3"), ("$", "ansi-4"),
            ("%", "ansi-5"), ("^", "ansi-6"), ("&", "ansi-7"), ("*", "ansi-8"),
            ("(", "ansi-9"), (")", "ansi-0")
        ]
        for (c, code) in shiftedDigitRow {
            map[c] = Mapping(code: code, shifted: true)
        }
        // Unshifted ANSI punctuation keys.
        let unshifted: [(Character, String)] = [
            (",", "ansi-comma"),
            (".", "ansi-period"),
            ("/", "ansi-slash"),
            (";", "ansi-semicolon"),
            ("'", "ansi-quote"),
            ("[", "ansi-leftbracket"),
            ("]", "ansi-rightbracket"),
            ("\\", "ansi-backslash"),
            ("-", "ansi-minus"),
            ("=", "ansi-equal"),
            ("`", "ansi-grave")
        ]
        for (c, code) in unshifted {
            map[c] = Mapping(code: code, shifted: false)
        }
        // Shifted form of the same punctuation keys.
        let shifted: [(Character, String)] = [
            ("<", "ansi-comma"),
            (">", "ansi-period"),
            ("?", "ansi-slash"),
            (":", "ansi-semicolon"),
            ("\"", "ansi-quote"),
            ("{", "ansi-leftbracket"),
            ("}", "ansi-rightbracket"),
            ("|", "ansi-backslash"),
            ("_", "ansi-minus"),
            ("+", "ansi-equal"),
            ("~", "ansi-grave")
        ]
        for (c, code) in shifted {
            map[c] = Mapping(code: code, shifted: true)
        }
        return map
    }()
}
