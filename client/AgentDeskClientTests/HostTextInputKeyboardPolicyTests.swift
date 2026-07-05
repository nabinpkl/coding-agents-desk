import Testing
import AgentDeskWire

@testable import AgentDeskClient

struct HostTextInputKeyboardPolicyTests {
    @Test func editableFocusPushShowsKeyboard() {
        let push = HostTextInputFocusPush(
            editable: true,
            secure: false,
            source: .accessibility,
            role: "AXTextArea"
        )
        #expect(HostTextInputKeyboardPolicy.decision(for: push) == .show)
    }

    @Test func nonEditableFocusPushLeavesVisibleKeyboardAlone() {
        let push = HostTextInputFocusPush(
            editable: false,
            secure: false,
            source: .accessibility,
            role: "AXGroup"
        )
        #expect(HostTextInputKeyboardPolicy.decision(for: push) == .leaveUnchanged)
    }

    @Test func iBeamTapShowsKeyboardWhenAccessibilityDoesNotConfirmEditable() {
        #expect(HostTextInputKeyboardPolicy.decisionAfterRemoteTap(
            lastCursorKind: .ibeam,
            keyboardPresented: false
        ) == .show)
    }

    @Test func arrowTapHidesKeyboard() {
        #expect(HostTextInputKeyboardPolicy.decisionAfterRemoteTap(
            lastCursorKind: .arrow,
            keyboardPresented: false
        ) == .hide)
    }

    @Test func iBeamTapShowsWhenAccessibilityAlreadyConfirmedEditable() {
        #expect(HostTextInputKeyboardPolicy.decisionAfterRemoteTap(
            lastCursorKind: .ibeam,
            keyboardPresented: false
        ) == .show)
    }

    @Test func presentedKeyboardTapHidesEvenWhenCursorIsIBeam() {
        #expect(HostTextInputKeyboardPolicy.decisionAfterRemoteTap(
            lastCursorKind: .ibeam,
            keyboardPresented: true
        ) == .hide)
    }

    @Test func nonIBeamTapHidesEvenIfPreviousFocusWasEditable() {
        #expect(HostTextInputKeyboardPolicy.decisionAfterRemoteTap(
            lastCursorKind: .pointingHand,
            keyboardPresented: false
        ) == .hide)
    }
}
