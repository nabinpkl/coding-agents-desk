import Foundation
import Testing
import UIKit
import AgentDeskWire

@MainActor
struct KeyboardSurfaceTests {
    @Test func unmodifiedLowercaseLetterEmitsAnsiCodeWithNoModifiers() {
        let surface = KeyboardSurface()
        let recorder = Recorder()
        surface.keyboardDelegate = recorder

        _ = surface.textField(surface, shouldChangeCharactersIn: NSRange(), replacementString: "s")

        #expect(recorder.events.count == 1)
        #expect(recorder.events[0] == .key(code: "ansi-S", modifiers: []))
    }

    @Test func uppercaseLetterEmitsAnsiCodeWithShift() {
        let surface = KeyboardSurface()
        let recorder = Recorder()
        surface.keyboardDelegate = recorder

        _ = surface.textField(surface, shouldChangeCharactersIn: NSRange(), replacementString: "S")

        #expect(recorder.events.count == 1)
        #expect(recorder.events[0] == .key(code: "ansi-S", modifiers: [.shift]))
    }

    @Test func shiftedDigitRowPunctuationEmitsDigitCodeWithShift() {
        let surface = KeyboardSurface()
        let recorder = Recorder()
        surface.keyboardDelegate = recorder

        _ = surface.textField(surface, shouldChangeCharactersIn: NSRange(), replacementString: "!")

        #expect(recorder.events.count == 1)
        #expect(recorder.events[0] == .key(code: "ansi-1", modifiers: [.shift]))
    }

    @Test func unshiftedPunctuationEmitsAnsiCodeWithNoModifiers() {
        let surface = KeyboardSurface()
        let recorder = Recorder()
        surface.keyboardDelegate = recorder

        _ = surface.textField(surface, shouldChangeCharactersIn: NSRange(), replacementString: ",")

        #expect(recorder.events.count == 1)
        #expect(recorder.events[0] == .key(code: "ansi-comma", modifiers: []))
    }

    @Test func returnKeyEmitsReturnCode() {
        let surface = KeyboardSurface()
        let recorder = Recorder()
        surface.keyboardDelegate = recorder

        _ = surface.textField(surface, shouldChangeCharactersIn: NSRange(), replacementString: "\n")

        #expect(recorder.events.count == 1)
        #expect(recorder.events[0] == .key(code: "return", modifiers: []))
    }

    @Test func deleteBackwardEmitsDeleteCode() {
        let surface = KeyboardSurface()
        let recorder = Recorder()
        surface.keyboardDelegate = recorder

        surface.deleteBackward()

        #expect(recorder.events.count == 1)
        #expect(recorder.events[0] == .key(code: "delete", modifiers: []))
    }

    @Test func deleteBackwardEmitsOnEmptyField() {
        // Regression: backspace must reach the host even when nothing has been typed (before
        // any typing, after Enter clears the echo, or once the echo is backspaced away). The
        // old delegate-only path never fired here because UITextField skips the delegate when
        // there is no text to delete.
        let surface = KeyboardSurface()
        let recorder = Recorder()
        surface.keyboardDelegate = recorder

        surface.deleteBackward()
        surface.deleteBackward()

        #expect(recorder.events.count == 2)
        #expect(recorder.events.allSatisfy { $0 == .key(code: "delete", modifiers: []) })
    }

    @Test func deleteBackwardCarriesArmedModifier() {
        // Armed Cmd + backspace = Cmd-Delete on the Mac; the armed modifier then clears.
        let surface = KeyboardSurface()
        let recorder = Recorder()
        surface.keyboardDelegate = recorder

        surface.tapModifier(.cmd)
        #expect(surface.state(of: .cmd) == .armed)

        surface.deleteBackward()
        #expect(surface.state(of: .cmd) == .off)

        surface.deleteBackward()

        #expect(recorder.events.count == 2)
        #expect(recorder.events[0] == .key(code: "delete", modifiers: [.cmd]))
        #expect(recorder.events[1] == .key(code: "delete", modifiers: []))
    }

    @Test func emptyReplacementStringNoLongerEmits() {
        // Backspace now emits solely via deleteBackward(); the delegate's empty-string path
        // must not also emit, or a single press would double-delete on the host.
        let surface = KeyboardSurface()
        let recorder = Recorder()
        surface.keyboardDelegate = recorder

        _ = surface.textField(surface, shouldChangeCharactersIn: NSRange(), replacementString: "")

        #expect(recorder.events.isEmpty)
    }

    @Test func singleTapModifierArmsForNextKeyThenClears() {
        let surface = KeyboardSurface()
        let recorder = Recorder()
        surface.keyboardDelegate = recorder

        surface.tapModifier(.cmd)
        #expect(surface.state(of: .cmd) == .armed)

        _ = surface.textField(surface, shouldChangeCharactersIn: NSRange(), replacementString: "s")
        #expect(surface.state(of: .cmd) == .off)
        _ = surface.textField(surface, shouldChangeCharactersIn: NSRange(), replacementString: "s")

        #expect(recorder.events.count == 2)
        #expect(recorder.events[0] == .key(code: "ansi-S", modifiers: [.cmd]))
        #expect(recorder.events[1] == .key(code: "ansi-S", modifiers: []))
    }

