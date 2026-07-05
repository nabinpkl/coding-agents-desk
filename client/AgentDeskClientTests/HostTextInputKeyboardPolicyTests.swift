import Testing
import AgentDeskWire

@testable import AgentDeskClient

struct HostTextInputKeyboardPolicyTests {
    @Test func stateMachineShowHideAndToggleTransitions() {
        #expect(KeyboardPresentationStateMachine.transition(
            from: .hidden,
            intent: .show
        ).next == .shown)
        #expect(KeyboardPresentationStateMachine.transition(
            from: .shown,
            intent: .hide
        ).next == .hidden)
        #expect(KeyboardPresentationStateMachine.transition(
            from: .hidden,
            intent: .toggle
        ).next == .shown)
        #expect(KeyboardPresentationStateMachine.transition(
            from: .shown,
            intent: .toggle
        ).next == .hidden)
    }

    @Test func stateMachineReportsUnchangedTransition() {
        let transition = KeyboardPresentationStateMachine.transition(
            from: .shown,
            intent: .show
        )
        #expect(transition.next == .shown)
        #expect(!transition.changed)
    }

    @Test func editableFocusPushShowsKeyboard() {
        let push = HostTextInputFocusPush(
            editable: true,
            secure: false,
            source: .accessibility,
            role: "AXTextArea"
        )
        #expect(HostTextInputKeyboardPolicy.intent(for: push) == .show)
    }

    @Test func nonEditableFocusPushLeavesVisibleKeyboardAlone() {
        let push = HostTextInputFocusPush(
            editable: false,
            secure: false,
            source: .accessibility,
            role: "AXGroup"
        )
        #expect(HostTextInputKeyboardPolicy.intent(for: push) == nil)
    }

    @Test func iBeamTapShowsKeyboardWhenAccessibilityDoesNotConfirmEditable() {
        #expect(HostTextInputKeyboardPolicy.intentAfterRemoteTap(
            lastCursorKind: .ibeam,
            keyboardState: .hidden
        ) == .show)
    }

    @Test func arrowTapLeavesHiddenKeyboardAlone() {
        #expect(HostTextInputKeyboardPolicy.intentAfterRemoteTap(
            lastCursorKind: .arrow,
            keyboardState: .hidden
        ) == nil)
    }

    @Test func iBeamTapShowsWhenAccessibilityAlreadyConfirmedEditable() {
        #expect(HostTextInputKeyboardPolicy.intentAfterRemoteTap(
            lastCursorKind: .ibeam,
            keyboardState: .hidden
        ) == .show)
    }

    @Test func presentedKeyboardTapHidesEvenWhenCursorIsIBeam() {
        #expect(HostTextInputKeyboardPolicy.intentAfterRemoteTap(
            lastCursorKind: .ibeam,
            keyboardState: .shown
        ) == .hide)
    }

    @Test func hiddenNonIBeamTapLeavesKeyboardAlone() {
        #expect(HostTextInputKeyboardPolicy.intentAfterRemoteTap(
            lastCursorKind: .pointingHand,
            keyboardState: .hidden
        ) == nil)
    }
}
