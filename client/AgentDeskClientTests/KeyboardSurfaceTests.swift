import Foundation
import Testing
import UIKit

@MainActor
struct KeyboardSurfaceTests {
    @Test func unmodifiedLowercaseLetterEmitsAnsiCodeWithNoModifiers() {
        let surface = KeyboardSurface()
        let recorder = Recorder()
        surface.delegate = recorder

        surface.insertText("s")

        #expect(recorder.events.count == 1)
        #expect(recorder.events[0] == .key(code: "ansi-S", modifiers: []))
    }

    @Test func uppercaseLetterEmitsAnsiCodeWithShift() {
        let surface = KeyboardSurface()
        let recorder = Recorder()
        surface.delegate = recorder

        surface.insertText("S")

        #expect(recorder.events.count == 1)
        #expect(recorder.events[0] == .key(code: "ansi-S", modifiers: [.shift]))
    }

    @Test func shiftedDigitRowPunctuationEmitsDigitCodeWithShift() {
        let surface = KeyboardSurface()
        let recorder = Recorder()
        surface.delegate = recorder

        surface.insertText("!")

        #expect(recorder.events.count == 1)
        #expect(recorder.events[0] == .key(code: "ansi-1", modifiers: [.shift]))
    }

    @Test func unshiftedPunctuationEmitsAnsiCodeWithNoModifiers() {
        let surface = KeyboardSurface()
        let recorder = Recorder()
        surface.delegate = recorder

        surface.insertText(",")

        #expect(recorder.events.count == 1)
        #expect(recorder.events[0] == .key(code: "ansi-comma", modifiers: []))
    }

    @Test func returnKeyEmitsReturnCode() {
        let surface = KeyboardSurface()
        let recorder = Recorder()
        surface.delegate = recorder

        surface.insertText("\n")

        #expect(recorder.events.count == 1)
        #expect(recorder.events[0] == .key(code: "return", modifiers: []))
    }

    @Test func deleteBackwardEmitsDeleteCode() {
        let surface = KeyboardSurface()
        let recorder = Recorder()
        surface.delegate = recorder

        surface.deleteBackward()

        #expect(recorder.events.count == 1)
        #expect(recorder.events[0] == .key(code: "delete", modifiers: []))
    }

    @Test func singleTapModifierArmsForNextKeyThenClears() {
        let surface = KeyboardSurface()
        let recorder = Recorder()
        surface.delegate = recorder

        surface.tapModifier(.cmd)
        #expect(surface.state(of: .cmd) == .armed)

        surface.insertText("s")
        #expect(surface.state(of: .cmd) == .off)
        surface.insertText("s")

        #expect(recorder.events.count == 2)
        #expect(recorder.events[0] == .key(code: "ansi-S", modifiers: [.cmd]))
        #expect(recorder.events[1] == .key(code: "ansi-S", modifiers: []))
    }

    @Test func doubleTapModifierLocksAcrossMultipleKeys() {
        let surface = KeyboardSurface()
        let recorder = Recorder()
        surface.delegate = recorder

        surface.tapModifier(.cmd)
        surface.tapModifier(.cmd)
        #expect(surface.state(of: .cmd) == .locked)

        surface.insertText("s")
        surface.insertText("s")
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
        surface.delegate = recorder

        surface.tapModifier(.cmd)
        surface.insertText("S")

        #expect(recorder.events.count == 1)
        #expect(recorder.events[0] == .key(code: "ansi-S", modifiers: [.cmd, .shift]))
        #expect(surface.state(of: .cmd) == .off)
        #expect(surface.state(of: .shift) == .off)
    }

    @Test func multipleArmedModifiersComposeAndClearTogether() {
        let surface = KeyboardSurface()
        let recorder = Recorder()
        surface.delegate = recorder

        surface.tapModifier(.cmd)
        surface.tapModifier(.option)
        surface.insertText("a")

        #expect(recorder.events.count == 1)
        #expect(recorder.events[0] == .key(code: "ansi-A", modifiers: [.cmd, .option]))
        #expect(surface.state(of: .cmd) == .off)
        #expect(surface.state(of: .option) == .off)
    }

    @Test func lockedAndArmedModifiersCoexistThenArmedClears() {
        let surface = KeyboardSurface()
        let recorder = Recorder()
        surface.delegate = recorder

        surface.tapModifier(.cmd)
        surface.tapModifier(.cmd)   // locked
        surface.tapModifier(.shift) // armed
        surface.insertText("a")
        surface.insertText("a")

        #expect(recorder.events.count == 2)
        #expect(recorder.events[0] == .key(code: "ansi-A", modifiers: [.cmd, .shift]))
        #expect(recorder.events[1] == .key(code: "ansi-A", modifiers: [.cmd]))
        #expect(surface.state(of: .cmd) == .locked)
        #expect(surface.state(of: .shift) == .off)
    }

    @Test func multiCharacterInsertEmitsOneEventPerCharacter() {
        let surface = KeyboardSurface()
        let recorder = Recorder()
        surface.delegate = recorder

        surface.insertText("abc")

        #expect(recorder.events.count == 3)
        #expect(recorder.events[0] == .key(code: "ansi-A", modifiers: []))
        #expect(recorder.events[1] == .key(code: "ansi-B", modifiers: []))
        #expect(recorder.events[2] == .key(code: "ansi-C", modifiers: []))
    }

    @Test func unmappedCharactersAreSilentlyDropped() {
        let surface = KeyboardSurface()
        let recorder = Recorder()
        surface.delegate = recorder

        // Emoji and non-ASCII drop because neither side has a table
        // entry. Better silent than an unknown wire code that the host
        // would warn about.
        surface.insertText("\u{1F600}")

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