    @Test func doubleTapModifierLocksAcrossMultipleKeys() {
        let surface = KeyboardSurface()
        let recorder = Recorder()
        surface.keyboardDelegate = recorder

        surface.tapModifier(.cmd)
        surface.tapModifier(.cmd)
        #expect(surface.state(of: .cmd) == .locked)

        _ = surface.textField(surface, shouldChangeCharactersIn: NSRange(), replacementString: "s")
        _ = surface.textField(surface, shouldChangeCharactersIn: NSRange(), replacementString: "s")
        #expect(surface.state(of: .cmd) == .locked)

        #expect(recorder.events.count == 2)
        #expect(recorder.events[0] == .key(code: "ansi-S", modifiers: [.cmd]))
        #expect(recorder.events[1] == .key(code: "ansi-S", modifiers: [.cmd]))
    }

    @Test func tripleTapModifierClearsLock() {
        let surface = KeyboardSurface()

        surface.tapModifier(.cmd)
        surface.tapModifier(.cmd)
        surface.tapModifier(.cmd)

        #expect(surface.state(of: .cmd) == .off)
    }

    @Test func armedCmdComposedWithShiftFromUppercaseLetter() {
        // User taps Cmd in the accessory row, then types Shift+S on the
        // iOS soft keyboard. The wire event should carry both Cmd and
        // Shift; armed Cmd clears, no Shift state persists (Shift came
        // from the character, not from a sticky-tap).
        let surface = KeyboardSurface()
        let recorder = Recorder()
        surface.keyboardDelegate = recorder

        surface.tapModifier(.cmd)
        _ = surface.textField(surface, shouldChangeCharactersIn: NSRange(), replacementString: "S")

        #expect(recorder.events.count == 1)
        #expect(recorder.events[0] == .key(code: "ansi-S", modifiers: [.cmd, .shift]))
        #expect(surface.state(of: .cmd) == .off)
        #expect(surface.state(of: .shift) == .off)
    }

    @Test func multipleArmedModifiersComposeAndClearTogether() {
        let surface = KeyboardSurface()
        let recorder = Recorder()
        surface.keyboardDelegate = recorder

        surface.tapModifier(.cmd)
        surface.tapModifier(.option)
        _ = surface.textField(surface, shouldChangeCharactersIn: NSRange(), replacementString: "a")

        #expect(recorder.events.count == 1)
        #expect(recorder.events[0] == .key(code: "ansi-A", modifiers: [.cmd, .option]))
        #expect(surface.state(of: .cmd) == .off)
        #expect(surface.state(of: .option) == .off)
    }

    @Test func lockedAndArmedModifiersCoexistThenArmedClears() {
        let surface = KeyboardSurface()
        let recorder = Recorder()
        surface.keyboardDelegate = recorder

        surface.tapModifier(.cmd)
        surface.tapModifier(.cmd)   // locked
        surface.tapModifier(.shift) // armed
        _ = surface.textField(surface, shouldChangeCharactersIn: NSRange(), replacementString: "a")
        _ = surface.textField(surface, shouldChangeCharactersIn: NSRange(), replacementString: "a")

        #expect(recorder.events.count == 2)
        #expect(recorder.events[0] == .key(code: "ansi-A", modifiers: [.cmd, .shift]))
        #expect(recorder.events[1] == .key(code: "ansi-A", modifiers: [.cmd]))
        #expect(surface.state(of: .cmd) == .locked)
        #expect(surface.state(of: .shift) == .off)
    }

    @Test func multiCharacterInsertEmitsOneEventPerCharacter() {
        let surface = KeyboardSurface()
        let recorder = Recorder()
        surface.keyboardDelegate = recorder

        _ = surface.textField(surface, shouldChangeCharactersIn: NSRange(), replacementString: "abc")

        #expect(recorder.events.count == 3)
        #expect(recorder.events[0] == .key(code: "ansi-A", modifiers: []))
        #expect(recorder.events[1] == .key(code: "ansi-B", modifiers: []))
        #expect(recorder.events[2] == .key(code: "ansi-C", modifiers: []))
    }

    @Test func unmappedCharactersAreSilentlyDropped() {
        let surface = KeyboardSurface()
        let recorder = Recorder()
        surface.keyboardDelegate = recorder

        // Emoji and non-ASCII drop because neither side has a table
        // entry. Better silent than an unknown wire code that the host
        // would warn about.
        _ = surface.textField(surface, shouldChangeCharactersIn: NSRange(), replacementString: "\u{1F600}")

        #expect(recorder.events.isEmpty)
    }
}

@MainActor
private final class Recorder: KeyboardSurfaceDelegate {
    private(set) var events: [NormalizedInput] = []
    func keyboardSurface(_ surface: KeyboardSurface, didProduce input: NormalizedInput) {
        events.append(input)
    }
}
