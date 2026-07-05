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
        let lastFocus = HostTextInputFocusPush(
            editable: false,
            secure: false,
            source: .none
        )
        #expect(HostTextInputKeyboardPolicy.decisionAfterRemoteTap(
            lastCursorKind: .ibeam
        ) == .show)
    }

    @Test func arrowTapHidesKeyboard() {
        #expect(HostTextInputKeyboardPolicy.decisionAfterRemoteTap(
            lastCursorKind: .arrow
        ) == .hide)
    }

    @Test func iBeamTapShowsWhenAccessibilityAlreadyConfirmedEditable() {
        let lastFocus = HostTextInputFocusPush(
            editable: true,
            secure: false,
            source: .accessibility,
            role: "AXTextField"
        )
        #expect(HostTextInputKeyboardPolicy.decisionAfterRemoteTap(
            lastCursorKind: .ibeam
        ) == .show)
    }

    @Test func nonIBeamTapHidesEvenIfPreviousFocusWasEditable() {
        #expect(HostTextInputKeyboardPolicy.decisionAfterRemoteTap(
            lastCursorKind: .pointingHand
        ) == .hide)
    }
}
