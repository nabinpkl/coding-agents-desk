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
        #expect(KeyboardPresentationStateMachine.transition(
            from: .pendingTextFocus,
            intent: .toggle
        ).next == .shown)
    }

    @Test func stateMachineReportsUnchangedTransition() {
        let transition = KeyboardPresentationStateMachine.transition(
            from: .shown,
            intent: .show
        )
        #expect(transition.next == .shown)
        #expect(!transition.changed)
    }

    @Test func editableFocusPushAloneDoesNotShowKeyboard() {
        let push = HostTextInputFocusPush(
            editability: .editable,
            secure: false,
            source: .accessibility,
            role: "AXTextArea"
        )
        let transition = KeyboardPresentationStateMachine.transition(
            from: .hidden,
            intent: HostTextInputKeyboardPolicy.intent(for: push)
        )
        #expect(transition.next == .hidden)
    }

    @Test func nonEditableFocusPushLeavesVisibleKeyboardAlone() {
        let push = HostTextInputFocusPush(
            editability: .nonEditable,
            secure: false,
            source: .accessibility,
            role: "AXButton"
        )
        let transition = KeyboardPresentationStateMachine.transition(
            from: .shown,
            intent: HostTextInputKeyboardPolicy.intent(for: push)
        )
        #expect(transition.next == .shown)
    }

    @Test func iBeamClickWaitsForHostFocusResult() {
        #expect(KeyboardPresentationStateMachine.transition(
            from: .hidden,
            intent: HostTextInputKeyboardPolicy.intentForRemoteTap()
        ).next == .pendingTextFocus)
    }

    @Test func pendingTextFocusShowsWhenAccessibilityConfirmsEditable() {
        #expect(KeyboardPresentationStateMachine.transition(
            from: .pendingTextFocus,
            intent: .hostFocus(editability: .editable, cursorKind: nil)
        ).next == .shown)
    }

    @Test func pendingTextFocusShowsForAmbiguousIBeamResult() {
        #expect(KeyboardPresentationStateMachine.transition(
            from: .pendingTextFocus,
            intent: .hostFocus(editability: .ambiguous, cursorKind: .ibeam)
        ).next == .shown)
    }

    @Test func pendingTextFocusHidesWhenAccessibilityReportsNonEditable() {
        #expect(KeyboardPresentationStateMachine.transition(
            from: .pendingTextFocus,
            intent: .hostFocus(editability: .nonEditable, cursorKind: .ibeam)
        ).next == .hidden)
    }

    @Test func pendingTextFocusHidesWhenAmbiguousResultIsNotIBeam() {
        #expect(KeyboardPresentationStateMachine.transition(
            from: .pendingTextFocus,
            intent: .hostFocus(editability: .ambiguous, cursorKind: .arrow)
        ).next == .hidden)
    }

    @Test func pendingTextFocusTimeoutReturnsHidden() {
        #expect(KeyboardPresentationStateMachine.transition(
            from: .pendingTextFocus,
            intent: .timeoutPendingTextFocus
        ).next == .hidden)
    }

    @Test func arrowTapArmsPendingUntilHostRejects() {
        #expect(KeyboardPresentationStateMachine.transition(
            from: .hidden,
            intent: HostTextInputKeyboardPolicy.intentForRemoteTap()
        ).next == .pendingTextFocus)
    }

    @Test func presentedKeyboardTapHidesEvenWhenCursorIsIBeam() {
        #expect(KeyboardPresentationStateMachine.transition(
            from: .shown,
            intent: HostTextInputKeyboardPolicy.intentForRemoteTap()
        ).next == .hidden)
    }

    @Test func hiddenNonIBeamTapArmsPendingUntilHostRejects() {
        #expect(KeyboardPresentationStateMachine.transition(
            from: .hidden,
            intent: HostTextInputKeyboardPolicy.intentForRemoteTap()
        ).next == .pendingTextFocus)
    }

    @Test func hostPostClickArrowResultReturnsPendingToHidden() {
        #expect(KeyboardPresentationStateMachine.transition(
            from: .pendingTextFocus,
            intent: .hostFocus(editability: .nonEditable, cursorKind: .arrow)
        ).next == .hidden)
    }

    @Test func shownKeyboardClickHidesAndLaterFocusDoesNotReopen() {
        let hidden = KeyboardPresentationStateMachine.transition(
            from: .shown,
            intent: HostTextInputKeyboardPolicy.intentForRemoteTap()
        )
        #expect(hidden.next == .hidden)
        #expect(KeyboardPresentationStateMachine.transition(
            from: hidden.next,
            intent: .hostFocus(editability: .editable, cursorKind: .ibeam)
        ).next == .hidden)
    }

    @Test func leftClickInputUsesRemoteTapPolicy() {
        let intent = HostTextInputKeyboardPolicy.intentForRemoteInput(
            .click(button: .left)
        )
        #expect(intent == .remoteTap)
    }

    @Test func nonLeftClickInputDoesNotAffectKeyboardPolicy() {
        #expect(HostTextInputKeyboardPolicy.intentForRemoteInput(
            .click(button: .right)
        ) == nil)
        #expect(HostTextInputKeyboardPolicy.intentForRemoteInput(
            .cursorMove(dx: 1, dy: 2)
        ) == nil)
    }
}
