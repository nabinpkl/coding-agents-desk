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
}

// Subclasses UITextField (instead of being a bare UIView + UIKeyInput)
// because the iOS soft keyboard renders with non-standard letter pitch
// and key height when the first responder is a custom UIView: the system
// falls back to a wider layout it uses for free-form text input
// surfaces. UITextField is the shape iOS recognises, so the standard
// iPhone QWERTY layout drops in unchanged.
//
// Text storage is suppressed (insertText and deleteBackward don't call
// super) so no characters accumulate; the field stays visually empty.
// isHidden = true on the instance keeps the cursor and selection handles
// off-screen.
@MainActor
final class KeyboardSurface: UITextField {
    // Named keyboardDelegate to avoid colliding with UITextField.delegate
    // (which is UITextFieldDelegate).
    weak var keyboardDelegate: KeyboardSurfaceDelegate?

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
        accessoryView?.refreshModifierStates()
    }

    // MARK: Lifecycle
    override init(frame: CGRect) {
        super.init(frame: frame)
        configureTraits()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

    convenience init() {
        self.init(frame: .zero)
    }

    private func configureTraits() {
        // Auto-correction, smart punctuation, and capitalisation are off
        // so a code-input field is what reaches the host. Auto-correct
        // would silently mutate the keystroke stream and break code
        // typing.
        autocorrectionType = .no
        autocapitalizationType = .none
        smartDashesType = .no
        smartQuotesType = .no
        smartInsertDeleteType = .no
        spellCheckingType = .no
        keyboardType = .asciiCapable
        returnKeyType = .default
        // Visually invisible even if the parent forgets to hide us.
        // The field's text never grows because insertText doesn't call
        // super, so this clear-text styling is belt-and-suspenders.
        textColor = .clear
        tintColor = .clear
        backgroundColor = .clear
        borderStyle = .none
    }

    // MARK: First-responder visibility
    func setVisible(_ visible: Bool) {
        if visible {
            becomeFirstResponder()
        } else {
            resignFirstResponder()
        }
    }

    // MARK: Accessory row
    // Lazy so test code that never summons the keyboard doesn't
    // instantiate a UIView in the test process. Created on first
    // becomeFirstResponder and assigned to UITextField.inputAccessoryView
    // (settable, so we can't shadow it with a getter-only override).
    private var accessoryView: KeyboardAccessoryView?

    override func becomeFirstResponder() -> Bool {
        if accessoryView == nil {
            let bar = KeyboardAccessoryView(surface: self)
            accessoryView = bar
            inputAccessoryView = bar
        }
        return super.becomeFirstResponder()
    }

    // Public alias so the accessory row's Esc / Tab / arrow / Cmd / Ctrl /
    // Option buttons can route through the same emit path letters use.
    // Routes through emit() so current armed modifiers attach and clear
    // automatically.
    func sendKey(code: String) {
        emit(code: code)
    }

    // MARK: UIKeyInput overrides
    //
    // UITextField conforms to UIKeyInput; we override insertText and
    // deleteBackward to intercept input and forward to the wire. Not
    // calling super means the field's own text storage never grows, so
    // the field stays empty and no cursor / selection UI is needed.
    override func insertText(_ text: String) {
        for char in text {
            emitForCharacter(char)
        }
    }

    override func deleteBackward() {
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
        keyboardDelegate?.keyboardSurface(self, didProduce: .key(code: code, modifiers: ordered))
        clearArmedModifiers()
    }

    private func clearArmedModifiers() {
        var didChange = false
        for mod in Self.modifierOrder where modifierStates[mod] == .armed {
            modifierStates[mod] = .off
            didChange = true
        }
        if didChange {
            accessoryView?.refreshModifierStates()
        }
    }
}

// MARK: - KeyboardAccessoryView

// Sits above the iOS soft keyboard and gives the user the keys that the
// soft keyboard doesn't expose: Esc, Tab, the arrow cluster, and the
// sticky-tap modifiers (Cmd, Ctrl, Option). Shift comes from the soft
// keyboard's own shift behaviour (character case), so it's not on the
// accessory row.
@MainActor
final class KeyboardAccessoryView: UIInputView {
    private weak var surface: KeyboardSurface?
    private var modifierButtons: [NormalizedInput.Modifier: UIButton] = [:]

