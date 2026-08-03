import Foundation
import Testing
import UIKit
import AgentDeskWire

@MainActor
struct KeyboardSurfaceTests {
    @Test
    func terminalProxyRoutesTextWithoutAccumulatingInvisibleEcho() {
        let surface = KeyboardSurface(
            echoesLocally: false,
            showsDismissKey: true
        )
        let recorder = Recorder()
        surface.keyboardDelegate = recorder

        let accepted = surface.textField(
            surface,
            shouldChangeCharactersIn: NSRange(),
            replacementString: "ls"
        )

        #expect(!accepted)
        #expect(surface.text?.isEmpty != false)
        #expect(recorder.events == [
            .key(code: "ansi-L", modifiers: []),
            .key(code: "ansi-S", modifiers: []),
        ])
    }

    @Test
    func extensionTranscriptUsesTheOrdinaryMacInputPathExactlyOnce() {
        let surface = KeyboardSurface()
        let recorder = Recorder()
        surface.keyboardDelegate = recorder

        _ = surface.textField(
            surface,
            shouldChangeCharactersIn: NSRange(),
            replacementString: "Go!"
        )

        #expect(recorder.events == [
            .key(code: "ansi-G", modifiers: [.shift]),
            .key(code: "ansi-O", modifiers: []),
            .key(code: "ansi-1", modifiers: [.shift]),
        ])
    }

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

    @Test func shiftAccessoryArmsNextArrowThenClears() throws {
        let surface = KeyboardSurface()
        let recorder = Recorder()
        surface.keyboardDelegate = recorder
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let controller = UIViewController()
        controller.view.addSubview(surface)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        #expect(surface.becomeFirstResponder())
        let accessory = try #require(surface.inputAccessoryView as? KeyboardAccessoryView)
        let shift = try #require(
            button(withAccessibilityIdentifier: "keyboard-modifier-shift", in: accessory)
        )

        shift.sendActions(for: .touchUpInside)
        #expect(surface.state(of: .shift) == .armed)
        #expect(shift.accessibilityLabel == "Shift")
        #expect(shift.accessibilityValue == "Armed")

        surface.sendKey(code: "left")

        #expect(recorder.events == [.key(code: "left", modifiers: [.shift])])
        #expect(surface.state(of: .shift) == .off)
        #expect(shift.accessibilityValue == "Off")
    }

    @Test func arrowClusterUsesTwoKeyWidthsWithLargerGlyphsAndGaps() throws {
        let surface = KeyboardSurface()
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let controller = UIViewController()
        controller.view.addSubview(surface)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        #expect(surface.becomeFirstResponder())
        let accessory = try #require(surface.inputAccessoryView as? KeyboardAccessoryView)
        accessory.frame.size.width = 390
        accessory.layoutIfNeeded()

        let escape = try #require(button(withTitle: "Esc", in: accessory))
        let arrows = try ["\u{2191}", "\u{2190}", "\u{2193}", "\u{2192}"].map {
            try #require(button(withTitle: $0, in: accessory))
        }
        let cluster = try #require(
            stackViews(in: accessory).first { stack in
                stack.axis == .vertical
                    && arrows.allSatisfy { $0.isDescendant(of: stack) }
            }
        )
        let arrowRows = stackViews(in: cluster).filter { $0.axis == .horizontal }

        #expect(cluster.bounds.width >= escape.bounds.width * 1.9)
        #expect(arrows.allSatisfy {
            ($0.titleLabel?.font.pointSize ?? 0) > (escape.titleLabel?.font.pointSize ?? 0)
        })
        #expect(cluster.spacing >= 4)
        #expect(arrowRows.count == 2)
        #expect(arrowRows.allSatisfy { $0.spacing >= 4 })
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

    @Test func reviewedDictationTextUsesTheSameRemoteKeyEvents() throws {
        let events = try KeyboardTextInput.events(for: "Hi, you!\n")

        #expect(events == [
            .key(code: "ansi-H", modifiers: [.shift]),
            .key(code: "ansi-I", modifiers: []),
            .key(code: "ansi-comma", modifiers: []),
            .key(code: "space", modifiers: []),
            .key(code: "ansi-Y", modifiers: []),
            .key(code: "ansi-O", modifiers: []),
            .key(code: "ansi-U", modifiers: []),
            .key(code: "ansi-1", modifiers: [.shift]),
            .key(code: "return", modifiers: [])
        ])
    }

    @Test func reviewedDictationRejectsInsteadOfPartiallySendingUnsupportedText() {
        #expect(throws: KeyboardTextInput.EncodingError.self) {
            _ = try KeyboardTextInput.events(for: "hello \u{1F600}")
        }
    }

    private func button(
        withAccessibilityIdentifier identifier: String,
        in view: UIView
    ) -> UIButton? {
        if let button = view as? UIButton,
           button.accessibilityIdentifier == identifier {
            return button
        }
        return view.subviews.lazy.compactMap {
            button(withAccessibilityIdentifier: identifier, in: $0)
        }.first
    }

    private func button(withTitle title: String, in view: UIView) -> UIButton? {
        if let button = view as? UIButton,
           button.currentTitle == title {
            return button
        }
        return view.subviews.lazy.compactMap {
            button(withTitle: title, in: $0)
        }.first
    }

    private func stackViews(in view: UIView) -> [UIStackView] {
        let current = (view as? UIStackView).map { [$0] } ?? []
        return current + view.subviews.flatMap(stackViews(in:))
    }
}

@MainActor
private final class Recorder: KeyboardSurfaceDelegate {
    private(set) var events: [NormalizedInput] = []
    func keyboardSurface(_ surface: KeyboardSurface, didProduce input: NormalizedInput) {
        events.append(input)
    }
}