    init(surface: KeyboardSurface) {
        self.surface = surface
        // inputAccessoryView is rendered above the iOS soft keyboard
        // and its frame width feeds back into the keyboard's own layout
        // calculation. A zero-width initial frame (or autoresizing mask
        // missing .flexibleWidth) causes iOS to compute letter pitch
        // against the wrong container width, which is what made the
        // alphabetic keys look abnormally spaced. Seed with screen
        // width and flexibleWidth so the bar tracks orientation /
        // device width naturally.
        let initialWidth = UIScreen.main.bounds.width
        super.init(
            frame: CGRect(x: 0, y: 0, width: initialWidth, height: 48),
            inputViewStyle: .keyboard
        )
        autoresizingMask = [.flexibleWidth, .flexibleHeight]
        // translatesAutoresizingMaskIntoConstraints stays true (the
        // default) so iOS sizes the bar via frame + autoresizing.
        backgroundColor = .secondarySystemBackground
        setupViews()
        refreshModifierStates()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) not used") }

    private func setupViews() {
        let escape = makeKeyButton(title: "Esc", code: "escape")
        let tab = makeKeyButton(title: "Tab", code: "tab")
        let arrowCluster = makeArrowCluster()
        let cmd = makeModifierButton(title: "Cmd", mod: .cmd)
        let ctrl = makeModifierButton(title: "Ctrl", mod: .ctrl)
        let option = makeModifierButton(title: "Opt", mod: .option)

        let stack = UIStackView(arrangedSubviews: [escape, tab, arrowCluster, cmd, ctrl, option])
        stack.axis = .horizontal
        stack.spacing = 6
        stack.distribution = .fillEqually
        stack.alignment = .fill
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 6),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 6),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -6)
        ])
    }

    private func makeKeyButton(title: String, code: String) -> UIButton {
        let button = UIButton(type: .system)
        button.setTitle(title, for: .normal)
        button.backgroundColor = .tertiarySystemBackground
        button.tintColor = .label
        button.layer.cornerRadius = 6
        button.titleLabel?.font = .preferredFont(forTextStyle: .footnote)
        button.addAction(UIAction { [weak self] _ in
            self?.surface?.sendKey(code: code)
        }, for: .touchUpInside)
        return button
    }

    // 2x2 cluster of arrow buttons in a single accessory slot to save the
    // horizontal real estate three side-by-side arrows would consume.
    private func makeArrowCluster() -> UIView {
        let row1 = UIStackView(arrangedSubviews: [
            spacerButton(),
            makeKeyButton(title: "↑", code: "up"),
            spacerButton()
        ])
        let row2 = UIStackView(arrangedSubviews: [
            makeKeyButton(title: "←", code: "left"),
            makeKeyButton(title: "↓", code: "down"),
            makeKeyButton(title: "→", code: "right")
        ])
        [row1, row2].forEach {
            $0.axis = .horizontal
            $0.distribution = .fillEqually
            $0.spacing = 2
        }
        let column = UIStackView(arrangedSubviews: [row1, row2])
        column.axis = .vertical
        column.distribution = .fillEqually
        column.spacing = 2
        return column
    }

    private func spacerButton() -> UIView {
        let view = UIView()
        view.backgroundColor = .clear
        return view
    }

    private func makeModifierButton(title: String, mod: NormalizedInput.Modifier) -> UIButton {
        let button = UIButton(type: .system)
        button.setTitle(title, for: .normal)
        button.layer.cornerRadius = 6
        button.titleLabel?.font = .preferredFont(forTextStyle: .footnote)
        button.addAction(UIAction { [weak self] _ in
            self?.surface?.tapModifier(mod)
        }, for: .touchUpInside)
        modifierButtons[mod] = button
        return button
    }

    func refreshModifierStates() {
        guard let surface else { return }
        for (mod, button) in modifierButtons {
            switch surface.state(of: mod) {
            case .off:
                button.backgroundColor = .tertiarySystemBackground
                button.tintColor = .label
                button.layer.borderWidth = 0
            case .armed:
                button.backgroundColor = .tintColor.withAlphaComponent(0.30)
                button.tintColor = .label
                button.layer.borderWidth = 0
            case .locked:
                button.backgroundColor = .tintColor
                button.tintColor = .systemBackground
                button.layer.borderColor = UIColor.label.cgColor
                button.layer.borderWidth = 1
            }
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
